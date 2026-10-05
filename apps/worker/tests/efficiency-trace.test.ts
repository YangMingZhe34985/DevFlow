import { expect, it } from "vitest";
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
