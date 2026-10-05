import { z } from "zod";

const target = {
  path: z.string().min(1).max(1024),
  symbol: z.string().min(1).max(256).nullable(),
  rationale: z.string().min(1).max(1000),
};
// Nullable keys are required on the wire: native strict schema and full-schema fallback agree.
export const ExecutionContractSchema = z.strictObject({
  version: z.literal("execution-contract-v1"),
  editTargets: z
    .array(z.strictObject({ ...target, operation: z.enum(["MODIFY", "CREATE", "DELETE"]) }))
    .max(8),
  inspectTargets: z.array(z.strictObject(target)).max(8),
  verificationHints: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1024).nullable(),
        commandHint: z.string().max(1000).nullable(),
        description: z.string().min(1).max(1000),
      }),
    )
    .max(8),
  unresolvedQuestions: z.array(z.string().min(1).max(1000)).max(8),
});
export type ExecutionContract = z.infer<typeof ExecutionContractSchema>;

export const ExecutionPacketSchema = z.object({
  version: z.literal("execution-packet-v1"),
  goal: z.string().min(1).max(2400),
  editTargets: ExecutionContractSchema.shape.editTargets,
  inspectTargets: ExecutionContractSchema.shape.inspectTargets,
  verificationHints: ExecutionContractSchema.shape.verificationHints,
  unresolvedQuestions: ExecutionContractSchema.shape.unresolvedQuestions,
  constraints: z.array(z.string().max(2000)).max(16),
  baseCommitSha: z.string().min(1),
  workspaceRevision: z.number().int().nonnegative(),
  codeSlices: z
    .array(
      z.object({
        path: z.string(),
        symbol: z.string().nullable(),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        contentHash: z.string(),
        workspaceRevision: z.number().int().nonnegative(),
        code: z.string(),
        complete: z.boolean(),
        truncated: z.boolean(),
        fullFile: z.boolean(),
        role: z.enum(["EDIT", "INSPECT"]),
      }),
    )
    .max(16),
  evidenceRefs: z
    .array(
      z.object({
        path: z.string(),
        contentHash: z.string(),
        workspaceRevision: z.number().int().nonnegative(),
      }),
    )
    .max(16),
});
export type ExecutionPacket = z.infer<typeof ExecutionPacketSchema>;
