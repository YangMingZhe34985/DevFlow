import { AgentStateSerializer } from "@devflow/agent";
import { AgentPlanSchema, FreshAgentPlanWithContractSchema } from "@devflow/shared";
import { deserializeWorkflowState, serializeWorkflowState } from "@devflow/workflow";
import { describe, expect, it } from "vitest";

import { loadWorkerEnvironment } from "../src/config/env.js";

const RUN_ID = "00000000-0000-4000-8000-000000000013";
const HISTORICAL_PLAN = {
  summary: "An approved plan persisted before execution contracts were introduced",
  steps: [{ id: "fix", title: "Fix addition", description: "Preserve the public API." }],
};

describe("Agent-only production migration compatibility", () => {
  it("removes retired routing switches without changing safety and budget configuration", () => {
    const environment = loadWorkerEnvironment({
      DATABASE_URL: "unused",
      DEVFLOW_PLAN_AGENT_ENABLED: "false",
      DEVFLOW_PLAN_AGENT_ITERATIVE_ENABLED: "false",
      DEVFLOW_ISSUE_LOCALIZATION_AGENT_ENABLED: "false",
      DEVFLOW_LOCALIZATION_ENABLED: "false",
      DEVFLOW_PLAN_AGENT_MAX_TOTAL_TOKENS: "24000",
      DEVFLOW_PLAN_AGENT_MAX_MODEL_CALLS: "6",
      DEVFLOW_MAX_TOTAL_TOKENS: "50000",
    });
    for (const key of [
      "DEVFLOW_PLAN_AGENT_ENABLED",
      "DEVFLOW_PLAN_AGENT_ITERATIVE_ENABLED",
      "DEVFLOW_ISSUE_LOCALIZATION_AGENT_ENABLED",
      "DEVFLOW_LOCALIZATION_ENABLED",
    ])
      expect(environment).not.toHaveProperty(key);
    expect(environment).toMatchObject({
      DEVFLOW_PLAN_AGENT_MAX_TOTAL_TOKENS: 24000,
      DEVFLOW_PLAN_AGENT_MAX_MODEL_CALLS: 6,
      DEVFLOW_MAX_TOTAL_TOKENS: 50000,
    });
  });

  it("reads an old approval plan without inventing a fresh execution contract", () => {
    expect(AgentPlanSchema.parse(HISTORICAL_PLAN)).toEqual(HISTORICAL_PLAN);
    expect(FreshAgentPlanWithContractSchema.safeParse(HISTORICAL_PLAN).success).toBe(false);
    const state = {
      runId: RUN_ID,
      stage: "WAITING_APPROVAL" as const,
      status: "WAITING_APPROVAL" as const,
      testAttempt: 0,
      reviewAttempt: 0,
      maxTestRetries: 1,
      maxReviewRetries: 1,
      plan: HISTORICAL_PLAN,
    };
    const restored = deserializeWorkflowState(JSON.stringify(state));
    expect(restored).toEqual(state);
    expect(JSON.parse(serializeWorkflowState(restored))).toEqual(state);
  });

  it("reads schema-version 1 execution checkpoints containing a historical plan", () => {
    const checkpoint = {
      schemaVersion: 1,
      runId: RUN_ID,
      phase: "THINKING",
      stepCount: 2,
      messages: [],
      metrics: {
        modelCalls: 2,
        toolCalls: 0,
        retries: 0,
        modelLatencyMs: 1,
        toolLatencyMs: 0,
        tokenUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      },
      startedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:01.000Z",
      plan: HISTORICAL_PLAN,
    };
    const serializer = new AgentStateSerializer();
    const restored = serializer.deserialize(JSON.stringify(checkpoint));
    expect(restored.plan).toEqual(HISTORICAL_PLAN);
    expect(restored.schemaVersion).toBe(1);
    expect(restored.stepCount).toBe(2);
    expect(serializer.deserialize(serializer.serialize(restored))).toEqual(restored);
  });
});
