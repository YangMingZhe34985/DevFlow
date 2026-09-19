import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AgentRuntime } from "@devflow/agent";

import {
  cancelWorkflow,
  canTransition,
  createInitialWorkflowState,
  DefaultWorkflowEngine,
  deserializeWorkflowState,
  failWorkflow,
  serializeWorkflowState,
  transitionStage,
} from "../src/index.js";

describe("workflow transitions", () => {
  it("follows the initial deterministic path", () => {
    const state = createInitialWorkflowState("run-1");
    const analyzing = transitionStage(state, "ANALYZE_REPOSITORY");

    expect(analyzing).toMatchObject({ stage: "ANALYZE_REPOSITORY", status: "RUNNING" });
    expect(canTransition("GENERATE_PLAN", "WAITING_APPROVAL")).toBe(true);
  });

  it("rejects transitions out of terminal states", () => {
    const done = {
      ...createInitialWorkflowState("run-1"),
      stage: "DONE" as const,
      status: "SUCCEEDED" as const,
    };

    expect(() => transitionStage(done, "EXECUTE")).toThrow("Invalid workflow transition");
  });

  it("serializes state and handles failure and cancellation explicitly", () => {
    const runId = randomUUID();
    const executing = {
      ...createInitialWorkflowState(runId),
      stage: "EXECUTE" as const,
      status: "RUNNING" as const,
    };
    const failed = failWorkflow(executing, {
      code: "TOOL_FAILED",
      message: "test command failed",
      retryable: false,
    });
    const cancelled = cancelWorkflow(executing);

    expect(deserializeWorkflowState(serializeWorkflowState(failed))).toEqual(failed);
    expect(failed).toMatchObject({ stage: "FAILED", status: "FAILED" });
    expect(cancelled).toMatchObject({ stage: "CANCELLED", status: "CANCELLED" });
    expect(cancelWorkflow(cancelled)).toBe(cancelled);
  });

  it("turns an aborted resume into a cancelled workflow", async () => {
    const agent: AgentRuntime = {
      async run() {
        throw new Error("agent should not run");
      },
    };
    const controller = new AbortController();
    controller.abort();
    const state = createInitialWorkflowState(randomUUID());

    const result = await new DefaultWorkflowEngine(agent).resume(state, controller.signal);

    expect(result).toMatchObject({ stage: "CANCELLED", status: "CANCELLED" });
  });
});
