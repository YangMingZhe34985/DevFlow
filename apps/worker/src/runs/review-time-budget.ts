import type { WorkerEnvironment } from "../config/env.js";
import {
  estimateOperationPlan,
  type ResourceBudgetOperationPlan,
} from "./resource-budget-scheduler.js";

/** Time capacity only. These operations are pending costs, not consumed time. */
export function finalValidationReviewTimePlan(
  environment: WorkerEnvironment,
  recoveryAvailable: boolean,
  validationTimeoutMs = 300_000,
): ResourceBudgetOperationPlan {
  return {
    kind: "SEQUENCE",
    id: "coding:final-validation-review-time",
    operations: [
      {
        kind: "OPERATION",
        id: "validation:shared-profile-deadline",
        requirement: "REQUIRED",
        state: "PENDING",
        resources: { timeMs: validationTimeoutMs },
        reason: "Configured public checks share one profile deadline, not a deadline per check.",
      },
      {
        kind: "OPERATION",
        id: "review:normal-request",
        requirement: "REQUIRED",
        state: "PENDING",
        resources: { timeMs: environment.DEVFLOW_REVIEW_REQUEST_TIMEOUT_MS },
      },
      ...(recoveryAvailable
        ? [
            {
              kind: "OPERATION" as const,
              id: "review:available-output-recovery",
              requirement: "REQUIRED" as const,
              state: "PENDING" as const,
              resources: { timeMs: environment.DEVFLOW_REVIEW_RECOVERY_TIMEOUT_MS },
              reason: "One recovery remains reachable under the persisted workflow allowance.",
            },
          ]
        : []),
      {
        kind: "OPERATION",
        id: "workflow:finalize",
        requirement: "REQUIRED",
        state: "PENDING",
        resources: { timeMs: environment.DEVFLOW_FINALIZE_TIMEOUT_MS },
      },
    ],
  };
}

export function codingTimePathPlan(input: {
  sharedFinal: ResourceBudgetOperationPlan;
  replan?: ResourceBudgetOperationPlan;
  submitCurrent?: boolean;
}): ResourceBudgetOperationPlan {
  return input.submitCurrent || !input.replan
    ? input.sharedFinal
    : {
        kind: "EXCLUSIVE",
        id: "coding:time-paths",
        exclusivityKey: "coding-result:continue-or-scope-replan",
        shared: input.sharedFinal,
        branches: [
          { kind: "SEQUENCE", id: "coding:continue-current-scope", operations: [] },
          input.replan,
        ],
      };
}

export function codingReplanReachable(
  used: boolean,
  repairAttempts: number,
  maximumRepairs: number,
) {
  return !used && repairAttempts < maximumRepairs;
}

export function reviewTimeReserve(environment: WorkerEnvironment, recoveryUsed = 0): number {
  return estimateOperationPlan(finalValidationReviewTimePlan(environment, recoveryUsed < 2, 0))
    .resources.timeMs;
}

/** Restore the earliest known expiry, including historical budget checkpoints. */
export function restoredWorkflowTiming(
  checkpoints: readonly { deadlineAt?: unknown; limits?: { timeoutMs?: unknown } }[],
  now: number,
  elapsedMs: number,
  configuredTimeoutMs: number,
  explicitTimeoutMs?: number,
): { startedAt: number; timeoutMs: number; deadlineAt: number } {
  const saved = checkpoints
    .filter(
      (c) =>
        typeof c.deadlineAt === "string" &&
        Number.isFinite(Date.parse(c.deadlineAt)) &&
        typeof c.limits?.timeoutMs === "number" &&
        c.limits.timeoutMs > 0,
    )
    .sort((a, b) => Date.parse(String(a.deadlineAt)) - Date.parse(String(b.deadlineAt)))[0];
  // A larger explicit limit cannot rewrite the saved duration paired with the
  // absolute expiry; otherwise a second restart would infer a different start.
  const timeoutMs = Math.min(
    explicitTimeoutMs ?? (saved?.limits?.timeoutMs as number | undefined) ?? configuredTimeoutMs,
    (saved?.limits?.timeoutMs as number | undefined) ?? Infinity,
  );
  const startedAt = saved
    ? Date.parse(String(saved.deadlineAt)) - Number(saved.limits!.timeoutMs)
    : now - elapsedMs;
  return {
    startedAt,
    timeoutMs,
    deadlineAt: Math.min(
      startedAt + timeoutMs,
      saved ? Date.parse(String(saved.deadlineAt)) : Infinity,
    ),
  };
}
