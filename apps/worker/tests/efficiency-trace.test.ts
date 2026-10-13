import { expect, it, vi } from "vitest";
import { DevflowError } from "@devflow/shared";
import type { SandboxSession } from "@devflow/sandbox";
import { EfficiencyTrace, unionMs } from "../src/runs/efficiency-trace.js";

it("unions overlapping spans rather than adding concurrent latency", () => {
  expect(
    unionMs([
      { startedAt: 0, wallMs: 10 },
      { startedAt: 5, wallMs: 10 },
      { startedAt: 20, wallMs: 2 },
    ]),
  ).toBe(17);
});
it("identifies identical exploration only in the same revision and counts mutations separately", () => {
  const trace = new EfficiencyTrace();
  const row = {
    toolName: "readFile",
    workspaceRevision: 0,
    revisionAfter: 0,
    inputFingerprint: "a",
    resultFingerprint: "b",
    startedAt: 0,
    wallMs: 1,
    ok: true,
  };
  trace.tool(row);
  trace.tool(row);
  trace.tool({ ...row, workspaceRevision: 1, revisionAfter: 1 });
  expect(trace.rows.map((r) => r.redundant)).toEqual([false, true, false]);
  expect(trace.report().explorationRedundancyRate).toBeCloseTo(1 / 3);
});
it("records failed model calls without fabricated token usage or content", async () => {
  const trace = new EfficiencyTrace();
  await expect(
    trace
      .model({
        generate: async () => {
          throw new Error("private");
        },
      })
      .generate(
        { messages: [{ role: "USER", content: "secret-source" }], tools: [] },
        { signal: new AbortController().signal },
      ),
  ).rejects.toThrow();
  expect(trace.rows[0]?.inputTokens).toBeNull();
  expect(JSON.stringify(trace.report())).not.toContain("secret-source");
});

it("attributes failed source IO duration without inventing received bytes or leaking paths", async () => {
  vi.useFakeTimers();
  try {
    const trace = new EfficiencyTrace();
    const error = new DevflowError({
      code: "SANDBOX_RESOURCE_LIMIT",
      message: "private path and source",
    });
    const session = {
      readFile: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        throw error;
      },
    } as unknown as SandboxSession;
    const operation = trace.sandbox(session).readFile({ path: "secret/source.ts" });
    const rejected = expect(operation).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(trace.rows).toEqual([
      expect.objectContaining({
        stage: "SOURCE_READ",
        wallMs: 500,
        ok: false,
        errorCode: "SANDBOX_RESOURCE_LIMIT",
        sourceBytes: null,
      }),
    ]);
    expect(trace.report().stages[0]?.sourceBytes).toBe(0);
    expect(JSON.stringify(trace.report())).not.toContain("secret/source.ts");
    expect(JSON.stringify(trace.report())).not.toContain("private path");
  } finally {
    vi.useRealTimers();
  }
});
