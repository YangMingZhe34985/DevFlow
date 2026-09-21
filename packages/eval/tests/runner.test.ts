import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  DefaultEvaluationRunner,
  InMemoryEvaluationResultStore,
  RunWorkerEvaluationTarget,
  type BenchmarkExecutionRequest,
  type EvaluationObservation,
  type EvaluationTarget,
} from "../src/index.js";
import {
  benchmarkCase,
  benchmarkSuite,
  executionProfile,
  observation,
  pricingConfiguration,
} from "./test-helpers.js";

describe("DefaultEvaluationRunner", () => {
  it("keeps hidden evaluator inputs out of the Agent-visible request", async () => {
    const testCase = benchmarkCase();
    const store = new InMemoryEvaluationResultStore();
    let received: BenchmarkExecutionRequest | undefined;
    const target: EvaluationTarget = {
      execute: vi.fn(async (request) => {
        received = request;
        expect(Object.isFrozen(request)).toBe(true);
        return observation(testCase);
      }),
    };
    const runner = new DefaultEvaluationRunner(pricingConfiguration(), store);

    const result = await runner.runCase(
      { id: "suite", version: "1" },
      testCase,
      executionProfile(),
      target,
    );

    expect(result.success).toBe(true);
    expect(received?.agent).toEqual({
      executionId: result.executionId,
      repository: testCase.repository,
      task: testCase.task,
      limits: testCase.limits,
    });
    expect(received?.agent).not.toHaveProperty("evaluationCommand");
    expect(received?.agent).not.toHaveProperty("rules");
    expect(received?.evaluation).toHaveProperty("evaluationCommand");
    await expect(store.loadCase("suite", result.executionId)).resolves.toEqual(result);
  });

  it("aggregates success, token, cost, latency and workflow counters", async () => {
    const passing = benchmarkCase("passing");
    const failing = benchmarkCase("max-repair", { expectedOutcome: "FAIL" });
    const suite = benchmarkSuite([passing, failing]);
    const target: EvaluationTarget = {
      async execute(request) {
        return request.agent.repository.sourceUri.endsWith("passing")
          ? observation(passing, {
              inputTokens: 1_000,
              outputTokens: 500,
              repairAttempts: 1,
              totalLatencyMs: 100,
            })
          : observation(failing, {
              runStatus: "FAILED",
              exitCode: 1,
              stdout: "evaluation failed",
              testPassed: false,
              inputTokens: 3_000,
              outputTokens: 1_000,
              repairAttempts: 3,
              reviewRetries: 1,
              totalLatencyMs: 300,
            });
      },
    };
    const runner = new DefaultEvaluationRunner(
      pricingConfiguration(),
      new InMemoryEvaluationResultStore(),
    );

    const result = await runner.runSuite(suite, executionProfile(), target);

    expect(result.metrics).toMatchObject({
      caseCount: 2,
      successCount: 1,
      failureCount: 1,
      successRate: 0.5,
      expectedOutcomeMatchCount: 2,
      totalTokens: { total: 5_500, average: 2_750 },
      estimatedCostUsd: { total: "0.02000000", average: "0.01000000" },
      totalLatencyMs: { total: 400, average: 200 },
      repairAttempts: { total: 4, average: 2 },
      reviewRetries: { total: 1, average: 0.5 },
    });
  });

  it("persists a structured failure when the trusted pipeline adapter throws", async () => {
    const testCase = benchmarkCase("sandbox-failure", { expectedOutcome: "FAIL" });
    const store = new InMemoryEvaluationResultStore();
    const runner = new DefaultEvaluationRunner(pricingConfiguration(), store);

    const result = await runner.runCase(
      { id: "suite", version: "1" },
      testCase,
      executionProfile(),
      { execute: async () => await Promise.reject(new Error("docker unavailable")) },
    );

    expect(result).toMatchObject({
      success: false,
      runStatus: "FAILED",
      integrityPassed: false,
      expectedOutcomeMatched: false,
      evaluation: { stderr: "docker unavailable" },
    });
    expect(result.failureReasons).toContain("Run ended with status FAILED.");
    await expect(store.loadCase("suite", result.executionId)).resolves.toEqual(result);
  });

  it("repeats the same definition in isolated executions with stable provenance", async () => {
    const testCase = benchmarkCase("repeatable");
    const store = new InMemoryEvaluationResultStore();
    const ids = [randomUUID(), randomUUID()];
    const runner = new DefaultEvaluationRunner(pricingConfiguration(), store, {
      idFactory: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error("No repeatability id remaining.");
        return id;
      },
    });
    const target: EvaluationTarget = {
      async execute(request) {
        return observation(testCase, { runId: request.agent.executionId });
      },
    };

    const first = await runner.runCase(
      { id: "suite", version: "1" },
      testCase,
      executionProfile(),
      target,
    );
    const second = await runner.runCase(
      { id: "suite", version: "1" },
      testCase,
      executionProfile(),
      target,
    );

    expect(first.executionId).not.toBe(second.executionId);
    expect(first.runId).not.toBe(second.runId);
    expect(first.provenance.benchmark.definitionDigest).toBe(
      second.provenance.benchmark.definitionDigest,
    );
    await expect(store.listCases("suite")).resolves.toHaveLength(2);
  });
});

describe("RunWorkerEvaluationTarget", () => {
  it("delegates once to the existing Worker gateway without creating an Agent pipeline", async () => {
    const testCase = benchmarkCase();
    const request: BenchmarkExecutionRequest = {
      agent: {
        executionId: randomUUID(),
        repository: testCase.repository,
        task: testCase.task,
        limits: testCase.limits,
      },
      evaluation: {
        setupCommand: testCase.setupCommand,
        evaluationCommand: testCase.evaluationCommand,
        rules: testCase.rules,
        integrity: {
          definitionDigest: "a".repeat(64),
          expectedBaseCommit: testCase.repository.baseCommit,
          protectedPaths: [],
        },
      },
    };
    const expected: EvaluationObservation = {
      ...observation(testCase),
      integrity: {
        ...observation(testCase).integrity,
        definitionDigest: "a".repeat(64),
      },
    };
    const executeBenchmark = vi.fn(async () => expected);
    const target = new RunWorkerEvaluationTarget({ executeBenchmark });

    await expect(target.execute(request)).resolves.toEqual(expected);
    expect(executeBenchmark).toHaveBeenCalledOnce();
    expect(Object.isFrozen(executeBenchmark.mock.calls[0]?.[0])).toBe(true);
  });
});
