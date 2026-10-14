import { describe, expect, it, vi } from "vitest";
import type { RunExecutionRecord } from "@devflow/database";
import type { SandboxSession } from "@devflow/sandbox";

import { usageFromEvents } from "../src/autonomous/executor.js";
import { ExecutionModeRouter } from "../src/autonomous/router.js";
import { runChecks, verificationFeedback } from "../src/autonomous/solve.js";
import type { RunExecutionPort } from "../src/runs/run-execution.js";

const response = (costMicros: number, inputTokens = 100) => ({
  type: "LLM_RESPONSE",
  payload: { usage: { inputTokens, outputTokens: 10, cachedInputTokens: 60 }, costMicros },
});
const request = (worstCaseMicros: number) => ({
  type: "LLM_REQUEST",
  payload: { worstCaseMicros },
});
const modelError = (unconfirmedMicros: number, willRetry: boolean) => ({
  type: "WORKFLOW_CHECKPOINT",
  payload: { modelError: { unconfirmedMicros, willRetry } },
});

describe("usageFromEvents", () => {
  it("sums settled responses from every earlier dispatch", () => {
    const usage = usageFromEvents([request(900), response(50), request(900), response(70, 300)]);
    expect(usage).toMatchObject({
      modelCalls: 2,
      inputTokens: 400,
      cachedInputTokens: 120,
      costMicros: 120,
      unconfirmedCostMicros: 0,
    });
  });

  it("charges a request left without a response at its worst case", () => {
    // The worker crashed while the second request was in flight.
    expect(usageFromEvents([request(900), response(50), request(800)])).toMatchObject({
      costMicros: 50,
      unconfirmedCostMicros: 800,
    });
  });

  it("counts each failed attempt once and keeps a retried attempt in flight", () => {
    const retriedThenSettled = usageFromEvents([request(500), modelError(500, true), response(40)]);
    expect(retriedThenSettled).toMatchObject({ unconfirmedCostMicros: 500, costMicros: 40 });
    const exhausted = usageFromEvents([
      request(500),
      modelError(500, true),
      modelError(500, true),
      modelError(500, false),
    ]);
    expect(exhausted.unconfirmedCostMicros).toBe(1500);
    const crashedDuringRetry = usageFromEvents([request(500), modelError(500, true)]);
    expect(crashedDuringRetry.unconfirmedCostMicros).toBe(1000);
  });
});

describe("ExecutionModeRouter", () => {
  const port = (name: string): RunExecutionPort => ({
    execute: vi.fn(async () => ({ name }) as never),
  });
  const run = (executionMode: string, currentStage = "START") =>
    ({ executionMode, currentStage }) as unknown as RunExecutionRecord;

  it("sends autonomous runs to the autonomous executor and publication back to the legacy one", async () => {
    const legacy = port("legacy");
    const autonomous = port("autonomous");
    const router = new ExecutionModeRouter(legacy, autonomous);
    const signal = new AbortController().signal;
    expect(await router.execute(run("autonomous"), signal)).toEqual({ name: "autonomous" });
    expect(await router.execute(run("autonomous", "PUSH"), signal)).toEqual({ name: "legacy" });
    expect(await router.execute(run("autonomous", "CREATE_PR"), signal)).toEqual({
      name: "legacy",
    });
    expect(await router.execute(run("workflow"), signal)).toEqual({ name: "legacy" });
    expect(await router.execute(run("team"), signal)).toEqual({ name: "legacy" });
  });
});

describe("runChecks", () => {
  function fakeSandbox(exitCodes: Record<string, number>) {
    const ran: string[] = [];
    const sandbox = {
      exec: vi.fn(async (command: { args: string[] }) => {
        const program = command.args[5]!;
        ran.push(program);
        return {
          exitCode: exitCodes[program] ?? 0,
          stdout: `${program} output`,
          stderr: "",
          durationMs: 1,
          timedOut: false,
          outputTruncated: false,
        };
      }),
    } as unknown as SandboxSession;
    return { sandbox, ran };
  }
  const check = (kind: string, program: string) => ({
    kind,
    command: { program, args: [], cwd: "." },
  });

  it("runs build → typecheck → lint → test regardless of profile order and stops at the first failure", async () => {
    const { sandbox, ran } = fakeSandbox({ "run-lint": 1 });
    const results = await runChecks(
      sandbox,
      [
        check("test", "run-test"),
        check("lint", "run-lint"),
        check("build", "run-build"),
        check("typecheck", "run-typecheck"),
      ],
      new AbortController().signal,
    );
    expect(ran).toEqual(["run-build", "run-typecheck", "run-lint"]);
    expect(results.map((r) => `${r.kind}:${r.status}`)).toEqual([
      "build:PASS",
      "typecheck:PASS",
      "lint:FAIL",
    ]);
  });

  it("reports the self-imposed timeout exit code as TIMEOUT", async () => {
    const { sandbox } = fakeSandbox({ "run-test": 125 });
    const [result] = await runChecks(
      sandbox,
      [check("test", "run-test")],
      new AbortController().signal,
    );
    expect(result!.status).toBe("TIMEOUT");
  });
});

describe("verificationFeedback", () => {
  it("names the failing check, its output and protected changes", () => {
    const text = verificationFeedback({
      passed: false,
      protectedChanges: ["tests/a.test.ts"],
      checks: [
        { kind: "build", status: "PASS", exitCode: 0, output: "", durationMs: 1 },
        { kind: "test", status: "FAIL", exitCode: 1, output: "expected 2, got 3", durationMs: 1 },
      ],
    });
    expect(text).toContain("tests/a.test.ts");
    expect(text).toContain("test failed (exit 1)");
    expect(text).toContain("expected 2, got 3");
  });
});
