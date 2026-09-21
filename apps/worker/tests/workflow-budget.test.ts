import type { Complexity, RunMetrics } from "@devflow/shared";
import { describe, expect, it } from "vitest";

import {
  WorkflowBudgetLedger,
  allocateExecuteBudget,
  allocateRepairBudget,
  allocateReviewBudget,
  buildAdaptiveBudgetMetrics,
  evaluateBudgetExtension,
  planAdaptiveBudget,
  planAdaptiveBudgetFromPlan,
  restoreAdaptiveBudgetState,
  type AdaptiveBudgetPlan,
} from "../src/runs/workflow-budget.js";

describe("WorkflowBudgetLedger", () => {
  it("shares the hard limit across implementation and repair phases", () => {
    const ledger = new WorkflowBudgetLedger({
      maxSteps: 5,
      maxReviewRetries: 1,
      timeoutMs: 60_000,
    });
    ledger.consumeRuntimeSteps(3, "EXECUTE");
    expect(ledger.remainingAgentSteps).toBe(2);
    ledger.consumeRuntimeSteps(2, "REPAIR");
    expect(ledger.remainingAgentSteps).toBe(0);
    expect(() => ledger.requireAgentSteps("REPAIR")).toThrowError(
      expect.objectContaining({
        code: "MAX_STEPS_EXCEEDED",
        details: expect.objectContaining({ limit: 5, observed: 6 }),
      }),
    );
  });

  it("restores run-wide steps from persisted metrics without allowing rewind", () => {
    const restored = WorkflowBudgetLedger.fromMetrics(
      { maxSteps: 5, maxReviewRetries: 1, timeoutMs: 60_000 },
      metrics({ steps: 3 }),
    );
    expect(restored.consumedAgentStepCount).toBe(3);
    expect(restored.remainingAgentSteps).toBe(2);

    restored.restoreAgentSteps(2, "EXECUTE");
    expect(restored.consumedAgentStepCount).toBe(3);
    restored.restoreAgentSteps(4, "REPAIR");
    expect(restored.snapshot(metrics()).observed.agentSteps).toBe(4);
  });

  it("counts every structured request, including format repair, as a step", () => {
    const ledger = new WorkflowBudgetLedger({
      maxSteps: 3,
      maxReviewRetries: 0,
      timeoutMs: 60_000,
    });
    ledger.consumeStructuredStep("PLAN");
    ledger.consumeStructuredStep("PLAN");
    ledger.consumeStructuredStep("REVIEW");
    expect(ledger.remainingAgentSteps).toBe(0);
  });

  it("reports the exact exhausted model, tool and token budget", () => {
    const ledger = new WorkflowBudgetLedger({
      maxSteps: 5,
      maxReviewRetries: 0,
      timeoutMs: 60_000,
      maxModelCalls: 2,
      maxToolCalls: 3,
      maxTotalTokens: 100,
    });
    expect(() => ledger.assertWithinLimits("EXECUTE", metrics({ modelCalls: 3 }))).toThrowError(
      expect.objectContaining({
        code: "EXECUTION_BUDGET_EXCEEDED",
        details: expect.objectContaining({ budgetType: "modelCalls", limit: 2, observed: 3 }),
      }),
    );
    expect(() => ledger.requireToolCalls("TEST", metrics({ toolCalls: 3 }))).toThrowError(
      expect.objectContaining({
        code: "EXECUTION_BUDGET_EXCEEDED",
        details: expect.objectContaining({ budgetType: "toolCalls", limit: 3, observed: 4 }),
      }),
    );
  });
});

describe("adaptive budget planning", () => {
  it.each<[Complexity, number, number, number]>([
    ["SIMPLE", 8, 25, 12],
    ["MEDIUM", 20, 100, 28],
    ["COMPLEX", 55, 100, 70],
  ])("plans a %s soft limit from estimate and uncertainty", (complexity, estimate, hard, soft) => {
    expect(
      planAdaptiveBudget({
        complexity,
        estimatedSteps: estimate,
        confidence: 0.8,
        hardLimit: hard,
      }),
    ).toMatchObject({
      complexity,
      estimatedSteps: estimate,
      softLimit: soft,
      activeLimit: soft,
      hardLimit: hard,
      estimateClamped: false,
    });
  });

  it("clamps an impossible estimate below the hard limit", () => {
    expect(
      planAdaptiveBudget({
        complexity: "COMPLEX",
        estimatedSteps: 200,
        confidence: 0.4,
        hardLimit: 25,
      }),
    ).toMatchObject({
      rawEstimatedSteps: 200,
      estimatedSteps: 24,
      softLimit: 25,
      activeLimit: 25,
      estimateClamped: true,
    });
  });

  it("supports the maxSteps=1 degenerate hard limit", () => {
    const budget = planAdaptiveBudget({
      complexity: "SIMPLE",
      estimatedSteps: 8,
      confidence: 0.9,
      hardLimit: 1,
    });
    expect(budget).toMatchObject({
      estimatedSteps: 1,
      adaptiveMargin: 0,
      softLimit: 1,
      activeLimit: 1,
      hardLimit: 1,
    });
  });

  it("initializes directly from a fresh structured PLAN and never shrinks a previous grant", () => {
    const budget = planAdaptiveBudgetFromPlan(
      {
        summary: "Target one file",
        steps: [{ id: "one", title: "Patch", description: "Patch the target." }],
        complexity: "SIMPLE",
        estimatedSteps: 4,
        confidence: 0.9,
      },
      {
        hardLimit: 25,
        consumedSteps: 6,
        minimumDownstreamSteps: 2,
        previousActiveLimit: 15,
      },
    );
    expect(budget.softLimit).toBe(8);
    expect(budget.activeLimit).toBe(15);
  });

  it("keeps a historical approved plan on the legacy hard-limit behavior", () => {
    const budget = planAdaptiveBudgetFromPlan(
      {
        summary: "Historical plan",
        steps: [{ id: "one", title: "Patch", description: "Patch the target." }],
      },
      { hardLimit: 25, consumedSteps: 1, minimumDownstreamSteps: 2 },
    );
    expect(budget).toMatchObject({
      complexity: "SIMPLE",
      estimatedSteps: 4,
      confidence: 0.35,
      softLimit: 25,
      activeLimit: 25,
    });
  });
});

describe("dynamic stage leases", () => {
  it("gives a maxSteps=100 complex implementation more than twelve steps", () => {
    const lease = allocateExecuteBudget({
      budget: adaptive("COMPLEX", 55, 100),
      consumedSteps: 1,
      remainingRepairAttempts: 4,
    });
    expect(lease).toMatchObject({
      initialSteps: 40,
      reviewReserve: 2,
      repairReserve: 27,
      mandatoryDownstreamSteps: 3,
    });
    expect(lease.initialSteps).toBeGreaterThan(12);
    expect(lease.maximumSteps).toBe(96);
  });

  it("keeps the simple fast path small while reserving repair and review", () => {
    expect(
      allocateExecuteBudget({
        budget: adaptive("SIMPLE", 8, 25),
        consumedSteps: 1,
        remainingRepairAttempts: 2,
      }),
    ).toMatchObject({
      initialSteps: 7,
      reviewReserve: 2,
      repairReserve: 2,
      mandatoryDownstreamSteps: 3,
    });
  });

  it("lets tiny Runs enter Execute before degrading downstream reserves", () => {
    expect(
      allocateExecuteBudget({
        budget: adaptive("SIMPLE", 8, 3),
        consumedSteps: 1,
        remainingRepairAttempts: 1,
      }),
    ).toMatchObject({
      initialSteps: 1,
      maximumSteps: 1,
      reviewReserve: 1,
      repairReserve: 0,
    });
  });

  it("divides the current repair pool by complexity-aware remaining cycles", () => {
    expect(
      allocateRepairBudget({
        budget: adaptive("COMPLEX", 55, 100),
        consumedSteps: 41,
        remainingRepairAttempts: 3,
      }),
    ).toMatchObject({
      initialSteps: 9,
      reviewReserve: 2,
      repairReserve: 18,
      mandatoryDownstreamSteps: 2,
    });
  });

  it("lets a final repair consume the last step when tests already failed", () => {
    expect(
      allocateRepairBudget({
        budget: adaptive("SIMPLE", 8, 3),
        consumedSteps: 2,
        remainingRepairAttempts: 1,
      }),
    ).toMatchObject({
      initialSteps: 1,
      maximumSteps: 1,
      reviewReserve: 0,
      mandatoryDownstreamSteps: 0,
    });
  });

  it("reserves one normal Review and its single format repair", () => {
    expect(
      allocateReviewBudget({ budget: adaptive("SIMPLE", 8, 25), consumedSteps: 10 }),
    ).toMatchObject({ stage: "REVIEW", initialSteps: 2, maximumSteps: 15 });
  });
});

describe("progress-aware extension", () => {
  it("reallocates unused active budget before growing the soft limit", () => {
    expect(
      evaluateBudgetExtension({
        stage: "EXECUTE",
        budget: adaptive("SIMPLE", 8, 25),
        consumedSteps: 7,
        mandatoryDownstreamSteps: 2,
        progress: "DIFF_PROGRESS",
        progressFingerprintChanged: true,
      }),
    ).toEqual({
      kind: "GRANTED",
      additionalSteps: 2,
      newActiveLimit: 12,
      budgetExtended: false,
      budgetExtensions: 0,
      reason: "ACTIVE_REALLOCATION",
    });
  });

  it("grants a bounded extension for a changed diff", () => {
    expect(
      evaluateBudgetExtension({
        stage: "EXECUTE",
        budget: adaptive("SIMPLE", 8, 25),
        consumedSteps: 10,
        mandatoryDownstreamSteps: 2,
        progress: "DIFF_PROGRESS",
        progressFingerprintChanged: true,
        budgetExtensions: 1,
      }),
    ).toEqual({
      kind: "GRANTED",
      additionalSteps: 2,
      newActiveLimit: 14,
      budgetExtended: true,
      budgetExtensions: 2,
      reason: "DIFF_PROGRESS",
    });
  });

  it("denies repeated or absent progress with NO_PROGRESS", () => {
    const budget = adaptive("SIMPLE", 8, 25);
    expect(
      evaluateBudgetExtension({
        stage: "EXECUTE",
        budget,
        consumedSteps: 10,
        mandatoryDownstreamSteps: 2,
        progress: "DIFF_PROGRESS",
        progressFingerprintChanged: false,
      }),
    ).toMatchObject({ kind: "DENIED", code: "NO_PROGRESS" });
    expect(
      evaluateBudgetExtension({
        stage: "REPAIR",
        budget,
        consumedSteps: 10,
        mandatoryDownstreamSteps: 1,
        progress: "NO_PROGRESS",
      }),
    ).toMatchObject({ kind: "DENIED", code: "NO_PROGRESS" });
  });

  it("uses ESTIMATED_BUDGET_EXCEEDED after the single discovery grace", () => {
    expect(
      evaluateBudgetExtension({
        stage: "EXECUTE",
        budget: adaptive("SIMPLE", 8, 25),
        consumedSteps: 10,
        mandatoryDownstreamSteps: 2,
        progress: "DISCOVERY_PROGRESS",
        discoveryExtensionUsed: true,
      }),
    ).toMatchObject({ kind: "DENIED", code: "ESTIMATED_BUDGET_EXCEEDED" });
  });

  it("never spends the mandatory reserve beyond the hard limit", () => {
    expect(
      evaluateBudgetExtension({
        stage: "EXECUTE",
        budget: { ...adaptive("COMPLEX", 55, 100), activeLimit: 100 },
        consumedSteps: 98,
        mandatoryDownstreamSteps: 2,
        progress: "DIFF_PROGRESS",
        progressFingerprintChanged: true,
      }),
    ).toMatchObject({ kind: "DENIED", code: "MAX_STEPS_EXCEEDED" });
  });
});

describe("adaptive metrics", () => {
  it("reports unused allocated budget rather than unused hard-limit capacity", () => {
    expect(
      buildAdaptiveBudgetMetrics(adaptive("SIMPLE", 8, 25), {
        planSteps: 1,
        executeSteps: 4,
        reviewSteps: 2,
      }),
    ).toMatchObject({
      softLimit: 12,
      activeLimit: 12,
      hardLimit: 25,
      unusedSteps: 5,
      planSteps: 1,
      executeSteps: 4,
      repairSteps: 0,
      reviewSteps: 2,
    });
  });

  it("round-trips active limit, extensions, and discovery grace through metrics", () => {
    const budget = adaptive("SIMPLE", 8, 25);
    const budgetMetrics = buildAdaptiveBudgetMetrics(budget, {
      planSteps: 1,
      executeSteps: 6,
      budgetExtensions: 2,
      discoveryExtensionUsed: true,
    });
    expect(
      restoreAdaptiveBudgetState(metrics({ steps: 7, budget: budgetMetrics }), 25),
    ).toMatchObject({
      plan: { softLimit: 12, activeLimit: 12, hardLimit: 25 },
      budgetExtensions: 2,
      discoveryExtensionUsed: true,
    });
  });

  it("uses the current Run hard limit when restoring an older snapshot", () => {
    const budgetMetrics = buildAdaptiveBudgetMetrics(adaptive("SIMPLE", 8, 25));
    expect(
      restoreAdaptiveBudgetState(metrics({ steps: 7, budget: budgetMetrics }), 10),
    ).toMatchObject({ plan: { estimatedSteps: 8, softLimit: 10, activeLimit: 10, hardLimit: 10 } });
  });
});

function adaptive(
  complexity: Complexity,
  estimatedSteps: number,
  hardLimit: number,
): AdaptiveBudgetPlan {
  return planAdaptiveBudget({ complexity, estimatedSteps, confidence: 0.8, hardLimit });
}

function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    durationMs: 0,
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    retries: 0,
    modelLatencyMs: 0,
    toolLatencyMs: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ...overrides,
  };
}
