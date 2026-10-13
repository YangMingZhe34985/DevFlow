import type { DatabaseAdapter } from "@devflow/database";
import type { SandboxSession } from "@devflow/sandbox";
import { DevflowError, type RunResult } from "@devflow/shared";
import { describe, expect, it, vi } from "vitest";
import { loadWorkerEnvironment } from "../src/config/env.js";
import { ApprovalWorkflowRunExecutor } from "../src/runs/approval-workflow-run-executor.js";
import type { PreparedBenchmarkEvaluation } from "../src/runs/benchmark-evaluation.js";
import type * as BenchmarkEvaluation from "../src/runs/benchmark-evaluation.js";

const evaluate = vi.hoisted(() => vi.fn());
vi.mock("../src/runs/benchmark-evaluation.js", async (original) => ({
  ...(await original<typeof BenchmarkEvaluation>()),
  evaluateBenchmarkInSandbox: evaluate,
}));

describe("primary Coding failure and secondary benchmark failure", () => {
  it("preserves the earlier stalled error and explicitly marks evaluation incomplete", async () => {
    evaluate.mockRejectedValue(
      new DevflowError({
        code: "SANDBOX_LOST_OWNERSHIP",
        message: "lease expired during integrity reads",
      }),
    );
    const result = await finalize(failed());
    expect(result).toMatchObject({
      status: "FAILED",
      error: {
        code: "AGENT_STALLED",
        details: {
          noProgressStreak: 2,
          benchmarkEvaluation: {
            status: "INCOMPLETE",
            independentlyVerified: false,
            error: { code: "SANDBOX_LOST_OWNERSHIP" },
          },
        },
      },
    });
    expect(result.verification).toEqual(failed().verification);
  });
  it("does not turn an unverified successful candidate into benchmark success", async () => {
    const fault = new DevflowError({
      code: "SANDBOX_RESOURCE_LIMIT",
      message: "integrity read unavailable",
    });
    evaluate.mockRejectedValue(fault);
    await expect(finalize({ ...failed(), status: "SUCCEEDED", error: undefined })).rejects.toBe(
      fault,
    );
  });
});

function failed(): RunResult {
  return {
    runId: "run",
    status: "FAILED",
    error: {
      code: "AGENT_STALLED",
      message: "No edit progress",
      retryable: false,
      details: { noProgressStreak: 2 },
    },
    metrics: {
      durationMs: 1,
      steps: 2,
      modelCalls: 2,
      toolCalls: 1,
      retries: 0,
      modelLatencyMs: 1,
      toolLatencyMs: 1,
      tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  };
}
function finalize(result: RunResult) {
  const executor = new ApprovalWorkflowRunExecutor(
    {} as DatabaseAdapter,
    loadWorkerEnvironment({ DATABASE_URL: "unused" }),
  );
  return (
    executor as unknown as {
      finalizeBenchmark(
        prepared: PreparedBenchmarkEvaluation,
        sandbox: SandboxSession,
        result: RunResult,
        testPassed: boolean,
        repairs: number,
        reviews: number,
        signal: AbortSignal,
      ): Promise<RunResult>;
    }
  ).finalizeBenchmark(
    {} as PreparedBenchmarkEvaluation,
    {} as SandboxSession,
    result,
    false,
    1,
    0,
    new AbortController().signal,
  );
}
