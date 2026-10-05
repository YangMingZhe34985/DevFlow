import { z } from "zod";

/** Model proposal only. Source identity and permissions are supplied by the host. */
export const PlanProposalSchema = z.strictObject({
  decision: z.enum(["PROPOSE", "UNKNOWN"]),
  goal: z.string().trim().min(1),
  approach: z.array(z.string().trim().min(1)).min(1),
  candidateFiles: z.array(
    z.strictObject({
      path: z.string().trim().min(1),
      intent: z.enum(["INSPECT", "EDIT"]),
      operation: z.enum(["MODIFY", "CREATE"]).optional(),
      reason: z.string().trim().min(1),
      symbol: z.string().trim().min(1).optional(),
      evidenceRef: z.string().trim().min(1).optional(),
    }),
  ),
  verification: z.array(z.string().trim().min(1)),
  uncertainties: z.array(z.string().trim().min(1)),
});
export type PlanProposal = z.infer<typeof PlanProposalSchema>;

/** A request for approval, never an authorization until the approval is persisted. */
export const PlanApprovalScopeSchema = z.strictObject({
  version: z.literal("plan-approval-scope-v1"),
  mode: z.enum(["READY", "DISCOVERY_ONLY"]),
  baseCommitSha: z.string().min(1),
  workspaceRevision: z.number().int().nonnegative(),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1),
        operation: z.enum(["MODIFY", "CREATE"]),
      }),
    )
    .max(8),
});
export type PlanApprovalScope = z.infer<typeof PlanApprovalScopeSchema>;
