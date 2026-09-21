import { repositoryUriContainsCredentials, RunResultSchema } from "@devflow/shared";
import { z } from "zod";

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const GitCommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu);
const JsonRecordSchema = z.record(z.string(), z.json());

export const BENCHMARK_RUNTIME_VERSION = "approval-workflow-v1";
export const BENCHMARK_TOOLS_VERSION = "core-tools-v1";

export const BenchmarkRuntimeConfigurationSchema = z
  .object({
    pipeline: z.literal("approval").optional(),
    worker: z.literal("bullmq").optional(),
    maxSteps: z.number().int().min(1).max(200).optional(),
    maxTestRetries: z.number().int().min(0).max(20).optional(),
    maxReviewRetries: z.number().int().min(0).max(10).optional(),
  })
  .strict();
export type BenchmarkRuntimeConfiguration = z.infer<typeof BenchmarkRuntimeConfigurationSchema>;

export const BenchmarkCommandSchema = z
  .object({
    program: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().min(1).default("."),
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
    environment: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type BenchmarkCommand = z.infer<typeof BenchmarkCommandSchema>;

export const BenchmarkSandboxLimitsSchema = z
  .object({
    cpuCount: z.number().positive().max(64).default(2),
    memoryMb: z.number().int().min(32).max(131_072).default(2_048),
    pids: z.number().int().positive().max(32_768).default(128),
    networkEnabled: z.boolean().default(false),
    timeoutMs: z.number().int().positive().max(7_200_000).default(900_000),
  })
  .strict();
export type BenchmarkSandboxLimits = z.infer<typeof BenchmarkSandboxLimitsSchema>;

export const ProtectedPathSchema = z
  .object({
    path: z.string().min(1),
    sha256: Sha256Schema,
  })
  .strict();
export type ProtectedPath = z.infer<typeof ProtectedPathSchema>;

export const EvaluationRulesSchema = z
  .object({
    acceptedExitCodes: z.array(z.number().int()).min(1).default([0]),
    requiredStdout: z.array(z.string().min(1)).default([]),
    forbiddenStdout: z.array(z.string().min(1)).default([]),
    protectedPaths: z.array(ProtectedPathSchema).default([]),
    requireIsolatedEvaluation: z.boolean().default(true),
  })
  .strict();
export type EvaluationRules = z.infer<typeof EvaluationRulesSchema>;

export const ExpectedOutcomeSchema = z.enum(["PASS", "FAIL", "TIMEOUT"]);
export type ExpectedOutcome = z.infer<typeof ExpectedOutcomeSchema>;

export const BenchmarkCaseSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    id: IdentifierSchema,
    version: z.string().min(1),
    repository: z
      .object({
        sourceUri: z
          .string()
          .min(1)
          .refine(
            (value) => !repositoryUriContainsCredentials(value),
            "Benchmark repository URIs must not contain credentials.",
          ),
        baseCommit: GitCommitSchema,
      })
      .strict(),
    task: z
      .object({
        title: z.string().min(1),
        description: z.string().min(1),
      })
      .strict(),
    setupCommand: BenchmarkCommandSchema.optional(),
    evaluationCommand: BenchmarkCommandSchema,
    limits: BenchmarkSandboxLimitsSchema.default({
      cpuCount: 2,
      memoryMb: 2_048,
      pids: 128,
      networkEnabled: false,
      timeoutMs: 900_000,
    }),
    rules: EvaluationRulesSchema.default({
      acceptedExitCodes: [0],
      requiredStdout: [],
      forbiddenStdout: [],
      protectedPaths: [],
      requireIsolatedEvaluation: true,
    }),
    expectedOutcome: ExpectedOutcomeSchema.default("PASS"),
    metadata: JsonRecordSchema.default({}),
  })
  .strict()
  .superRefine((testCase, context) => {
    if (
      testCase.limits.networkEnabled &&
      !isRemoteBenchmarkRepository(testCase.repository.sourceUri)
    ) {
      context.addIssue({
        code: "custom",
        message: "LOCAL benchmark repositories cannot enable sandbox networking.",
        path: ["limits", "networkEnabled"],
      });
    }
  });
export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;

/** @deprecated Use BenchmarkCaseSchema. */
export const EvaluationCaseSchema = BenchmarkCaseSchema;
/** @deprecated Use BenchmarkCase. */
export type EvaluationCase = BenchmarkCase;

export const BenchmarkSuiteSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    id: IdentifierSchema,
    version: z.string().min(1),
    description: z.string().optional(),
    cases: z.array(BenchmarkCaseSchema).min(1),
    metadata: JsonRecordSchema.default({}),
  })
  .strict()
  .superRefine((suite, context) => {
    const ids = new Set<string>();
    for (const testCase of suite.cases) {
      if (ids.has(testCase.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate benchmark case id '${testCase.id}'.`,
          path: ["cases"],
        });
      }
      ids.add(testCase.id);
    }
  });
export type BenchmarkSuite = z.infer<typeof BenchmarkSuiteSchema>;

export const BenchmarkExecutionProfileSchema = z
  .object({
    model: z
      .object({
        provider: z.string().min(1),
        name: z.string().min(1),
        parameters: JsonRecordSchema.default({}),
      })
      .strict(),
    runtime: z
      .object({
        version: z.literal(BENCHMARK_RUNTIME_VERSION),
        configuration: BenchmarkRuntimeConfigurationSchema.default({}),
      })
      .strict(),
    tools: z
      .object({
        version: z.literal(BENCHMARK_TOOLS_VERSION),
        enabled: z.array(z.string().min(1)),
        policy: z.string().min(1),
        configuration: JsonRecordSchema.default({}),
      })
      .strict(),
  })
  .strict();
export type BenchmarkExecutionProfile = z.infer<typeof BenchmarkExecutionProfileSchema>;

export const PricingEntrySchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    inputUsdPerMillionTokens: z.number().nonnegative(),
    outputUsdPerMillionTokens: z.number().nonnegative(),
  })
  .strict();

export const PricingConfigurationSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    version: z.string().min(1),
    currency: z.literal("USD").default("USD"),
    entries: z.array(PricingEntrySchema).min(1),
  })
  .strict()
  .superRefine((configuration, context) => {
    const keys = new Set<string>();
    for (const entry of configuration.entries) {
      const key = `${entry.provider}\u0000${entry.model}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate pricing entry for '${entry.provider}/${entry.model}'.`,
          path: ["entries"],
        });
      }
      keys.add(key);
    }
  });
export type PricingConfiguration = z.infer<typeof PricingConfigurationSchema>;

export const IntegrityManifestSchema = z
  .object({
    definitionDigest: Sha256Schema,
    expectedBaseCommit: GitCommitSchema,
    protectedPaths: z.array(ProtectedPathSchema),
  })
  .strict();
export type IntegrityManifest = z.infer<typeof IntegrityManifestSchema>;

export const AgentBenchmarkRequestSchema = z
  .object({
    executionId: z.string().uuid(),
    repository: BenchmarkCaseSchema.shape.repository,
    task: BenchmarkCaseSchema.shape.task,
    limits: BenchmarkSandboxLimitsSchema,
  })
  .strict();
export type AgentBenchmarkRequest = z.infer<typeof AgentBenchmarkRequestSchema>;

export const TrustedEvaluationRequestSchema = z
  .object({
    setupCommand: BenchmarkCommandSchema.optional(),
    evaluationCommand: BenchmarkCommandSchema,
    rules: EvaluationRulesSchema,
    integrity: IntegrityManifestSchema,
  })
  .strict();
export type TrustedEvaluationRequest = z.infer<typeof TrustedEvaluationRequestSchema>;

export const BenchmarkExecutionRequestSchema = z
  .object({
    agent: AgentBenchmarkRequestSchema,
    evaluation: TrustedEvaluationRequestSchema,
  })
  .strict();
export type BenchmarkExecutionRequest = z.infer<typeof BenchmarkExecutionRequestSchema>;

export const EvaluationCommandResultSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    stdout: z.string().default(""),
    stderr: z.string().default(""),
  })
  .strict();
export type EvaluationCommandResult = z.infer<typeof EvaluationCommandResultSchema>;

export const IntegrityObservationSchema = z
  .object({
    observedBaseCommit: GitCommitSchema,
    definitionDigest: Sha256Schema,
    evaluationIsolated: z.boolean(),
    protectedPaths: z.array(
      z
        .object({
          path: z.string().min(1),
          sha256Before: Sha256Schema,
          sha256After: Sha256Schema,
        })
        .strict(),
    ),
  })
  .strict();
export type IntegrityObservation = z.infer<typeof IntegrityObservationSchema>;

export const EvaluationObservationSchema = z
  .object({
    run: RunResultSchema,
    evaluation: EvaluationCommandResultSchema,
    workflow: z
      .object({
        testPassed: z.boolean(),
        repairAttempts: z.number().int().nonnegative(),
        reviewRetries: z.number().int().nonnegative(),
      })
      .strict(),
    integrity: IntegrityObservationSchema,
    totalLatencyMs: z.number().int().nonnegative(),
  })
  .strict();
export type EvaluationObservation = z.infer<typeof EvaluationObservationSchema>;

export const EvaluationMetricsSchema = z
  .object({
    steps: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.string().regex(/^\d+\.\d{8}$/u),
    modelLatencyMs: z.number().int().nonnegative(),
    toolLatencyMs: z.number().int().nonnegative(),
    evaluationLatencyMs: z.number().int().nonnegative(),
    totalLatencyMs: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
    repairAttempts: z.number().int().nonnegative(),
    reviewRetries: z.number().int().nonnegative(),
  })
  .strict();
export type EvaluationMetrics = z.infer<typeof EvaluationMetricsSchema>;

export const EvaluationProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: z.string().uuid(),
    suite: z.object({ id: IdentifierSchema, version: z.string().min(1) }).strict(),
    benchmark: z
      .object({
        id: IdentifierSchema,
        version: z.string().min(1),
        definitionDigest: Sha256Schema,
      })
      .strict(),
    repository: BenchmarkCaseSchema.shape.repository,
    task: BenchmarkCaseSchema.shape.task,
    setupCommand: BenchmarkCommandSchema.optional(),
    evaluationCommand: BenchmarkCommandSchema,
    evaluationRules: EvaluationRulesSchema,
    expectedOutcome: ExpectedOutcomeSchema,
    model: BenchmarkExecutionProfileSchema.shape.model,
    runtime: BenchmarkExecutionProfileSchema.shape.runtime,
    tools: BenchmarkExecutionProfileSchema.shape.tools,
    sandboxLimits: BenchmarkSandboxLimitsSchema,
    pricingVersion: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type EvaluationProvenance = z.infer<typeof EvaluationProvenanceSchema>;

export const EvaluationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    suiteId: IdentifierSchema,
    caseId: IdentifierSchema,
    executionId: z.string().uuid(),
    runId: z.string().uuid(),
    runStatus: RunResultSchema.shape.status,
    success: z.boolean(),
    testPassed: z.boolean(),
    evaluationPassed: z.boolean(),
    integrityPassed: z.boolean(),
    expectedOutcomeMatched: z.boolean(),
    evaluation: EvaluationCommandResultSchema,
    metrics: EvaluationMetricsSchema,
    provenance: EvaluationProvenanceSchema,
    failureReasons: z.array(z.string().min(1)),
  })
  .strict();
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

const AggregateCounterSchema = z
  .object({ total: z.number().nonnegative(), average: z.number().nonnegative() })
  .strict();

export const SuiteMetricsSchema = z
  .object({
    caseCount: z.number().int().positive(),
    successCount: z.number().int().nonnegative(),
    failureCount: z.number().int().nonnegative(),
    successRate: z.number().min(0).max(1),
    expectedOutcomeMatchCount: z.number().int().nonnegative(),
    expectedOutcomeMatchRate: z.number().min(0).max(1),
    steps: AggregateCounterSchema,
    toolCalls: AggregateCounterSchema,
    modelCalls: AggregateCounterSchema,
    inputTokens: AggregateCounterSchema,
    outputTokens: AggregateCounterSchema,
    totalTokens: AggregateCounterSchema,
    estimatedCostUsd: z.object({ total: z.string(), average: z.string() }).strict(),
    modelLatencyMs: AggregateCounterSchema,
    toolLatencyMs: AggregateCounterSchema,
    evaluationLatencyMs: AggregateCounterSchema,
    totalLatencyMs: AggregateCounterSchema,
    retries: AggregateCounterSchema,
    repairAttempts: AggregateCounterSchema,
    reviewRetries: AggregateCounterSchema,
  })
  .strict();
export type SuiteMetrics = z.infer<typeof SuiteMetricsSchema>;

export const BenchmarkSuiteResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    suiteExecutionId: z.string().uuid(),
    suiteId: IdentifierSchema,
    suiteVersion: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
    metrics: SuiteMetricsSchema,
    cases: z.array(EvaluationResultSchema).min(1),
  })
  .strict();
export type BenchmarkSuiteResult = z.infer<typeof BenchmarkSuiteResultSchema>;

/**
 * Trusted platform adapter. Implementations must invoke the existing Run/Worker
 * pipeline and execute the evaluator in its controlled final sandbox; this
 * interface is intentionally not an alternative Agent runtime.
 */
export interface EvaluationTarget {
  execute(request: BenchmarkExecutionRequest, signal?: AbortSignal): Promise<EvaluationObservation>;
}

export interface EvaluationResultStore {
  beginSuite?(input: {
    suiteExecutionId: string;
    suite: Pick<BenchmarkSuite, "id" | "version">;
    profile: BenchmarkExecutionProfile;
    pricingVersion: string;
  }): Promise<void>;
  beginCase?(input: {
    suiteExecutionId?: string;
    suite: Pick<BenchmarkSuite, "id" | "version">;
    testCase: BenchmarkCase;
    profile: BenchmarkExecutionProfile;
    executionId: string;
  }): Promise<void>;
  failCase?(executionId: string, error: unknown): Promise<void>;
  failSuite?(suiteExecutionId: string, error: unknown): Promise<void>;
  saveCase(result: EvaluationResult): Promise<void>;
  saveSuite(result: BenchmarkSuiteResult): Promise<void>;
  loadCase(suiteId: string, executionId: string): Promise<EvaluationResult | undefined>;
  loadSuite(suiteId: string, suiteExecutionId: string): Promise<BenchmarkSuiteResult | undefined>;
  listCases(suiteId: string): Promise<readonly EvaluationResult[]>;
}

export interface EvaluationRunner {
  runCase(
    suite: Pick<BenchmarkSuite, "id" | "version">,
    testCase: BenchmarkCase,
    profile: BenchmarkExecutionProfile,
    target: EvaluationTarget,
    signal?: AbortSignal,
  ): Promise<EvaluationResult>;
  runSuite(
    suite: BenchmarkSuite,
    profile: BenchmarkExecutionProfile,
    target: EvaluationTarget,
    signal?: AbortSignal,
  ): Promise<BenchmarkSuiteResult>;
}

function isRemoteBenchmarkRepository(sourceUri: string): boolean {
  return (
    /^(?:https?|ssh|git):\/\//iu.test(sourceUri) ||
    /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:.+/u.test(sourceUri)
  );
}
