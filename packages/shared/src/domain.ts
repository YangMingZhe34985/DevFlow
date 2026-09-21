import { z } from "zod";

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

export const ReviewFindingSchema = z.object({
  severity: z.enum(["INFO", "WARNING", "ERROR"]),
  message: z.string().min(1),
  path: z.string().min(1).optional(),
});

export const ReviewResultSchema = z.object({
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
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

export const TerminalRunStatusSchema = z.enum(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]);

export const RunResultSchema = z.object({
  runId: EntityIdSchema,
  status: TerminalRunStatusSchema,
  summary: z.string().optional(),
  metrics: RunMetricsSchema,
  error: DevflowErrorShapeSchema.optional(),
});
export type RunResult = z.infer<typeof RunResultSchema>;
