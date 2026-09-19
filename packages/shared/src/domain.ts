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
  baseCommit: z.string().min(1).optional(),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
});

export const AgentPlanSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1),
});
export type AgentPlan = z.infer<typeof AgentPlanSchema>;

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
  costUsd: z.string().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const RunMetricsSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  modelLatencyMs: z.number().int().nonnegative(),
  toolLatencyMs: z.number().int().nonnegative(),
  tokenUsage: TokenUsageSchema,
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
