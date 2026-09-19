import { RunResultSchema, type RunMetrics } from "@devflow/shared";
import { z } from "zod";

export const EvaluationCaseSchema = z.object({
  id: z.string().min(1),
  repository: z.object({
    sourceUri: z.string().min(1),
    baseCommit: z.string().min(1),
  }),
  task: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
  }),
  evaluationCommand: z.object({
    program: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
});
export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;

export const EvaluationObservationSchema = z.object({
  run: RunResultSchema,
  evaluationExitCode: z.number().int().nullable(),
  evaluationTimedOut: z.boolean(),
});
export type EvaluationObservation = z.infer<typeof EvaluationObservationSchema>;

export interface EvaluationResult {
  caseId: string;
  success: boolean;
  testPassed: boolean;
  metrics: RunMetrics;
  failureReason?: string;
}

export interface EvaluationTarget {
  execute(testCase: EvaluationCase, signal?: AbortSignal): Promise<EvaluationObservation>;
}

export interface EvaluationRunner {
  runCase(
    testCase: EvaluationCase,
    target: EvaluationTarget,
    signal?: AbortSignal,
  ): Promise<EvaluationResult>;
}
