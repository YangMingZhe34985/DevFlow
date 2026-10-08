import { describe, expect, it } from "vitest";
import { contentHash, type WorkingCode } from "@devflow/agent";
import { failureInvestigationFor } from "../src/runs/repair-tasks.js";
import { resolveRepairDiagnostics } from "../src/runs/repair-diagnostics.js";

const paths = ["src/approved.ts", "src/consumer.ts", "tests/behavior.test.ts"];
const source = (path: string, code: string): WorkingCode => ({
  path,
  code,
  contentHash: contentHash(code),
  complete: true,
  startLine: 1,
  endLine: code.split("\n").length,
  workspaceRevision: 1,
  role: path.startsWith("tests/") ? "TEST" : "INTERFACE",
});
const testSource = source(
  "tests/behavior.test.ts",
  'import { consume } from "../src/consumer.js";\nconsume();\n',
);
function input(output = "tests/behavior.test.ts:2: AssertionError: expected skipped event") {
  return {
    consecutiveFailures: 2,
    test: { exitCode: 1, timedOut: false, outputTruncated: false },
    failureFingerprint: "stable-public-failure",
    approvedPaths: ["src/approved.ts"],
    repositoryPaths: paths,
    resolution: resolveRepairDiagnostics(output, paths, true),
    currentSources: [testSource],
    signal: new AbortController().signal,
  };
}

describe("host-confirmed failure-driven read-only investigation", () => {
  it("uses the observed failing test's resolved runtime import, without claiming causality or write authority", async () => {
    const grant = await failureInvestigationFor(input());
    expect(grant).toMatchObject({
      roots: ["src/consumer.ts", "tests/behavior.test.ts"],
      candidates: ["src/consumer.ts"],
      evidence: [
        {
          path: testSource.path,
          fileSha256: testSource.contentHash,
          origin: "OBSERVED_TEST_IMPORT",
        },
      ],
    });
    expect(grant).not.toHaveProperty("approvedPaths");
    expect((await failureInvestigationFor(input()))?.id).toBe(grant?.id);
  });

  it("prefers a verified direct source location over import hypotheses", async () => {
    const observation = input("src/consumer.ts:1: Error: skipped event missing");
    observation.currentSources.push(source("src/consumer.ts", "export const consume = () => 0;\n"));
    expect(await failureInvestigationFor(observation)).toMatchObject({
      roots: ["src/consumer.ts"],
      evidence: [{ origin: "PUBLIC_DIAGNOSTIC" }],
    });
  });

  it.each([
    { consecutiveFailures: 1 },
    { test: { exitCode: 0, timedOut: false, outputTruncated: false } },
    { test: { exitCode: null, timedOut: false, outputTruncated: false } },
    { test: { exitCode: 1, timedOut: true, outputTruncated: false } },
    { test: { exitCode: 1, timedOut: false, outputTruncated: true } },
  ])("does not invent a complete consecutive behavioral failure: %j", async (change) => {
    expect(await failureInvestigationFor({ ...input(), ...change })).toBeUndefined();
  });

  it("does not navigate unrelated tests or an unlocated environment error", async () => {
    expect(await failureInvestigationFor(input("dependency setup failed"))).toBeUndefined();
    expect(
      await failureInvestigationFor(input("src/approved.ts:1: Error: observed")),
    ).toBeUndefined();
  });

  it("rejects forged complete source and missing observations", async () => {
    const forged = input();
    forged.currentSources = [{ ...testSource, contentHash: "a".repeat(64) }];
    expect(await failureInvestigationFor(forged)).toBeUndefined();
    expect(await failureInvestigationFor({ ...input(), currentSources: [] })).toBeUndefined();
  });

  it("permits only the failing test navigation when imports are ambiguous, type-only or already approved", async () => {
    for (const code of [
      'import { consume } from "@runtime/consumer";',
      'import type { Consume } from "../src/consumer.js";',
      'import { consume } from "../src/approved.js";',
    ])
      expect(
        await failureInvestigationFor({
          ...input(),
          currentSources: [source(testSource.path, code)],
        }),
      ).toMatchObject({
        roots: [testSource.path],
        candidates: [],
        evidence: [{ origin: "PUBLIC_TEST_LOCATION" }],
      });
  });

  it("can read the observed failing test header when the diagnostic seed starts below imports", async () => {
    expect(
      await failureInvestigationFor({
        ...input(),
        currentSources: [
          {
            ...testSource,
            startLine: 40,
            endLine: 42,
            code: "expect(events).toContain('skipped');",
            complete: false,
          },
        ],
      }),
    ).toMatchObject({ roots: [testSource.path], candidates: [] });
  });

  it("rejects repository-external candidate identities", async () => {
    for (const path of ["../outside.ts", "/outside.ts", "C:/outside.ts"])
      expect(
        await failureInvestigationFor({
          ...input(),
          currentSources: [source(path, "export const x = 1;")],
          resolution: {
            resolved: [
              { path, rawPath: path, line: 1, diagnostic: "failure", resolution: "EXACT" },
            ],
            unresolved: [],
            manifestComplete: true,
          },
        }),
      ).toBeUndefined();
  });
});
