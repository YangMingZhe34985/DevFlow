import { z } from "zod";

export const DevflowErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "PERMISSION_DENIED",
  "APPROVAL_REQUIRED",
  "CONFLICT",
  "NOT_FOUND",
  "NOT_IMPLEMENTED",
  "ESTIMATED_BUDGET_EXCEEDED",
  "MAX_STEPS_EXCEEDED",
  "NO_PROGRESS",
  "EXECUTION_BUDGET_EXCEEDED",
  "AGENT_STALLED",
  "PLAN_TARGET_AMBIGUOUS",
  "PLAN_TARGET_INVALID",
  "PRE_PATCH_CONTEXT_BUDGET_EXHAUSTED",
  "PRE_PATCH_TOKEN_RESERVE_BLOCKED",
  "PRE_PATCH_EXPLORATION_STALLED",
  "PRE_PATCH_MODEL_BUDGET_EXHAUSTED",
  "TARGET_READ_FAILED",
  "TARGET_SYMBOL_NOT_FOUND",
  "INSUFFICIENT_EVIDENCE",
  "PATCH_ATTEMPT_REJECTED",
  "TIMEOUT",
  "CANCELLED",
  "TOOL_FAILED",
  "LLM_FAILED",
  "MODEL_OUTPUT_INVALID",
  "SANDBOX_FAILED",
  "SANDBOX_CREATE_FAILED",
  "SANDBOX_RESTORE_FAILED",
  "SANDBOX_ALREADY_DISPOSED",
  "SANDBOX_PROCESS_FAILED",
  "SANDBOX_RESOURCE_LIMIT",
  "SANDBOX_CANCELLED",
  "SANDBOX_LOST_OWNERSHIP",
  "DATABASE_FAILED",
  "GITHUB_FAILED",
  "INTERNAL_ERROR",
]);
export type DevflowErrorCode = z.infer<typeof DevflowErrorCodeSchema>;

export const DevflowErrorShapeSchema = z.object({
  code: DevflowErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.unknown().optional(),
});
export type DevflowErrorShape = z.infer<typeof DevflowErrorShapeSchema>;

export interface DevflowErrorOptions {
  code: DevflowErrorCode;
  message: string;
  retryable?: boolean;
  details?: unknown;
  cause?: unknown;
}

export class DevflowError extends Error {
  override readonly name = "DevflowError";
  readonly code: DevflowErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(options: DevflowErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  toJSON(): DevflowErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function toDevflowError(
  error: unknown,
  fallback: Pick<DevflowErrorOptions, "code" | "message" | "retryable">,
): DevflowError {
  if (error instanceof DevflowError) {
    return error;
  }

  return new DevflowError({
    ...fallback,
    cause: error,
    details: error instanceof Error ? { name: error.name, message: error.message } : undefined,
  });
}
