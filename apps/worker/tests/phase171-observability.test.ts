import { describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import { DevflowError } from "@devflow/shared";
import {
  ApprovalWorkflowRunExecutor,
  initialWorkflowMetrics,
} from "../src/runs/approval-workflow-run-executor.js";
import { loadWorkerEnvironment } from "../src/config/env.js";

describe("Phase 1.7.1 failure observations", () => {
  const run = { id: "test", retryCount: 0 } as RunExecutionRecord;
  const events = [
    {
      type: "LLM_RESPONSE",
      payload: {
        purpose: "PLAN",
        usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
        latencyMs: 5,
      },
    },
    {
      type: "WORKFLOW_CHECKPOINT",
      payload: {
        purpose: "IMPLEMENTATION",
        toolObservation: { callId: "one", calls: 1, executions: 1, cacheHits: 0, latencyMs: 3 },
      },
    },
    {
      type: "STEP_COMPLETED",
      payload: {
        purpose: "IMPLEMENTATION",
        toolObservationsPersisted: true,
        toolCalls: 1,
        toolExecutions: 1,
        toolLatencyMs: 3,
      },
    },
  ];
  it("recovers partial tool batches and does not double-count completed steps", async () => {
    const db = { events: { list: async () => events } } as unknown as DatabaseAdapter;
    const metrics = await initialWorkflowMetrics(db, run);
    expect(metrics).toMatchObject({
      modelCalls: 1,
      toolCalls: 1,
      toolExecutions: 1,
      toolLatencyMs: 3,
      tokenUsage: { totalTokens: 50 },
    });
  });
  it("keeps root failure and PLAN metrics when trace artifact flush fails", async () => {
    const db = {
      events: { list: async () => events },
      artifacts: {
        create: async () => {
          throw new Error("flush failed");
        },
      },
    } as unknown as DatabaseAdapter;
    const executor = new ApprovalWorkflowRunExecutor(db, {
      ...loadWorkerEnvironment({ DATABASE_URL: "unused" }),
      DEVFLOW_EFFICIENCY_TRACE_ENABLED: true,
    });
    const internal = executor as unknown as { executeObserved: () => Promise<never> };
    vi.spyOn(internal, "executeObserved").mockRejectedValue(
      new DevflowError({ code: "SANDBOX_PROCESS_FAILED", message: "root process error" }),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(executor.execute(run, new AbortController().signal)).rejects.toMatchObject({
        code: "SANDBOX_PROCESS_FAILED",
        message: "root process error",
      });
      expect(await executor.observedMetrics(run)).toMatchObject({
        modelCalls: 1,
        tokenUsage: { totalTokens: 50 },
      });
      expect(log).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ incomplete: true }),
      );
    } finally {
      log.mockRestore();
    }
  });
});
