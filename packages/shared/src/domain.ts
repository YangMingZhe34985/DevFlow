import { z } from "zod";
import { ExecuteCompletionSchema, VerificationContractSchema } from "./completion.js";

import { DevflowErrorShapeSchema } from "./errors.js";
import { EntityIdSchema } from "./ids.js";

export const TaskStatusSchema = z.enum(["OPEN", "COMPLETED", "CANCELLED", "ARCHIVED"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const RunStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const WorkflowStageSchema = z.enum([
  "START",
  "ANALYZE_REPOSITORY",
  "ANALYZE_TASK",
  "GENERATE_PLAN",
  "WAITING_APPROVAL",
  "EXECUTE",
  "TEST",
  "FIX",
  "REVIEW",
  "GENERATE_DIFF",
  "WAITING_PUSH_APPROVAL",
  "PUSH",
  "WAITING_PR_APPROVAL",
  "CREATE_PR",
  "DONE",
  "FAILED",
  "CANCELLED",
]);
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  /** Provider-reported prompt-cache hits; a subset of inputTokens, billed at the cached rate. */
  cachedInputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.string().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const RunMetricStageSchema = z.enum(["PLAN", "EXECUTE", "TEST", "REPAIR", "REVIEW"]);
export type RunMetricStage = z.infer<typeof RunMetricStageSchema>;

export const StageMetricsSchema = z.object({
  steps: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolExecutions: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(),
  modelLatencyMs: z.number().int().nonnegative(),
  toolLatencyMs: z.number().int().nonnegative(),
  wallLatencyMs: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  formatRepairCalls: z.number().int().nonnegative(),
  tokenUsage: TokenUsageSchema,
});
export type StageMetrics = z.infer<typeof StageMetricsSchema>;

export const RunStageMetricsSchema = z.object({
  PLAN: StageMetricsSchema.optional(),
  EXECUTE: StageMetricsSchema.optional(),
  TEST: StageMetricsSchema.optional(),
  REPAIR: StageMetricsSchema.optional(),
  REVIEW: StageMetricsSchema.optional(),
});
export type RunStageMetrics = z.infer<typeof RunStageMetricsSchema>;

export const RunControlMetricsSchema = z.object({
  duplicateToolCalls: z.number().int().nonnegative(),
  contextCacheHits: z.number().int().nonnegative(),
  structuredOutputFailures: z.number().int().nonnegative(),
  structuredOutputRepairAttempts: z.number().int().nonnegative(),
  stalledDetections: z.number().int().nonnegative(),
});
export type RunControlMetrics = z.infer<typeof RunControlMetricsSchema>;

export const ComplexitySchema = z.enum(["SIMPLE", "MEDIUM", "COMPLEX"]);

/** Adaptive step budgets of retired workflow Runs; kept so their metrics stay readable. */
export const AdaptiveBudgetMetricsSchema = z.object({
  complexity: ComplexitySchema,
  estimatedSteps: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  softLimit: z.number().int().positive(),
  activeLimit: z.number().int().positive(),
  hardLimit: z.number().int().positive(),
  planSteps: z.number().int().nonnegative(),
  executeSteps: z.number().int().nonnegative(),
  repairSteps: z.number().int().nonnegative(),
  reviewSteps: z.number().int().nonnegative(),
  unusedSteps: z.number().int().nonnegative(),
  budgetExtensions: z.number().int().nonnegative(),
  rawEstimatedSteps: z.number().int().positive().optional(),
  adaptiveMargin: z.number().int().nonnegative().optional(),
  estimateClamped: z.boolean().optional(),
  discoveryExtensionUsed: z.boolean().optional(),
});
export type AdaptiveBudgetMetrics = z.infer<typeof AdaptiveBudgetMetricsSchema>;

export const RunMetricsSchema = z.object({
  modelRequestAttempts: z.number().int().nonnegative().optional(),
  modelRequestsDispatched: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolExecutions: z.number().int().nonnegative().optional(),
  cacheHits: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  retries: z.number().int().nonnegative(),
  modelLatencyMs: z.number().int().nonnegative(),
  toolLatencyMs: z.number().int().nonnegative(),
  tokenUsage: TokenUsageSchema,
  control: RunControlMetricsSchema.optional(),
  stages: RunStageMetricsSchema.optional(),
  budget: AdaptiveBudgetMetricsSchema.optional(),
  prePatch: z.record(z.string(), z.unknown()).optional(),
  /** Unknown usage from an interrupted summary request remains reserved, never fabricated as usage. */
  contextCompressionReservedTokens: z.number().int().nonnegative().optional(),
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

export const TerminalRunStatusSchema = z.enum(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]);

export const RepairFindingResponseSchema = z
  .object({
    findingId: z.string().min(1),
    outcome: z.enum([
      "CHANGED",
      "ALREADY_SATISFIED",
      "CONTRADICTED",
      "INSUFFICIENT_EVIDENCE",
      "SCOPE_CONFLICT",
    ]),
    summary: z.string().min(1).max(2000),
    evidence: z
      .array(
        z
          .object({
            path: z.string().min(1),
            quote: z.string().min(1).max(2000),
            fileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .max(4)
      .optional(),
  })
  .strict();
export const PhaseCompletionSchema = z.object({
  unfinishedWork: z.array(z.string().min(1).max(2000)).max(8).optional(),
  evidenceRefs: z
    .array(z.string().regex(/^source-[a-f0-9]{24}$/u))
    .max(4)
    .optional(),
  replanRequest: z
    .object({
      candidatePaths: z.array(z.string().min(1).max(1024)).min(1).max(8),
      reason: z.string().min(1).max(2000),
    })
    .strict()
    .optional(),
  findingResponses: z
    .array(
      RepairFindingResponseSchema.extend({
        evidenceStatus: z.enum(["CURRENT_SOURCE_LINKED", "UNVERIFIED"]).optional(),
        findingStatus: z.enum(["MATCHED", "UNKNOWN", "DUPLICATE"]).optional(),
      }),
    )
    .max(8)
    .optional(),
  unansweredFindingIds: z.array(z.string().min(1)).max(8).optional(),
  summary: z.string().min(1).max(2000).optional(),
  findingIds: z.array(z.string().min(1)).max(8).optional(),
  findingStatus: z.enum(["MATCHED", "UNKNOWN"]).optional(),
  evidenceStatuses: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        status: z.enum(["CURRENT_SOURCE_LINKED", "UNVERIFIED"]),
      }),
    )
    .optional(),
  outcome: z.enum([
    "CHANGED",
    "ALREADY_SATISFIED",
    "CONTRADICTED",
    "INSUFFICIENT_EVIDENCE",
    "SCOPE_CONFLICT",
  ]),
  evidence: z
    .array(
      z
        .object({
          path: z.string().min(1),
          quote: z.string().min(1).max(2000),
          fileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .strict(),
    )
    .max(4)
    .optional(),
  evidenceStatus: z.enum(["CURRENT_SOURCE_LINKED", "UNVERIFIED"]).optional(),
});

export const RunResultSchema = z.object({
  runId: EntityIdSchema,
  status: TerminalRunStatusSchema,
  summary: z.string().optional(),
  metrics: RunMetricsSchema,
  error: DevflowErrorShapeSchema.optional(),
  executeCompletion: ExecuteCompletionSchema.optional(),
  verification: VerificationContractSchema.optional(),
  phaseCompletion: PhaseCompletionSchema.optional(),
});
export type RunResult = z.infer<typeof RunResultSchema>;

/** Modes a persisted Run may carry. Only autonomous Runs execute; the rest are history. */
export const ExecutionModeSchema = z.enum(["workflow", "team", "single", "autonomous"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
