import { describe, expect, it } from "vitest";

import {
  AgentPlanSchema,
  FreshAgentPlanOutputSchema,
  DevflowErrorCodeSchema,
  RunMetricsSchema,
  TaskSpecSchema,
  type RunMetrics,
  type StageMetrics,
} from "../src/index.js";

describe("runtime metrics contracts", () => {
  it("preserves the canonical Task baseCommitSha field", () => {
    const task = TaskSpecSchema.parse({
      taskId: crypto.randomUUID(),
      repositoryId: crypto.randomUUID(),
      title: "Fix",
      description: "Fix the target.",
      baseCommitSha: "a".repeat(40),
    });

    expect(task.baseCommitSha).toBe("a".repeat(40));
    expect(task).not.toHaveProperty("baseCommit");
  });

  it("continues to accept the legacy flat Run metrics shape", () => {
    expect(RunMetricsSchema.parse(legacyMetrics())).toEqual(legacyMetrics());
  });

  it("keeps historical plans readable while requiring estimates for fresh output", () => {
    const historical = {
      summary: "Apply one targeted fix.",
      steps: [{ id: "one", title: "Fix", description: "Patch the target." }],
    };
    expect(AgentPlanSchema.parse(historical)).toEqual(historical);
    expect(FreshAgentPlanOutputSchema.safeParse(historical).success).toBe(false);
    expect(
      FreshAgentPlanOutputSchema.parse({
        ...historical,
        complexity: "SIMPLE",
        estimatedSteps: 6,
        confidence: 0.9,
      }),
    ).toMatchObject({ complexity: "SIMPLE", estimatedSteps: 6, confidence: 0.9 });
  });

  it("accepts stage, control, cache, execution, and reasoning metrics", () => {
    const execute = stageMetrics({ modelCalls: 2, toolCalls: 3, toolExecutions: 2 });
    const metrics: RunMetrics = {
      ...legacyMetrics(),
      toolExecutions: 2,
      cacheHits: 1,
      reasoningTokens: 7,
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        reasoningTokens: 7,
      },
      control: {
        duplicateToolCalls: 1,
        contextCacheHits: 1,
        structuredOutputFailures: 1,
        structuredOutputRepairAttempts: 1,
        stalledDetections: 0,
      },
      stages: { EXECUTE: execute },
      budget: {
        complexity: "SIMPLE",
        estimatedSteps: 8,
        confidence: 0.9,
        softLimit: 12,
        activeLimit: 12,
        hardLimit: 25,
        planSteps: 1,
        executeSteps: 4,
        repairSteps: 0,
        reviewSteps: 2,
        unusedSteps: 5,
        budgetExtensions: 0,
      },
    };

    expect(RunMetricsSchema.parse(metrics)).toEqual(metrics);
  });

  it.each([
    "MODEL_OUTPUT_INVALID",
    "AGENT_STALLED",
    "EXECUTION_BUDGET_EXCEEDED",
    "ESTIMATED_BUDGET_EXCEEDED",
    "MAX_STEPS_EXCEEDED",
    "NO_PROGRESS",
  ])("exposes the %s error code", (code) => {
    expect(DevflowErrorCodeSchema.parse(code)).toBe(code);
  });
});

function legacyMetrics(): RunMetrics {
  return {
    durationMs: 10,
    steps: 1,
    modelCalls: 1,
    toolCalls: 1,
    retries: 0,
    modelLatencyMs: 5,
    toolLatencyMs: 3,
    tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

function stageMetrics(overrides: Partial<StageMetrics> = {}): StageMetrics {
  return {
    steps: 1,
    attempts: 1,
    modelCalls: 1,
    toolCalls: 1,
    toolExecutions: 1,
    cacheHits: 0,
    modelLatencyMs: 5,
    toolLatencyMs: 3,
    wallLatencyMs: 10,
    reasoningTokens: 7,
    formatRepairCalls: 0,
    tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 7 },
    ...overrides,
  };
}
