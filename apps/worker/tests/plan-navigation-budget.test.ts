import { expect, it, vi } from "vitest";
import { DevflowError } from "@devflow/shared";
import { FakeLanguageModel } from "@devflow/agent";
import type { SandboxSession } from "@devflow/sandbox";
import { hash } from "../src/localization/contracts.js";
import { PlanAgent } from "../src/runs/plan-agent.js";
import { ReplanEvidenceReader } from "../src/runs/replan-evidence.js";
import { replanSource } from "../src/runs/replan-source.js";

function fixture() {
  const files: Record<string, string> = {
    "src/consumer.ts": "export function resolveValue() { return cachedValue; }\n",
    "package.json": '{"name":"fixture"}',
  };
  const signal = new AbortController();
  const beforeRead = vi.fn(async () => {});
  const readFile = vi.fn(async ({ path }: { path: string }) => ({
    content: files[path]!,
    fileSha256: hash(files[path]!),
    truncated: false,
  }));
  const sandbox = { readFile } as unknown as SandboxSession;
  const reader = new ReplanEvidenceReader(sandbox, signal.signal, beforeRead, {
    reads: 0,
    sourceBytes: 0,
    cacheHits: 0,
    readLimit: 1,
  });
  const source = replanSource({
    sandbox,
    reader,
    entries: Object.entries(files).map(([path, content]) => ({
      path,
      kind: "FILE" as const,
      sizeBytes: Buffer.byteLength(content),
      contentHash: hash(content),
    })),
    complete: true,
    revision: "1",
    beforeMetadata: async () => {
      throw Error("Unexpected metadata IO");
    },
  });
  return {
    reader,
    readFile,
    beforeRead,
    signal,
    input: {
      title: "Investigate stale resolved value",
      description: "Public failure persists. Candidate is a hypothesis, not a proven cause.",
      repositoryId: "fixture",
      baseCommitSha: "a".repeat(40),
      workspaceRevision: 1,
      source,
      signal: signal.signal,
      supplementaryReads: [
        { path: "src/consumer.ts", startLine: 1, endLine: 1, reason: "Verified candidate" },
      ],
      discoveryCandidates: [
        { path: "src/consumer.ts", intent: "EDIT" as const, reason: "Investigate" },
      ],
      limits: { maxTotalTokens: 60000 },
    },
  };
}

it("stops optional graph reads while retaining verified candidate evidence and the exact allowance", async () => {
  const f = fixture();
  const result = await new PlanAgent().prepare(f.input);
  expect(result.status).toBe("READY");
  expect(
    result.attempt.diagnostics.some((d) => d.code === "PLAN_OPTIONAL_NAVIGATION_EXHAUSTED"),
  ).toBe(true);
  expect(JSON.stringify(result.preparedFinalRequest?.messages)).toContain("return cachedValue");
  expect(JSON.stringify(result.preparedFinalRequest?.messages)).toContain("unknown, not absent");
  expect(f.reader.state.reads).toBe(1);
  expect(f.readFile).toHaveBeenCalledTimes(1);
  await expect(f.reader.read("package.json")).rejects.toThrow(
    "REPLAN_SOURCE_READ_RESERVE_EXHAUSTED",
  );
  expect(f.readFile).toHaveBeenCalledTimes(1);
});

it("does not bypass a mandatory read or manufacture evidence after restored allowance exhaustion", async () => {
  const f = fixture();
  f.reader.state.reads = 1;
  const result = await new PlanAgent().prepare(f.input);
  expect(result.status).toBe("BLOCKED");
  expect(result.preparedFinalRequest).toBeUndefined();
  expect(f.readFile).not.toHaveBeenCalled();
});

it.each(["global-budget", "cancelled", "identity"])(
  "keeps %s navigation failure blocking despite valid candidate evidence",
  async (mode) => {
    const f = fixture();
    f.reader.state.readLimit = 2;
    if (mode === "identity") {
      f.readFile.mockImplementation(async ({ path }) => ({
        content:
          path === "package.json"
            ? "unverified"
            : "export function resolveValue() { return cachedValue; }\n",
        fileSha256:
          path === "package.json"
            ? "f".repeat(64)
            : hash("export function resolveValue() { return cachedValue; }\n"),
        truncated: false,
      }));
    } else {
      f.beforeRead.mockImplementation(async () => {
        if (f.reader.state.reads < 2) return;
        if (mode === "cancelled") {
          f.signal.abort();
          f.signal.signal.throwIfAborted();
        }
        throw new DevflowError({
          code: "EXECUTION_BUDGET_EXCEEDED",
          message: "Global downstream reserve",
        });
      });
    }
    const result = await new PlanAgent().prepare(f.input);
    expect(result.status).toBe("BLOCKED");
    expect(result.preparedFinalRequest).toBeUndefined();
    expect(
      result.attempt.diagnostics.some((d) => d.code === "PLAN_OPTIONAL_NAVIGATION_EXHAUSTED"),
    ).toBe(false);
  },
);

it("still preflights the final model request after optional reads stop", async () => {
  const f = fixture();
  const model = new FakeLanguageModel([]);
  const result = await new PlanAgent().run({ ...f.input, model, limits: { maxTotalTokens: 100 } });
  expect(result.status).toBe("BLOCKED");
  expect(model.requests).toHaveLength(0);
});
