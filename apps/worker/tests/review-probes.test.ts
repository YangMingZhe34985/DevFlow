import { describe, expect, it } from "vitest";
import {
  collectReviewProbes,
  emptyReviewProbeState,
  preparePublicProbe,
  ReviewProbeStateSchema,
  type ProbeRequest,
} from "../src/runs/review-probes.js";
import type { IndexSource } from "../src/localization/contracts.js";
import { ReadonlyProbeRunner, type DockerCommandRunner } from "@devflow/sandbox";

const signal = new AbortController().signal;
const request: ProbeRequest = {
  findingId: "host-1",
  publicEntrypoint: "index.ts",
  language: "TS",
  code: "assertBehavior(entry.value===2, 'value=2', String(entry.value));",
  expectedObservation: "value=2",
  taskBasis: "Public Issue expects two",
};
function source(value: number): IndexSource {
  return {
    async manifest() {
      return { entries: [{ path: "index.ts", kind: "FILE", sizeBytes: 64 }], incomplete: false };
    },
    async read() {
      return { content: `export const value = ${value};`, truncated: false };
    },
  };
}
function runnerFixture() {
  const calls: string[][] = [];
  const runner: DockerCommandRunner = {
    async run(args, options) {
      calls.push([...args]);
      const payload = options?.stdin ? JSON.parse(options.stdin) : undefined;
      return {
        exitCode: args[0] === "start" && !payload?.modules["index.ts"].includes("= 2") ? 1 : 0,
        stdout:
          args[0] === "image"
            ? "sha256:" + "a".repeat(64)
            : "@@DEVFLOW_BEHAVIOR@@" +
              JSON.stringify({
                behaviorOutcome: payload?.modules["index.ts"].includes("= 2")
                  ? "EXPECTATION_MET"
                  : "EXPECTATION_FAILED",
                assertions: [
                  {
                    ok: Boolean(payload?.modules["index.ts"].includes("= 2")),
                    expected: "two",
                    actual: "public value",
                  },
                ],
              }),
        stderr: "",
        durationMs: 1,
        outputTruncated: false,
      };
    },
  };
  return { calls, runner: new ReadonlyProbeRunner(runner) };
}
describe("host public Review probes", () => {
  it("rejects unknown old host IDs and aliases crossing finding boundaries after restoration", async () => {
    const fixture = runnerFixture(),
      state = emptyReviewProbeState();
    const options = {
      requests: [{ ...request, probeId: "client-value", publicEntrypoint: "missing.ts" }],
      findings: [
        { findingId: "host-1", severity: "ERROR" as const, message: "Wrong" },
        { findingId: "host-2", severity: "ERROR" as const, message: "Other" },
      ],
      state,
      baseline: source(1),
      current: source(2),
      baseRevision: "b",
      currentRevision: "1",
      runner: fixture.runner,
      image: "local",
      signal,
      save: async () => {},
      beforeWork: () => {},
    };
    await collectReviewProbes(options);
    const restored = ReviewProbeStateSchema.parse(JSON.parse(JSON.stringify(state)));
    for (const next of [
      { ...request, findingId: "host-2", probeId: "client-value" },
      { ...request, probeId: "probe-" + "0".repeat(16) },
      { ...request, probeId: "unknown-label" },
    ]) {
      const result = await collectReviewProbes({ ...options, state: restored, requests: [next] });
      expect(result.feedback.some((f) => f.code === "UNKNOWN_PROBE_ID")).toBe(true);
    }
    expect(restored.executions).toBe(0);
    expect(restored.requests).toHaveLength(1);
    expect(restored.aliases).toEqual(state.aliases);
  });
  it("returns a correctable entrypoint error and preserves logical identity/version and correction credit", async () => {
    const fixture = runnerFixture(),
      state = emptyReviewProbeState();
    const options = {
      requests: [{ ...request, probeId: "probe-value-test", publicEntrypoint: "invented-test.ts" }],
      findings: [{ findingId: "host-1", severity: "ERROR" as const, message: "Wrong value" }],
      state,
      baseline: source(1),
      current: source(2),
      baseRevision: "base",
      currentRevision: "1",
      runner: fixture.runner,
      image: "local",
      signal,
      save: async () => {},
      beforeWork: () => {},
    };
    const failed = await collectReviewProbes(options);
    expect(failed).toMatchObject({
      progress: true,
      feedback: [expect.objectContaining({ code: "ENTRYPOINT_NOT_FOUND", retryable: true })],
    });
    expect(state.executions).toBe(0);
    expect(state.aliases).toEqual([
      {
        clientLabel: "probe-value-test",
        probeId: failed.feedback[0]!.probeId,
        findingId: "host-1",
      },
    ]);
    expect(state.requests[0]?.probeId).toMatch(/^probe-[a-f0-9]{16}$/u);
    expect(state.requests[0]?.probeId).not.toBe("probe-value-test");
    const restored = ReviewProbeStateSchema.parse(JSON.parse(JSON.stringify(state)));
    const corrected = await collectReviewProbes({
      ...options,
      state: restored,
      requests: [{ ...request, probeId: "probe-value-test" }],
    });
    expect(corrected.observations).toHaveLength(2);
    expect(corrected.observations.every((o) => o.probeId === failed.feedback[0]!.probeId)).toBe(
      true,
    );
    expect(restored).toMatchObject({
      correctionsUsed: 1,
      executions: 2,
      requests: [expect.objectContaining({ publicEntrypoint: "index.ts" })],
      requestVersions: [expect.objectContaining({ publicEntrypoint: "invented-test.ts" })],
    });
    const repeated = await collectReviewProbes({
      ...options,
      state: restored,
      requests: [
        {
          ...request,
          probeId: failed.feedback[0]!.probeId,
          code: "assertBehavior(true,'different','different')",
        },
      ],
    });
    expect(repeated.feedback[0]?.code).toBe("PROBE_CORRECTION_LIMIT");
    expect(restored.executions).toBe(2);
  });
  it("does not count repeated failures or cache metadata as new evidence", async () => {
    const fixture = runnerFixture(),
      state = emptyReviewProbeState();
    const options = {
      requests: [{ ...request, publicEntrypoint: "invented.ts" }],
      findings: [{ findingId: "host-1", severity: "ERROR" as const, message: "Wrong" }],
      state,
      baseline: source(1),
      current: source(2),
      baseRevision: "b",
      currentRevision: "1",
      runner: fixture.runner,
      image: "local",
      signal,
      save: async () => {},
      beforeWork: () => {},
    };
    expect((await collectReviewProbes(options)).progress).toBe(true);
    expect((await collectReviewProbes(options)).progress).toBe(false);
  });
  it("compares baseline/current and invalidates only changed candidate", async () => {
    const state = emptyReviewProbeState(),
      fixture = runnerFixture();
    const options = {
      requests: [request],
      findings: [{ findingId: "host-1", severity: "ERROR" as const, message: "wrong value" }],
      state,
      baseline: source(1),
      current: source(2),
      baseRevision: "base",
      currentRevision: "1",
      runner: fixture.runner,
      image: "local",
      signal,
      save: async () => {},
      beforeWork: () => {},
    };
    const first = await collectReviewProbes(options);
    expect(first.observations.map((o) => o.exitCode)).toEqual([1, 0]);
    expect(state.executions).toBe(2);
    const again = await collectReviewProbes(options);
    expect(again.observations.every((o) => o.cached)).toBe(true);
    expect(state.executions).toBe(2);
    const repaired = await collectReviewProbes({
      ...options,
      current: source(3),
      currentRevision: "2",
      requests: [],
    });
    expect(repaired.observations[0]!.cached).toBe(true);
    expect(repaired.observations[1]!.cached).toBeUndefined();
    expect(state.executions).toBe(3);
    for (const args of fixture.calls.filter((a) => a[0] === "create")) {
      expect(args).toContain("--read-only");
      expect(args).toContain("none");
      expect(args).toContain("512m");
      expect(args).toContain("1");
      expect(args).toContain("-i");
      expect(args).not.toContain("--env-file");
    }
  });
  it("rejects unknown IDs, private paths and oversized UTF-8 scripts", async () => {
    await expect(
      preparePublicProbe(source(1), { ...request, publicEntrypoint: ".env" }, signal),
    ).rejects.toThrow("POLICY_REJECTED");
    await expect(
      preparePublicProbe(source(1), { ...request, code: "中".repeat(6000) }, signal),
    ).rejects.toThrow("POLICY_REJECTED");
    const f = runnerFixture();
    const state = emptyReviewProbeState();
    const result = await collectReviewProbes({
      requests: [request],
      findings: [],
      state,
      baseline: source(1),
      current: source(2),
      baseRevision: "b",
      currentRevision: "c",
      runner: f.runner,
      image: "x",
      signal,
      save: async () => {},
      beforeWork: () => {},
    });
    expect(result.unresolved).toContain("UNKNOWN_FINDING_ID");
    expect(state.executions).toBe(0);
  });
  it("does not dispatch when time/tool reserve is insufficient", async () => {
    const f = runnerFixture(),
      state = emptyReviewProbeState();
    const result = await collectReviewProbes({
      requests: [request],
      findings: [{ findingId: "host-1", severity: "ERROR", message: "bad" }],
      state,
      baseline: source(1),
      current: source(2),
      baseRevision: "b",
      currentRevision: "c",
      runner: f.runner,
      image: "x",
      signal,
      save: async () => {},
      beforeWork: (kind) => {
        if (kind === "EXECUTE") throw Error("PROBE_BUDGET_INSUFFICIENT");
      },
    });
    expect(result.unresolved.join()).toContain("PROBE_BUDGET_INSUFFICIENT");
    expect(state.executions).toBe(0);
    expect(f.calls.some((a) => a[0] === "create")).toBe(false);
  });
});
