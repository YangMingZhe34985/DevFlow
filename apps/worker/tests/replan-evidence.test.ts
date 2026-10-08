import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@devflow/eval";
import type { SandboxSession } from "@devflow/sandbox";
import { resolveRepairDiagnostics } from "../src/runs/repair-diagnostics.js";
import {
  ReplanEvidenceReader,
  verifyReplanEvidence,
  replanEvidencePlan,
} from "../src/runs/replan-evidence.js";
function fixture() {
  const sources = {
    "tests/test.cpp": "test() {\n search();\n assert(result);\n}\n",
    "src/search.cpp": "if (diagnostic) filterExisting(result);\n",
  };
  const readFile = vi.fn(async ({ path }) => ({
    path,
    content: sources[path],
    fileSha256: sha256(sources[path]),
    truncated: false,
  }));
  const reader = new ReplanEvidenceReader(
    { readFile } as unknown as SandboxSession,
    new AbortController().signal,
    async () => {},
  );
  const failure = {
    exitCode: 1,
    stdout: "tests/test.cpp:3: Failure",
    stderr: "",
    timedOut: false,
    outputTruncated: false,
    durationMs: 1,
  };
  const completion = {
    outcome: "SCOPE_CONFLICT" as const,
    evidence: Object.entries(sources).map(([path, quote]) => ({
      path,
      quote,
      fileSha256: sha256(quote),
    })),
  };
  return {
    sources,
    readFile,
    reader,
    input: {
      requested: ["src/search.cpp"],
      oldPaths: [],
      failure,
      completion,
      reader,
      allowed: () => true,
      resolution: resolveRepairDiagnostics(failure.stdout, Object.keys(sources)),
    },
  };
}
describe("read-only scope candidate qualification", () => {
  it("does not let a cached oversized or forged full file bypass the source-read contract", async () => {
    const f = fixture();
    const large = "x".repeat(512 * 1024 + 1);
    f.reader.files.set("src/large.cpp", {
      path: "src/large.cpp",
      content: large,
      contentHash: sha256(large),
      sizeBytes: large.length,
    });
    await expect(f.reader.read("src/large.cpp")).rejects.toThrow(
      "REPLAN_SOURCE_IDENTITY_UNVERIFIED",
    );
    f.reader.files.set("src/forged.cpp", {
      path: "src/forged.cpp",
      content: "different",
      contentHash: sha256("original"),
      sizeBytes: 9,
    });
    await expect(f.reader.read("src/forged.cpp")).rejects.toThrow(
      "REPLAN_SOURCE_IDENTITY_UNVERIFIED",
    );
    expect(f.readFile).not.toHaveBeenCalled();
    expect(f.reader.state.cacheHits).toBe(0);
  });
  it("bounds many failing tests with one auditable operation list, preserving candidate and Planner reads", async () => {
    const f = fixture();
    const sources: Record<string, string> = f.sources;
    for (let i = 0; i < 12; i++) sources[`tests/failure${i}.cpp`] = sources["tests/test.cpp"]!;
    f.input.failure.stdout = Object.keys(sources)
      .filter((p) => p.startsWith("tests/"))
      .map((p) => `${p}:3: Failure`)
      .join("\n");
    f.input.resolution = resolveRepairDiagnostics(f.input.failure.stdout, Object.keys(sources));
    const preparationPlan = replanEvidencePlan(f.input);
    expect(preparationPlan.testLocations).toHaveLength(2);
    expect(preparationPlan.omittedTestPaths).toHaveLength(6); // Resolver itself retains at most eight files.
    const result = await verifyReplanEvidence({ ...f.input, preparationPlan });
    expect(result.records).toHaveLength(1);
    expect(f.reader.state.reads).toBe(3);
    expect(f.readFile.mock.calls.map(([x]) => x.path).sort()).toEqual(
      [...preparationPlan.readPaths].sort(),
    );
    await f.reader.read("src/search.cpp");
    expect(f.reader.state.reads).toBe(3);
  });
  it("persists a smaller planned physical allowance and rejects extra IO without resetting the shared limit", async () => {
    const f = fixture();
    f.reader.state.readLimit = 1;
    await f.reader.read("src/search.cpp");
    await f.reader.read("src/search.cpp");
    await expect(f.reader.read("tests/test.cpp")).rejects.toThrow(
      "REPLAN_SOURCE_READ_RESERVE_EXHAUSTED",
    );
    expect(f.readFile).toHaveBeenCalledTimes(1);
  });
  it("admits implementation evidence linked to the failing test without claiming root-cause proof", async () => {
    const f = fixture(),
      r = await verifyReplanEvidence(f.input);
    expect(r.records[0]).toMatchObject({
      path: "src/search.cpp",
      basis: "TEST_EVIDENCE",
      relationship: "HYPOTHESIS_FOR_PLANNER",
    });
    await f.reader.read("src/search.cpp");
    expect(f.readFile).toHaveBeenCalledTimes(2);
  });
  it.each(["stale", "invented"])("rejects %s citation evidence", async (mode) => {
    const f = fixture();
    if (mode === "stale") f.input.completion.evidence[1]!.fileSha256 = "a".repeat(64);
    if (mode === "invented") f.input.completion.evidence[1]!.quote = "invented code";
    expect((await verifyReplanEvidence(f.input)).records).toEqual([]);
  });
  it("does not admit candidates based on existence or timeout alone", async () => {
    const f = fixture();
    f.input.completion.evidence = [];
    expect((await verifyReplanEvidence(f.input)).records).toEqual([]);
    f.input.failure.timedOut = true;
    expect((await verifyReplanEvidence(f.input)).rejected[0]?.reason).toBe(
      "PUBLIC_FAILURE_UNCONFIRMED",
    );
  });
  it("does not read protected targets", async () => {
    const f = fixture();
    f.input.allowed = () => false;
    expect((await verifyReplanEvidence(f.input)).records).toEqual([]);
    expect(f.readFile).not.toHaveBeenCalled();
  });
  it("requires the quoted test range to contain the actual diagnostic location", async () => {
    const f = fixture();
    f.input.completion.evidence[0]!.quote = "test() {";
    expect((await verifyReplanEvidence(f.input)).records).toEqual([]);
  });
  it("retains a valid citation to any failed location in a selected test file", async () => {
    const f = fixture();
    f.input.completion.evidence[0]!.quote = " search();";
    f.input.resolution.resolved.push({ ...f.input.resolution.resolved[0]!, line: 2 });
    f.input.resolution.resolved.push({ ...f.input.resolution.resolved[0]!, line: 4 });
    expect((await verifyReplanEvidence(f.input)).records).toHaveLength(1);
    expect(f.reader.state.reads).toBe(2);
  });
  it("assembles a missing implementation quote from current public-test symbol evidence", async () => {
    const f = fixture();
    f.sources["src/search.cpp"] =
      "Result SearchEngine::search() {\n return filterExisting(result);\n}\n";
    f.input.completion.evidence = f.input.completion.evidence.slice(0, 1);
    const result = await verifyReplanEvidence(f.input);
    expect(result.records[0]?.hostRegion).toMatchObject({ selection: "PUBLIC_SYMBOL_OVERLAP" });
    expect(result.records[0]?.currentSha256).toBe(sha256(f.sources["src/search.cpp"]));
    expect(result.records[0]?.relationship).toBe("HYPOTHESIS_FOR_PLANNER");
    expect(f.readFile).toHaveBeenCalledTimes(2);
  });
  it("does not invent a region for an unrelated candidate or replace a supplied false citation", async () => {
    const f = fixture();
    f.input.completion.evidence = f.input.completion.evidence.slice(0, 1);
    expect((await verifyReplanEvidence(f.input)).rejected[0]?.reason).toContain(
      "IMPLEMENTATION_REGION_MISSING",
    );
    f.input.completion.evidence.push({
      path: "src/search.cpp",
      quote: "search() { invented; }",
      fileSha256: sha256(f.sources["src/search.cpp"]),
    });
    expect((await verifyReplanEvidence(f.input)).rejected[0]?.reason).toBe("EVIDENCE_INVALID");
  });
  it("uses a claimed symbol only to select a real current declaration for independent planning", async () => {
    const f = fixture();
    f.sources["src/search.cpp"] = "export function decodeState(value) {\n return value.status;\n}";
    f.input.completion.evidence = [];
    const result = await verifyReplanEvidence({
      ...f.input,
      completion: {
        ...f.input.completion,
        summary: "Investigate decodeState; failure may arise during restoration",
      },
    });
    expect(result.records[0]).toMatchObject({
      relationship: "HYPOTHESIS_FOR_PLANNER",
      hostRegion: { selection: "MODEL_SYMBOL_HINT" },
    });
    expect(result.records[0]?.testEvidence?.[0]?.source).toBe("HOST_DIAGNOSTIC_READ");
    expect(
      (
        await verifyReplanEvidence({
          ...f.input,
          completion: { ...f.input.completion, summary: "Investigate inventedFunction" },
        })
      ).records,
    ).toEqual([]);
    f.input.failure.exitCode = 0;
    expect(
      (
        await verifyReplanEvidence({
          ...f.input,
          completion: { ...f.input.completion, summary: "decodeState" },
        })
      ).records,
    ).toEqual([]);
  });
  it("restored read consumption cannot renew the eight-read allowance", async () => {
    const f = fixture();
    const reader = new ReplanEvidenceReader(
      { readFile: f.readFile } as unknown as SandboxSession,
      new AbortController().signal,
      async () => {},
      { reads: 8, sourceBytes: 20, cacheHits: 0 },
    );
    await expect(reader.read("src/search.cpp")).rejects.toThrow(
      "REPLAN_SOURCE_READ_RESERVE_EXHAUSTED",
    );
    expect(f.readFile).not.toHaveBeenCalled();
  });
});

it("assembles absent failure-test evidence from current public diagnostic identity, within the shared reader", async () => {
  const f = fixture();
  f.input.completion.evidence = f.input.completion.evidence.slice(1);
  const result = await verifyReplanEvidence(f.input);
  expect(result.records[0]?.testEvidence?.[0]).toMatchObject({
    path: "tests/test.cpp",
    source: "HOST_DIAGNOSTIC_READ",
    fileSha256: sha256(f.sources["tests/test.cpp"]),
  });
  expect(result.records[0]?.relationship).toBe("HYPOTHESIS_FOR_PLANNER");
  expect(f.reader.state.reads).toBe(2);
  await verifyReplanEvidence(f.input);
  expect(f.reader.state.reads).toBe(2);
});
it("does not replace stale test quotes or accept an out-of-file public failure", async () => {
  const f = fixture();
  f.input.completion.evidence[0]!.fileSha256 = "f".repeat(64);
  expect((await verifyReplanEvidence(f.input)).rejected[0]?.reason).toBe("SOURCE_STALE");
  f.input.completion.evidence = f.input.completion.evidence.slice(1);
  f.input.resolution.resolved[0]!.line = 999;
  expect((await verifyReplanEvidence(f.input)).rejected[0]?.reason).toBe(
    "FAILED_TEST_LOCATION_INVALID",
  );
});
