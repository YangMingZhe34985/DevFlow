import { randomUUID } from "node:crypto";

import type { BenchmarkCaseExecutionRecord, DatabaseAdapter, RunRecord } from "@devflow/database";
import {
  BenchmarkExecutionRequestSchema,
  benchmarkDefinitionDigest,
  type BenchmarkCase,
  type EvaluationObservation,
} from "@devflow/eval";
import type { RunQueuePort, RunResult } from "@devflow/shared";
import { describe, expect, it, vi } from "vitest";

import { QueuedRunWorkerEvaluationGateway } from "../src/runs/queued-benchmark-gateway.js";

const BASE_COMMIT = "a".repeat(40);

describe("QueuedRunWorkerEvaluationGateway integrity", () => {
  it("rejects a stale successful observation for a persisted failed Run", async () => {
    const run = terminalRun("FAILED");
    const observation = evaluationObservation(run.id, "SUCCEEDED");
    const { database, queue, request } = fixture(run, observation);
    const gateway = new QueuedRunWorkerEvaluationGateway(database, queue, { pollIntervalMs: 1 });

    await expect(gateway.executeBenchmark(request)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Persisted benchmark observation does not match the terminal Run state.",
    });
  });

  it("returns an observation only when run id and terminal status match", async () => {
    const run = terminalRun("FAILED");
    const observation = evaluationObservation(run.id, "FAILED");
    const { database, queue, request } = fixture(run, observation);
    const gateway = new QueuedRunWorkerEvaluationGateway(database, queue, { pollIntervalMs: 1 });

    await expect(gateway.executeBenchmark(request)).resolves.toEqual(observation);
  });

  it("rejects LOCAL networking before creating a Repository or Run", async () => {
    const run = terminalRun("FAILED");
    const observation = evaluationObservation(run.id, "FAILED");
    const prepared = fixture(run, observation, { attached: false, networkEnabled: true });
    const createRepository = vi.fn();
    const database = {
      ...prepared.database,
      repositories: { create: createRepository },
    } as unknown as DatabaseAdapter;
    const gateway = new QueuedRunWorkerEvaluationGateway(database, prepared.queue, {
      pollIntervalMs: 1,
    });

    await expect(gateway.executeBenchmark(prepared.request)).rejects.toThrow(
      "LOCAL benchmark repositories cannot enable sandbox networking",
    );
    expect(createRepository).not.toHaveBeenCalled();
  });
});

function fixture(
  run: RunRecord,
  observation: EvaluationObservation,
  options: { attached?: boolean; networkEnabled?: boolean } = {},
) {
  const executionId = randomUUID();
  const testCase = benchmarkCase(options.networkEnabled ?? false);
  const execution: BenchmarkCaseExecutionRecord = {
    id: executionId,
    suiteId: "suite",
    suiteVersion: "1",
    caseId: testCase.id,
    caseVersion: testCase.version,
    status: "RUNNING",
    ...(options.attached === false ? {} : { runId: run.id }),
    definitionDigest: benchmarkDefinitionDigest(testCase),
    definition: testCase,
    profile: benchmarkProfile(),
    observation,
    startedAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
  const database = {
    benchmarkExecutions: { findCase: vi.fn(async () => execution) },
    runs: {
      findById: vi.fn(async () => run),
      findDetail: vi.fn(async () => ({ run, approvals: [] })),
    },
  } as unknown as DatabaseAdapter;
  const queue = {
    enqueue: vi.fn(async () => undefined),
    cancel: vi.fn(async () => false),
  } as unknown as RunQueuePort;
  const request = BenchmarkExecutionRequestSchema.parse({
    agent: {
      executionId,
      repository: testCase.repository,
      task: testCase.task,
      limits: testCase.limits,
    },
    evaluation: {
      evaluationCommand: testCase.evaluationCommand,
      rules: testCase.rules,
      integrity: {
        definitionDigest: benchmarkDefinitionDigest(testCase),
        expectedBaseCommit: BASE_COMMIT,
        protectedPaths: [],
      },
    },
  });
  return { database, queue, request };
}

function benchmarkCase(networkEnabled: boolean): BenchmarkCase {
  return {
    schemaVersion: 1,
    id: "gateway-case",
    version: "1",
    repository: { sourceUri: "C:/fixture", baseCommit: BASE_COMMIT },
    task: { title: "Fix", description: "Fix fixture" },
    evaluationCommand: {
      program: "node",
      args: ["evaluate.mjs"],
      cwd: ".",
      environment: {},
    },
    limits: { cpuCount: 1, memoryMb: 256, pids: 32, networkEnabled, timeoutMs: 10_000 },
    rules: {
      acceptedExitCodes: [0],
      requiredStdout: [],
      forbiddenStdout: [],
      protectedPaths: [],
      requireIsolatedEvaluation: true,
    },
    expectedOutcome: "PASS",
    metadata: {},
  };
}

function benchmarkProfile() {
  return {
    model: { provider: "fake", name: "fake", parameters: {} },
    runtime: {
      version: "approval-workflow-v1",
      configuration: { maxSteps: 5, maxTestRetries: 1, maxReviewRetries: 1 },
    },
    tools: {
      version: "core-tools-v1",
      enabled: [],
      policy: "benchmark",
      configuration: { network: false },
    },
  };
}

function terminalRun(status: "FAILED" | "SUCCEEDED"): RunRecord {
  const result: RunResult = {
    runId: randomUUID(),
    status,
    metrics: emptyMetrics(),
    ...(status === "FAILED"
      ? { error: { code: "INTERNAL_ERROR", message: "failed", retryable: false } }
      : {}),
  };
  return {
    id: result.runId,
    taskId: randomUUID(),
    status,
    currentStage: status === "FAILED" ? "FAILED" : "DONE",
    maxSteps: 5,
    maxTestRetries: 1,
    maxReviewRetries: 1,
    dispatchRevision: 1,
    retryCount: 0,
    cancellationRequested: false,
    result,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

function evaluationObservation(
  runId: string,
  status: "FAILED" | "SUCCEEDED",
): EvaluationObservation {
  return {
    run: {
      runId,
      status,
      metrics: emptyMetrics(),
      ...(status === "FAILED"
        ? { error: { code: "INTERNAL_ERROR", message: "failed", retryable: false } }
        : {}),
    },
    evaluation: { exitCode: 1, timedOut: false, durationMs: 1, stdout: "", stderr: "" },
    workflow: { testPassed: false, repairAttempts: 0, reviewRetries: 0 },
    integrity: {
      observedBaseCommit: BASE_COMMIT,
      definitionDigest: "b".repeat(64),
      evaluationIsolated: true,
      protectedPaths: [],
    },
    totalLatencyMs: 1,
  };
}

function emptyMetrics(): RunResult["metrics"] {
  return {
    durationMs: 1,
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    retries: 0,
    modelLatencyMs: 0,
    toolLatencyMs: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}
