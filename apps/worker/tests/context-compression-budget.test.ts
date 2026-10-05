import { describe, expect, it } from "vitest";
import { WorkflowBudgetLedger } from "../src/runs/workflow-budget.js";
import { createWorkflowMetrics, mergeAgentPhaseMetrics } from "../src/runs/workflow-metrics.js";
import {
  ApprovalWorkflowRunExecutor,
  initialWorkflowMetrics,
} from "../src/runs/approval-workflow-run-executor.js";
import { loadWorkerEnvironment } from "../src/config/env.js";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
describe("summary reservations share the Run budget", () => {
  it("restores an interrupted summary request and its reservation without granting a new call or charging twice", async () => {
    const state = {
      calls: 1,
      pendingTokenReserve: 2500,
      attempts: ["a".repeat(64)],
      summaries: [],
    };
    const events = [
      {
        sequence: 1,
        type: "WORKFLOW_CHECKPOINT",
        payload: { purpose: "IMPLEMENTATION", contextCompressionReservation: { delta: 2500 } },
      },
      {
        sequence: 2,
        type: "LLM_REQUEST",
        stepId: "step",
        payload: {
          purpose: "IMPLEMENTATION",
          contextCompression: true,
          contextCompressionState: state,
        },
      },
    ];
    const db = { events: { list: async () => events } } as unknown as DatabaseAdapter;
    const worker = new ApprovalWorkflowRunExecutor(
      db,
      loadWorkerEnvironment({ DATABASE_URL: "unused" }),
    );
    const restored = await worker["restoreCompressionState"]("run", "IMPLEMENTATION", []);
    expect(restored?.calls).toBe(1);
    expect(restored?.pendingTokenReserve).toBe(0);
    const metrics = await initialWorkflowMetrics(db, {
      id: "run",
      retryCount: 0,
    } as RunExecutionRecord);
    expect(metrics.modelCalls).toBe(1);
    expect(metrics.contextCompressionReservedTokens).toBe(2500);
    expect(metrics.tokenUsage.totalTokens).toBe(0);
  });
  it("merges usage separately from unknown reservations and makes them unavailable to later stages", () => {
    const metrics = createWorkflowMetrics();
    const source = {
      ...createWorkflowMetrics(),
      steps: 2,
      modelCalls: 2,
      tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      contextCompressionReservedTokens: 2500,
    };
    mergeAgentPhaseMetrics(metrics, source, "EXECUTE", 1);
    const ledger = WorkflowBudgetLedger.fromMetrics(
      {
        maxSteps: 12,
        maxReviewRetries: 1,
        timeoutMs: 100000,
        maxTotalTokens: 3000,
        startedAt: Date.now(),
      },
      metrics,
    );
    expect(metrics.tokenUsage.totalTokens).toBe(150);
    expect(metrics.contextCompressionReservedTokens).toBe(2500);
    expect(ledger.remainingTotalTokens(metrics)).toBe(350);
  });
});
