import type { BenchmarkExecutionStore } from "@devflow/database";

import { benchmarkDefinitionDigest } from "./canonical.js";
import {
  BenchmarkCaseSchema,
  BenchmarkExecutionProfileSchema,
  BenchmarkSuiteResultSchema,
  EvaluationResultSchema,
  type BenchmarkSuiteResult,
  type EvaluationResult,
  type EvaluationResultStore,
} from "./contracts.js";

/**
 * Production P11 persistence adapter. Lifecycle state is written before a Run
 * is dispatched, while immutable scored results are stored on completion.
 */
export class DatabaseEvaluationResultStore implements EvaluationResultStore {
  constructor(private readonly executions: BenchmarkExecutionStore) {}

  async beginSuite(input: Parameters<NonNullable<EvaluationResultStore["beginSuite"]>>[0]) {
    const profile = BenchmarkExecutionProfileSchema.parse(input.profile);
    await this.executions.startSuite({
      id: input.suiteExecutionId,
      suiteId: input.suite.id,
      suiteVersion: input.suite.version,
      profile,
      pricingVersion: input.pricingVersion,
    });
  }

  async beginCase(input: Parameters<NonNullable<EvaluationResultStore["beginCase"]>>[0]) {
    const testCase = BenchmarkCaseSchema.parse(input.testCase);
    const profile = BenchmarkExecutionProfileSchema.parse(input.profile);
    await this.executions.startCase({
      id: input.executionId,
      ...(input.suiteExecutionId === undefined ? {} : { suiteExecutionId: input.suiteExecutionId }),
      suiteId: input.suite.id,
      suiteVersion: input.suite.version,
      caseId: testCase.id,
      caseVersion: testCase.version,
      definitionDigest: benchmarkDefinitionDigest(testCase),
      definition: testCase,
      profile,
    });
  }

  async failCase(executionId: string, error: unknown): Promise<void> {
    await this.executions.failCase(executionId, safeFailure(error));
  }

  async failSuite(suiteExecutionId: string, error: unknown): Promise<void> {
    await this.executions.failSuite(suiteExecutionId, safeFailure(error));
  }

  async saveCase(resultInput: EvaluationResult): Promise<void> {
    const result = EvaluationResultSchema.parse(resultInput);
    await this.executions.completeCase(result.executionId, {
      result,
      metrics: result.metrics,
      provenance: result.provenance,
      succeeded: result.success,
    });
  }

  async saveSuite(resultInput: BenchmarkSuiteResult): Promise<void> {
    const result = BenchmarkSuiteResultSchema.parse(resultInput);
    await this.executions.completeSuite(result.suiteExecutionId, {
      result,
      metrics: result.metrics,
      succeeded: result.metrics.failureCount === 0,
    });
  }

  async loadCase(_suiteId: string, executionId: string): Promise<EvaluationResult | undefined> {
    const record = await this.executions.findCase(executionId);
    return record?.result === undefined ? undefined : EvaluationResultSchema.parse(record.result);
  }

  async loadSuite(
    _suiteId: string,
    suiteExecutionId: string,
  ): Promise<BenchmarkSuiteResult | undefined> {
    const record = await this.executions.findSuite(suiteExecutionId);
    return record?.result === undefined
      ? undefined
      : BenchmarkSuiteResultSchema.parse(record.result);
  }

  async listCases(suiteId: string): Promise<readonly EvaluationResult[]> {
    const records = await this.executions.listCases(suiteId);
    return records.flatMap((record) =>
      record.result === undefined ? [] : [EvaluationResultSchema.parse(record.result)],
    );
  }
}

function safeFailure(error: unknown): { code: string; message: string } {
  return {
    code:
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "BENCHMARK_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}
