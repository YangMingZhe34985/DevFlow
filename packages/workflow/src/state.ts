import {
  AgentPlanSchema,
  DevflowError,
  DevflowErrorShapeSchema,
  EntityIdSchema,
  RunStatusSchema,
  WorkflowStageSchema,
  type AgentPlan,
  type DevflowErrorShape,
  type RunId,
  type RunStatus,
  type WorkflowStage,
} from "@devflow/shared";
import { z } from "zod";

export { WorkflowStageSchema, type WorkflowStage } from "@devflow/shared";

export interface WorkflowState {
  runId: RunId;
  stage: WorkflowStage;
  status: RunStatus;
  testAttempt: number;
  reviewAttempt: number;
  maxTestRetries: number;
  maxReviewRetries: number;
  plan?: AgentPlan;
  lastError?: DevflowErrorShape;
}

export const WorkflowStateSchema = z.object({
  runId: EntityIdSchema,
  stage: WorkflowStageSchema,
  status: RunStatusSchema,
  testAttempt: z.number().int().nonnegative(),
  reviewAttempt: z.number().int().nonnegative(),
  maxTestRetries: z.number().int().nonnegative(),
  maxReviewRetries: z.number().int().nonnegative(),
  plan: AgentPlanSchema.optional(),
  lastError: DevflowErrorShapeSchema.optional(),
});

export function createInitialWorkflowState(
  runId: RunId,
  options: { maxTestRetries?: number; maxReviewRetries?: number } = {},
): WorkflowState {
  return {
    runId,
    stage: "START",
    status: "QUEUED",
    testAttempt: 0,
    reviewAttempt: 0,
    maxTestRetries: options.maxTestRetries ?? 3,
    maxReviewRetries: options.maxReviewRetries ?? 1,
  };
}

export function serializeWorkflowState(state: WorkflowState): string {
  return JSON.stringify(WorkflowStateSchema.parse(state));
}

export function deserializeWorkflowState(serialized: string): WorkflowState {
  try {
    const parsed = WorkflowStateSchema.parse(JSON.parse(serialized));
    return {
      runId: parsed.runId,
      stage: parsed.stage,
      status: parsed.status,
      testAttempt: parsed.testAttempt,
      reviewAttempt: parsed.reviewAttempt,
      maxTestRetries: parsed.maxTestRetries,
      maxReviewRetries: parsed.maxReviewRetries,
      ...(parsed.plan === undefined ? {} : { plan: parsed.plan }),
      ...(parsed.lastError === undefined ? {} : { lastError: parsed.lastError }),
    };
  } catch (error) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Persisted WorkflowState is invalid.",
      cause: error,
    });
  }
}
