import { z } from "zod";

const count = z.number().nonnegative();
export const ExecuteCompletionSchema = z.object({
  outcome: z.enum(["PATCH_READY", "NEEDS_MORE_WORK", "FAILED"]),
  state: z.enum(["NO_PATCH", "PATCH_APPLIED", "PATCH_STABLE", "PATCH_READY"]),
  changedFiles: z.array(z.string()),
  plannedTargetsTouched: z.array(z.string()),
  unexpectedFiles: z.array(z.string()),
  blockers: z.array(z.string()),
  diffFingerprint: z.string().nullable(),
  failure: z
    .enum([
      "NO_VALID_PATCH",
      "PATCH_APPLICATION_FAILED",
      "PATCH_STALE",
      "PATCH_READY_BUT_NOT_FINISHED",
      "REAL_NO_PROGRESS",
      "BUDGET_EXHAUSTED_BEFORE_PATCH",
      "BUDGET_EXHAUSTED_AFTER_PATCH",
    ])
    .nullable(),
  metrics: z.object({
    firstMutationEndedAt: count.nullable(),
    PostPatchConvergenceMs: count.nullable(),
    postPatchModelCalls: count.nullable(),
    postPatchToolCalls: count.nullable(),
    postPatchInputTokens: count.nullable(),
    postPatchOutputTokens: count.nullable(),
    postPatchMutationAttempts: count.nullable(),
    postPatchReads: count.nullable(),
    postPatchGitDiffCalls: count.nullable(),
  }),
});
export type ExecuteCompletion = z.infer<typeof ExecuteCompletionSchema>;

export const VerificationContractSchema = z.object({
  execution: z.enum(["PATCH_READY", "NEEDS_MORE_WORK", "FAILED"]),
  test: z.enum(["TEST_PASSED", "FAILED", "SKIPPED", "NOT_RUN"]),
  review: z.enum(["REVIEW_PASSED", "FAILED", "NOT_RUN"]),
  issue: z.enum(["ISSUE_VERIFIED", "VERIFICATION_INCONCLUSIVE"]),
  reason: z.string(),
});
export type VerificationContract = z.infer<typeof VerificationContractSchema>;

/** Trusted executor observations, never a model-supplied tool argument. */
export interface MutationResult {
  status: "APPLIED" | "NO_OP" | "REJECTED" | "FAILED";
  executionSucceeded: boolean;
  mutationAttempted: boolean;
  mutationApplied: boolean;
  workspaceChanged: boolean;
  /** All potentially affected paths have complete before/after file identities. */
  observationComplete?: boolean;
  /** Host-resolved paths; absence means the potential write scope is unknown. */
  affectedPaths?: string[];
  reason: string;
  beforeRevision: number;
  afterRevision: number;
  changedFiles: string[];
  currentHashes: Record<string, string>;
}
