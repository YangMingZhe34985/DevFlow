import { randomUUID } from "node:crypto";

import type {
  BenchmarkCaseExecutionRecord,
  DatabaseAdapter,
  RunExecutionRecord,
} from "@devflow/database";
import {
  BenchmarkCaseSchema,
  BenchmarkExecutionProfileSchema,
  benchmarkDefinitionDigest,
  sha256,
} from "@devflow/eval";
import { SandboxGitService } from "@devflow/git";
import type { SandboxSession } from "@devflow/sandbox";
import type { RunMetrics, RunResult } from "@devflow/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  benchmarkExecutionConfiguration,
  evaluateBenchmarkInSandbox,
  prepareBenchmarkEvaluation,
} from "../src/runs/benchmark-evaluation.js";
import {
  createTools,
  initialWorkflowMetrics,
  mergeModelResponseMetrics,
} from "../src/runs/approval-workflow-run-executor.js";

const CASE_EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";
const BASE_COMMIT = "a".repeat(40);

describe("benchmark execution configuration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads pinned model/tool settings and measures total latency from persisted case start", async () => {
    const startedAt = "2026-09-19T00:00:00.000Z";
    const execution = benchmarkExecution({ startedAt });
    let recorded: unknown;
    const database = databaseFor(execution, {
      markEvaluating: async () => undefined,
      recordObservation: async (_executionId, observation) => {
        recorded = observation;
      },
    });
    let processControlCalls = 0;
    const sandbox = {
      exec: vi.fn(async (command: { args?: string[] }) => {
        const processControl = command.args?.[0] === "-e";
        if (processControl) processControlCalls += 1;
        return {
          exitCode: 0,
          stdout: processControl ? (processControlCalls === 1 ? "[]" : "{}") : "evaluation passed",
          stderr: "",
          durationMs: 12,
          timedOut: false,
          outputTruncated: false,
        };
      }),
    } as unknown as SandboxSession;

    const prepared = await prepareBenchmarkEvaluation(
      database,
      benchmarkRun(),
      sandbox,
      new AbortController().signal,
    );
    expect(prepared).toMatchObject({
      startedAt: Date.parse(startedAt),
      configuration: {
        modelParameters: { temperature: 0, topP: 0.8, seed: 7, maxOutputTokens: 256 },
        runtime: {},
        tools: { enabled: ["readFile", "applyPatch"], policy: "benchmark", network: false },
      },
    });

    vi.spyOn(Date, "now").mockReturnValue(Date.parse(startedAt) + 5_000);
    const observation = await evaluateBenchmarkInSandbox(
      database,
      prepared!,
      sandbox,
      successfulRunResult(),
      { testPassed: true, repairAttempts: 0, reviewRetries: 0 },
      new AbortController().signal,
    );
    expect(observation.totalLatencyMs).toBe(5_000);
    expect(observation.integrity.evaluationIsolated).toBe(true);
    expect(processControlCalls).toBe(3);
    expect(recorded).toEqual(observation);
  });

  it("rejects unknown, unsupported or unapplied runtime configuration", async () => {
    const unknownRuntime = {
      ...profile(),
      runtime: {
        version: "approval-workflow-v1",
        configuration: { privileged: true },
      },
    };
    await expect(
      benchmarkExecutionConfiguration(
        databaseFor(benchmarkExecution({ profile: unknownRuntime })),
        RUN_ID,
      ),
    ).rejects.toMatchObject({ message: "Persisted benchmark execution profile is invalid." });

    const configured = profile({ runtimeConfiguration: { maxSteps: 11 } });
    await expect(
      prepareBenchmarkEvaluation(
        databaseFor(benchmarkExecution({ profile: configured })),
        benchmarkRun({ maxSteps: 10 }),
        {} as SandboxSession,
        new AbortController().signal,
      ),
    ).rejects.toThrow("'maxSteps' was not applied");
  });

  it("clears same-UID processes and preserves pre-evaluator tamper evidence", async () => {
    const original = "protected original";
    const tampered = "agent tamper";
    const testCase = BenchmarkCaseSchema.parse({
      ...benchmarkCase(),
      rules: {
        acceptedExitCodes: [0],
        requiredStdout: [],
        forbiddenStdout: [],
        protectedPaths: [{ path: "test/protected.mjs", sha256: sha256(original) }],
        requireIsolatedEvaluation: true,
      },
    });
    const execution = benchmarkExecution({ definition: testCase });
    let processControlCalls = 0;
    const sandbox = {
      exec: vi.fn(async (command: { args?: string[] }) => {
        const processControl = command.args?.[0] === "-e";
        if (processControl) processControlCalls += 1;
        return {
          exitCode: 0,
          stdout: processControl ? (processControlCalls === 1 ? '["1:10"]' : "{}") : "ok",
          stderr: "",
          durationMs: 1,
          timedOut: false,
          outputTruncated: false,
        };
      }),
      readFile: vi
        .fn()
        .mockResolvedValueOnce({ path: "test/protected.mjs", content: original, truncated: false })
        .mockResolvedValueOnce({ path: "test/protected.mjs", content: tampered, truncated: false })
        .mockResolvedValueOnce({ path: "test/protected.mjs", content: original, truncated: false }),
    } as unknown as SandboxSession;
    const database = databaseFor(execution);
    const prepared = await prepareBenchmarkEvaluation(
      database,
      benchmarkRun(),
      sandbox,
      new AbortController().signal,
    );
    const observation = await evaluateBenchmarkInSandbox(
      database,
      prepared!,
      sandbox,
      successfulRunResult(),
      { testPassed: true, repairAttempts: 0, reviewRetries: 0 },
      new AbortController().signal,
    );

    expect(processControlCalls).toBe(3);
    expect(sandbox.readFile).toHaveBeenCalledTimes(3);
    expect(observation.integrity).toMatchObject({
      evaluationIsolated: true,
      protectedPaths: [{ sha256Before: sha256(original), sha256After: sha256(tampered) }],
    });
  });

  it.each([
    [
      "unknown model parameter",
      profile({ parameters: { unsupported: true } }),
      "Unknown benchmark model parameter: unsupported.",
    ],
    [
      "unknown tool",
      profile({ enabled: ["shellAnything"] }),
      "Unknown benchmark tool 'shellAnything'.",
    ],
    [
      "unknown policy",
      profile({ policy: "allow-all" }),
      "Unsupported benchmark tool policy 'allow-all'.",
    ],
    [
      "unknown tool configuration",
      profile({ configuration: { network: false, privileged: true } }),
      "Unknown benchmark tool configuration: privileged.",
    ],
  ])("rejects %s explicitly", async (_label, invalidProfile, expectedMessage) => {
    await expect(
      benchmarkExecutionConfiguration(
        databaseFor(benchmarkExecution({ profile: invalidProfile })),
        RUN_ID,
      ),
    ).rejects.toMatchObject({ message: expectedMessage });
  });

  it("restricts both advertised and executable tools to tools.enabled", async () => {
    const { executor, tools } = createTools(new SandboxGitService(), {
      enabled: ["readFile"],
      policy: "benchmark",
      network: false,
    });
    expect(tools.map(({ name }) => name)).toEqual(["readFile"]);

    const result = await executor.execute(
      { name: "runCommand", input: { program: "echo", args: ["unsafe"] } },
      {
        runId: randomUUID(),
        stepId: randomUUID(),
        sandbox: {} as SandboxSession,
        signal: new AbortController().signal,
        emit: async () => undefined,
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message: "Tool 'runCommand' is not enabled by the benchmark profile.",
      },
    });
  });
});

describe("workflow metric accounting", () => {
  it("replays Plan and in-flight Execute usage without resetting the run budget", async () => {
    const run = benchmarkRun({ retryCount: 3 });
    const database = {
      events: {
        list: async () => [
          {
            type: "LLM_RESPONSE",
            payload: {
              purpose: "PLAN",
              latencyMs: 25,
              usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
            },
          },
          {
            type: "STEP_STARTED",
            payload: { purpose: "IMPLEMENTATION", step: 1 },
          },
          {
            type: "LLM_RESPONSE",
            payload: {
              purpose: "IMPLEMENTATION",
              ok: true,
              latencyMs: 99,
              usage: { inputTokens: 99, outputTokens: 99, totalTokens: 198 },
            },
          },
          {
            type: "STEP_COMPLETED",
            payload: {
              purpose: "IMPLEMENTATION",
              step: 1,
              toolCalls: 2,
              toolExecutions: 1,
              cachedToolCalls: 1,
              toolLatencyMs: 7,
            },
          },
        ],
      },
    } as unknown as DatabaseAdapter;

    await expect(initialWorkflowMetrics(database, run)).resolves.toMatchObject({
      steps: 2,
      modelCalls: 2,
      toolCalls: 2,
      toolExecutions: 1,
      cacheHits: 1,
      retries: 3,
      modelLatencyMs: 124,
      toolLatencyMs: 7,
      tokenUsage: { inputTokens: 110, outputTokens: 103, totalTokens: 213 },
    });
  });

  it("adds Review model usage and latency to final metrics", () => {
    const metrics = emptyMetrics();
    mergeModelResponseMetrics(metrics, {
      text: "review",
      toolCalls: [],
      finishReason: "STOP",
      latencyMs: 31,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    });

    expect(metrics).toMatchObject({
      modelCalls: 1,
      modelLatencyMs: 31,
      tokenUsage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    });
  });
});

function benchmarkCase() {
  return BenchmarkCaseSchema.parse({
    id: "configuration-case",
    version: "1.0.0",
    repository: { sourceUri: "C:/fixture", baseCommit: BASE_COMMIT },
    task: { title: "Fix fixture", description: "Apply the deterministic repair." },
    evaluationCommand: { program: "node", args: ["evaluate.mjs"] },
    limits: {
      cpuCount: 1,
      memoryMb: 256,
      pids: 64,
      networkEnabled: false,
      timeoutMs: 60_000,
    },
  });
}

function profile(
  overrides: {
    parameters?: Record<string, unknown>;
    enabled?: string[];
    policy?: string;
    configuration?: Record<string, unknown>;
    runtimeConfiguration?: Record<string, unknown>;
  } = {},
) {
  return BenchmarkExecutionProfileSchema.parse({
    model: {
      provider: "openai",
      name: "benchmark-model",
      parameters: overrides.parameters ?? {
        temperature: 0,
        topP: 0.8,
        seed: 7,
        maxOutputTokens: 256,
      },
    },
    runtime: {
      version: "approval-workflow-v1",
      configuration: overrides.runtimeConfiguration ?? {},
    },
    tools: {
      version: "core-tools-v1",
      enabled: overrides.enabled ?? ["readFile", "applyPatch"],
      policy: overrides.policy ?? "benchmark",
      configuration: overrides.configuration ?? { network: false },
    },
  });
}

function benchmarkExecution(
  overrides: {
    profile?: unknown;
    startedAt?: string;
    definition?: ReturnType<typeof benchmarkCase>;
  } = {},
): BenchmarkCaseExecutionRecord {
  const testCase = overrides.definition ?? benchmarkCase();
  return {
    id: CASE_EXECUTION_ID,
    suiteId: "suite",
    suiteVersion: "1",
    caseId: testCase.id,
    caseVersion: testCase.version,
    status: "RUNNING",
    runId: RUN_ID,
    definitionDigest: benchmarkDefinitionDigest(testCase),
    definition: testCase,
    profile: overrides.profile ?? profile(),
    startedAt: overrides.startedAt ?? "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

function databaseFor(
  execution: BenchmarkCaseExecutionRecord,
  overrides: {
    markEvaluating?: (executionId: string) => Promise<void>;
    recordObservation?: (executionId: string, observation: unknown) => Promise<void>;
  } = {},
): DatabaseAdapter {
  return {
    benchmarkExecutions: {
      findCaseByRunId: async () => execution,
      markEvaluating: overrides.markEvaluating ?? (async () => undefined),
      recordObservation: overrides.recordObservation ?? (async () => undefined),
    },
  } as unknown as DatabaseAdapter;
}

function benchmarkRun(overrides: Partial<RunExecutionRecord> = {}): RunExecutionRecord {
  return {
    id: RUN_ID,
    taskId: randomUUID(),
    status: "RUNNING",
    currentStage: "EXECUTE",
    maxSteps: 10,
    maxTestRetries: 1,
    maxReviewRetries: 1,
    dispatchRevision: 1,
    retryCount: 0,
    cancellationRequested: false,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    task: {
      id: randomUUID(),
      repositoryId: randomUUID(),
      title: "Fix fixture",
      description: "Apply the deterministic repair.",
      status: "OPEN",
      baseCommitSha: BASE_COMMIT,
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    },
    repository: {
      id: randomUUID(),
      name: "fixture",
      sourceKind: "LOCAL",
      sourceUri: "C:/fixture",
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    },
    ...overrides,
  };
}

function successfulRunResult(): RunResult {
  return { runId: RUN_ID, status: "SUCCEEDED", metrics: emptyMetrics() };
}

function emptyMetrics(): RunMetrics {
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
