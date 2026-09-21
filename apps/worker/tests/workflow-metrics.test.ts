import { fakeModelResponse } from "@devflow/agent";
import { describe, expect, it } from "vitest";

import {
  createWorkflowMetrics,
  mergeAgentPhaseMetrics,
  recordFormatRepair,
  recordModelResponse,
  recordStageAttempt,
  recordStageStep,
  recordStructuredFailure,
  recordToolWork,
  stageStepTotal,
} from "../src/runs/workflow-metrics.js";

describe("workflow stage metrics", () => {
  it("keeps flat compatibility totals equal to the stage ledger", () => {
    const metrics = createWorkflowMetrics();
    recordStageAttempt(metrics, "PLAN");
    recordStageStep(metrics, "PLAN");
    recordModelResponse(
      metrics,
      "PLAN",
      fakeModelResponse({
        toolCalls: [],
        usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
        latencyMs: 5,
      }),
    );
    recordToolWork(metrics, "TEST", { calls: 1, executions: 2, latencyMs: 9 });
    mergeAgentPhaseMetrics(
      metrics,
      {
        durationMs: 10,
        steps: 2,
        modelCalls: 2,
        toolCalls: 1,
        toolExecutions: 1,
        cacheHits: 0,
        reasoningTokens: 2,
        retries: 0,
        modelLatencyMs: 8,
        toolLatencyMs: 3,
        tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      "EXECUTE",
      12,
    );

    const stages = Object.values(metrics.stages ?? {}).filter(
      (stage): stage is NonNullable<typeof stage> => stage !== undefined,
    );
    expect(sum(stages, "modelCalls")).toBe(metrics.modelCalls);
    expect(stageStepTotal(metrics)).toBe(metrics.steps);
    expect(sum(stages, "toolCalls")).toBe(metrics.toolCalls);
    expect(sum(stages, "toolExecutions")).toBe(metrics.toolExecutions);
    expect(stages.reduce((total, stage) => total + stage.tokenUsage.totalTokens, 0)).toBe(
      metrics.tokenUsage.totalTokens,
    );
  });

  it("derives adaptive per-stage counters from stage metrics", () => {
    const metrics = createWorkflowMetrics();
    metrics.budget = {
      complexity: "SIMPLE",
      estimatedSteps: 6,
      confidence: 0.9,
      softLimit: 10,
      activeLimit: 10,
      hardLimit: 25,
      planSteps: 0,
      executeSteps: 0,
      repairSteps: 0,
      reviewSteps: 0,
      unusedSteps: 10,
      budgetExtensions: 0,
    };
    recordStageStep(metrics, "PLAN");
    recordStageStep(metrics, "REVIEW");

    expect(metrics.budget).toMatchObject({
      planSteps: 1,
      executeSteps: 0,
      repairSteps: 0,
      reviewSteps: 1,
      unusedSteps: 8,
    });
    expect(metrics.steps).toBe(2);
  });

  it("counts format repair separately from semantic retry", () => {
    const metrics = createWorkflowMetrics();
    recordFormatRepair(metrics, "REVIEW");
    recordStructuredFailure(metrics, "REVIEW");
    expect(metrics.retries).toBe(0);
    expect(metrics.control).toMatchObject({
      structuredOutputRepairAttempts: 1,
      structuredOutputFailures: 1,
    });
    expect(metrics.stages?.REVIEW?.formatRepairCalls).toBe(1);
  });
});

function sum<T extends Record<string, number>>(values: readonly T[], key: keyof T): number {
  return values.reduce((total, value) => total + value[key], 0);
}
