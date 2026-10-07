import { z } from "zod";
import { ExecuteCompletionSchema, VerificationContractSchema } from "./completion.js";

import { DevflowErrorShapeSchema } from "./errors.js";
import { EntityIdSchema } from "./ids.js";
import { ExecutionContractSchema } from "./execution.js";
import { PlanProposalSchema, PlanApprovalScopeSchema } from "./proposal.js";

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

export const TaskSpecSchema = z.object({
  taskId: EntityIdSchema,
  repositoryId: EntityIdSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  baseCommitSha: z.string().min(1).optional(),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
});

export const ComplexitySchema = z.enum(["SIMPLE", "MEDIUM", "COMPLEX"]);
export type Complexity = z.infer<typeof ComplexitySchema>;

export const AgentPlanSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1),
  // Optional here so plans persisted before adaptive budgeting remain readable.
  // Fresh PLAN generations use FreshAgentPlanOutputSchema below.
  complexity: ComplexitySchema.optional(),
  estimatedSteps: z.number().int().positive().optional(),
  confidence: z.number().min(0).max(1).optional(),
  executionContract: ExecutionContractSchema.optional(),
  proposalVersion: z.literal("plan-proposal-v1").optional(),
  proposal: PlanProposalSchema.optional(),
  approvalScope: PlanApprovalScopeSchema.optional(),
  warnings: z.array(z.string()).optional(),
});
export type AgentPlan = z.infer<typeof AgentPlanSchema>;

export const FreshAgentPlanOutputSchema = z
  .object({
    summary: z.string().min(1),
    steps: z.array(PlanStepSchema).min(1),
    complexity: ComplexitySchema,
    estimatedSteps: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type FreshAgentPlanOutput = z.infer<typeof FreshAgentPlanOutputSchema>;
export const FreshAgentPlanWithContractSchema = FreshAgentPlanOutputSchema.extend({
  executionContract: ExecutionContractSchema,
});

export const ReviewBehaviorSchema = z.object({
  scenario: z.string().min(1).max(2000),
  expected: z.string().min(1).max(2000),
  actual: z.string().min(1).max(2000),
  requirementBasis: z.enum(["ISSUE", "PUBLIC_API", "REGRESSION"]),
  requirement: z.string().min(1).max(2000),
  evidenceBasis: z.enum(["STATIC_DERIVATION", "PUBLIC_PROBE"]).optional(),
});

export const ReviewScopeAssessmentSchema = z.object({
  category: z.enum([
    "ISSUE_UNRESOLVED",
    "PATCH_REGRESSION",
    "PREEXISTING_UNRELATED",
    "UNDETERMINED",
  ]),
  explanation: z.string().min(1).max(2000),
  taskQuote: z.string().min(1).max(2000).optional(),
  baselineEvidence: z
    .object({ path: z.string().min(1), quote: z.string().min(1).max(4000) })
    .optional(),
});

export const ReviewFindingSchema = z.object({
  findingId: z.string().min(1).optional(),
  kind: z.enum(["DEFECT", "EVIDENCE_GAP", "SUGGESTION"]).optional(),
  severity: z.enum(["INFO", "WARNING", "ERROR"]),
  message: z.string().min(1),
  behavior: ReviewBehaviorSchema.optional(),
  scopeAssessment: ReviewScopeAssessmentSchema.optional(),
  blocking: z.boolean().optional(),
  blockingReason: z
    .enum([
      "NONE",
      "ISSUE_UNRESOLVED",
      "PATCH_REGRESSION",
      "ESSENTIAL_EVIDENCE_MISSING",
      "SCOPE_UNDETERMINED",
      "UNVERIFIED_BEHAVIOR",
    ])
    .optional(),
  probeIds: z.array(z.string().min(1)).max(2).optional(),
  probeAssessment: z
    .object({
      probeId: z.string().min(1),
      conclusion: z.enum(["CONFIRMED", "CONTRADICTED", "INCONCLUSIVE"]),
      explanation: z.string().min(1).max(2000),
    })
    .optional(),
  disposition: z.enum(["OPEN", "CONFIRMED", "RESOLVED", "CONTRADICTED", "DEFERRED"]).optional(),
  path: z.string().min(1).optional(),
  evidenceStatus: z.enum(["SOURCE_LINKED", "UNVERIFIED"]).optional(),
  evidence: z
    .object({
      quote: z.string().min(1),
      fileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      workspaceRevision: z.number().int().nonnegative(),
    })
    .optional(),
});

export const ReviewProbeRequestSchema = z
  .object({
    probeId: z.string().min(1).optional(),
    findingId: z.string().min(1),
    publicEntrypoint: z.string().min(1).max(1024),
    language: z.enum(["JS", "TS"]),
    code: z
      .string()
      .min(1)
      .max(16 * 1024),
    expectedObservation: z.string().min(1).max(2000),
    taskBasis: z.string().min(1).max(2000),
  })
  .strict();

export const ReviewHostFeedbackSchema = z.object({
  findingId: z.string().min(1).optional(),
  category: z.enum(["SOURCE", "BEHAVIOR", "TASK_SCOPE", "REQUEST_FORMAT"]),
  code: z.string().min(1),
  field: z.string().optional(),
  value: z.string().optional(),
  message: z.string().min(1),
});

export const ReviewResultSchema = z.object({
  hostFeedback: z.array(ReviewHostFeedbackSchema).optional(),
  probeRequests: z.array(ReviewProbeRequestSchema).max(2).optional(),
  decision: z.enum(["PASS", "FAIL", "NEEDS_EVIDENCE"]).optional(),
  decisionReason: z
    .enum(["NO_BLOCKING_FINDINGS", "BLOCKING_FINDINGS", "MISSING_EVIDENCE"])
    .optional(),
  evidenceRequests: z
    .array(
      z
        .object({
          path: z.string().min(1).max(1024).optional(),
          symbol: z.string().min(1).max(256).optional(),
          view: z.enum(["CURRENT", "BASELINE"]).optional(),
          question: z.string().min(1).max(2000),
        })
        .strict(),
    )
    .max(3)
    .optional(),
  approved: z.boolean(),
  summary: z.string().min(1),
  findings: z.array(ReviewFindingSchema).default([]),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
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
