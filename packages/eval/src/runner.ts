import { randomUUID } from "node:crypto";

import {
  BenchmarkCaseSchema,
  BenchmarkExecutionProfileSchema,
  BenchmarkExecutionRequestSchema,
  BenchmarkSuiteResultSchema,
  BenchmarkSuiteSchema,
  EvaluationObservationSchema,
  type BenchmarkCase,
  type BenchmarkExecutionProfile,
  type BenchmarkExecutionRequest,
  type BenchmarkSuite,
  type BenchmarkSuiteResult,
  type EvaluationObservation,
  type EvaluationResult,
  type EvaluationResultStore,
  type EvaluationRunner,
  type EvaluationTarget,
  type PricingConfiguration,
} from "./contracts.js";
import { immutableClone } from "./canonical.js";
import { aggregateSuiteMetrics } from "./aggregation.js";
import { createIntegrityManifest } from "./integrity.js";
import { scoreEvaluation } from "./scorer.js";

export interface BenchmarkRunnerOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export class DefaultEvaluationRunner implements EvaluationRunner {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly pricing: PricingConfiguration,
    private readonly store: EvaluationResultStore,
    options: BenchmarkRunnerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async runCase(
    suiteInput: Pick<BenchmarkSuite, "id" | "version">,
    testCaseInput: BenchmarkCase,
    profileInput: BenchmarkExecutionProfile,
    target: EvaluationTarget,
    signal?: AbortSignal,
  ): Promise<EvaluationResult> {
    return await this.runCaseInternal(suiteInput, testCaseInput, profileInput, target, signal);
  }

  private async runCaseInternal(
    suiteInput: Pick<BenchmarkSuite, "id" | "version">,
    testCaseInput: BenchmarkCase,
    profileInput: BenchmarkExecutionProfile,
    target: EvaluationTarget,
    signal?: AbortSignal,
    suiteExecutionId?: string,
  ): Promise<EvaluationResult> {
    signal?.throwIfAborted();
    const testCase = BenchmarkCaseSchema.parse(testCaseInput);
    const profile = BenchmarkExecutionProfileSchema.parse(profileInput);
    const executionId = this.idFactory();
    const startedAt = this.now().toISOString();
    const request = buildExecutionRequest(testCase, executionId);
    try {
      await this.store.beginCase?.({
        ...(suiteExecutionId === undefined ? {} : { suiteExecutionId }),
        suite: suiteInput,
        testCase,
        profile,
        executionId,
      });
      let observation: EvaluationObservation;
      const timeout = AbortSignal.timeout(testCase.limits.timeoutMs);
      const executionSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      try {
        observation = EvaluationObservationSchema.parse(
          await target.execute(immutableClone(request), executionSignal),
        );
      } catch (error) {
        if (signal?.aborted === true) signal.throwIfAborted();
        observation = failedObservation(testCase, executionId, error, timeout.aborted);
      }
      const finishedAt = this.now().toISOString();
      const result = scoreEvaluation(testCase, observation, {
        suite: suiteInput,
        executionId,
        profile,
        pricing: this.pricing,
        startedAt,
        finishedAt,
      });
      await this.store.saveCase(result);
      return result;
    } catch (error) {
      await this.store.failCase?.(executionId, error).catch(() => undefined);
      throw error;
    }
  }

  async runSuite(
    suiteInput: BenchmarkSuite,
    profileInput: BenchmarkExecutionProfile,
    target: EvaluationTarget,
    signal?: AbortSignal,
  ): Promise<BenchmarkSuiteResult> {
    const suite = BenchmarkSuiteSchema.parse(suiteInput);
    const profile = BenchmarkExecutionProfileSchema.parse(profileInput);
    const suiteExecutionId = this.idFactory();
    const startedAt = this.now().toISOString();
    const results: EvaluationResult[] = [];
    await this.store.beginSuite?.({
      suiteExecutionId,
      suite: { id: suite.id, version: suite.version },
      profile,
      pricingVersion: this.pricing.version,
    });
    try {
      for (const testCase of suite.cases) {
        signal?.throwIfAborted();
        results.push(
          await this.runCaseInternal(
            { id: suite.id, version: suite.version },
            testCase,
            profile,
            target,
            signal,
            suiteExecutionId,
          ),
        );
      }
      const result = BenchmarkSuiteResultSchema.parse({
        schemaVersion: 1,
        suiteExecutionId,
        suiteId: suite.id,
        suiteVersion: suite.version,
        startedAt,
        finishedAt: this.now().toISOString(),
        metrics: aggregateSuiteMetrics(results),
        cases: results,
      });
      await this.store.saveSuite(result);
      return result;
    } catch (error) {
      await this.store.failSuite?.(suiteExecutionId, error).catch(() => undefined);
      throw error;
    }
  }
}

export function buildExecutionRequest(
  testCaseInput: BenchmarkCase,
  executionId: string,
): BenchmarkExecutionRequest {
  const testCase = BenchmarkCaseSchema.parse(testCaseInput);
  return BenchmarkExecutionRequestSchema.parse({
    agent: {
      executionId,
      repository: testCase.repository,
      task: testCase.task,
      limits: testCase.limits,
    },
    evaluation: {
      ...(testCase.setupCommand === undefined ? {} : { setupCommand: testCase.setupCommand }),
      evaluationCommand: testCase.evaluationCommand,
      rules: testCase.rules,
      integrity: createIntegrityManifest(testCase),
    },
  });
}

function failedObservation(
  testCase: BenchmarkCase,
  executionId: string,
  error: unknown,
  timedOut = false,
): EvaluationObservation {
  const message = error instanceof Error ? error.message : String(error);
  return {
    run: {
      runId: executionId,
      status: timedOut ? "TIMED_OUT" : "FAILED",
      metrics: emptyRunMetrics(),
      error: {
        code: timedOut ? "TIMEOUT" : "INTERNAL_ERROR",
        message: timedOut
          ? "Benchmark target exceeded the configured case timeout."
          : `Benchmark target failed: ${message}`,
        retryable: false,
      },
    },
    evaluation: {
      exitCode: null,
      timedOut,
      durationMs: 0,
      stdout: "",
      stderr: message,
    },
    workflow: { testPassed: false, repairAttempts: 0, reviewRetries: 0 },
    integrity: {
      observedBaseCommit: testCase.repository.baseCommit,
      definitionDigest: "0".repeat(64),
      evaluationIsolated: false,
      protectedPaths: [],
    },
    totalLatencyMs: 0,
  };
}

function emptyRunMetrics(): EvaluationObservation["run"]["metrics"] {
  return {
    durationMs: 0,
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    retries: 0,
    modelLatencyMs: 0,
    toolLatencyMs: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}
