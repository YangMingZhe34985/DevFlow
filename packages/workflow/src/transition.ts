import { DevflowError } from "@devflow/shared";

import type { DevflowErrorShape } from "@devflow/shared";

import type { WorkflowStage, WorkflowState } from "./state.js";

const ALLOWED_TRANSITIONS: Readonly<Record<WorkflowStage, readonly WorkflowStage[]>> = {
  START: ["ANALYZE_REPOSITORY", "CANCELLED", "FAILED"],
  ANALYZE_REPOSITORY: ["ANALYZE_TASK", "CANCELLED", "FAILED"],
  ANALYZE_TASK: ["GENERATE_PLAN", "CANCELLED", "FAILED"],
  GENERATE_PLAN: ["WAITING_APPROVAL", "CANCELLED", "FAILED"],
  WAITING_APPROVAL: ["EXECUTE", "GENERATE_PLAN", "CANCELLED", "FAILED"],
  EXECUTE: ["TEST", "CANCELLED", "FAILED"],
  TEST: ["FIX", "REVIEW", "CANCELLED", "FAILED"],
  FIX: ["TEST", "CANCELLED", "FAILED"],
  REVIEW: ["FIX", "GENERATE_DIFF", "CANCELLED", "FAILED"],
  GENERATE_DIFF: ["DONE", "CANCELLED", "FAILED"],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: WorkflowStage, to: WorkflowStage): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionStage(state: WorkflowState, stage: WorkflowStage): WorkflowState {
  if (!canTransition(state.stage, stage)) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: `Invalid workflow transition: ${state.stage} -> ${stage}.`,
    });
  }

  const status =
    stage === "DONE"
      ? "SUCCEEDED"
      : stage === "FAILED"
        ? "FAILED"
        : stage === "CANCELLED"
          ? "CANCELLED"
          : stage === "WAITING_APPROVAL"
            ? "WAITING_APPROVAL"
            : "RUNNING";

  return { ...state, stage, status };
}

export function cancelWorkflow(state: WorkflowState): WorkflowState {
  return isTerminal(state.stage) ? state : transitionStage(state, "CANCELLED");
}

export function failWorkflow(state: WorkflowState, error: DevflowErrorShape): WorkflowState {
  if (isTerminal(state.stage)) return state;
  return { ...transitionStage(state, "FAILED"), lastError: error };
}

function isTerminal(stage: WorkflowStage): boolean {
  return stage === "DONE" || stage === "FAILED" || stage === "CANCELLED";
}
