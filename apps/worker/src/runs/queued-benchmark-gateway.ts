import { fileURLToPath } from "node:url";

import type { DatabaseAdapter, RunRecord } from "@devflow/database";
import {
  BenchmarkExecutionProfileSchema,
  BenchmarkExecutionRequestSchema,
  EvaluationObservationSchema,
  type BenchmarkExecutionRequest,
  type EvaluationObservation,
  type ExistingRunWorkerGateway,
} from "@devflow/eval";
import {
  captureLocalRepositoryCommitSnapshot,
  encodeLocalRepositorySnapshot,
  LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME,
  localRepositorySnapshotMetadata,
  resolveLocalFilesystemPath,
} from "@devflow/sandbox";
import { DevflowError, type RunQueuePort, type RunResult } from "@devflow/shared";

export interface QueuedRunWorkerEvaluationGatewayOptions {
  pollIntervalMs?: number;
  completionGraceMs?: number;
  localRepositoryRoot?: string;
}

const PROJECT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Production P11 gateway. It creates a normal Run, dispatches it through the
 * configured BullMQ queue, auto-approves only the benchmark plan, and waits for
 * the existing Worker/Workflow/Sandbox pipeline to persist a trusted observation.
 */
export class QueuedRunWorkerEvaluationGateway implements ExistingRunWorkerGateway {
  private readonly pollIntervalMs: number;
  private readonly completionGraceMs: number;

  constructor(
    private readonly database: DatabaseAdapter,
    private readonly queue: RunQueuePort,
    private readonly options: QueuedRunWorkerEvaluationGatewayOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.completionGraceMs = options.completionGraceMs ?? 60_000;
  }

  async executeBenchmark(
    requestInput: BenchmarkExecutionRequest,
    signal?: AbortSignal,
  ): Promise<EvaluationObservation> {
    const request = BenchmarkExecutionRequestSchema.parse(requestInput);
    const execution = await this.database.benchmarkExecutions.findCase(request.agent.executionId);
    if (execution === null) {
      throw new DevflowError({
        code: "NOT_FOUND",
        message: "Benchmark execution must be persisted before Worker dispatch.",
      });
    }
    const profile = BenchmarkExecutionProfileSchema.parse(execution.profile);
    let run: RunRecord;
    if (execution.runId !== undefined) {
      const existing = await this.database.runs.findById(execution.runId);
      if (existing === null) {
        throw new DevflowError({
          code: "NOT_FOUND",
          message: "Persisted benchmark Run was not found.",
          details: { executionId: execution.id, runId: execution.runId },
        });
      }
      run = existing;
    } else {
      const sourceKind = isRemoteRepository(request.agent.repository.sourceUri) ? "GIT" : "LOCAL";
      if (sourceKind === "LOCAL" && request.agent.limits.networkEnabled) {
        throw new DevflowError({
          code: "VALIDATION_ERROR",
          message: "LOCAL benchmark repositories cannot enable sandbox networking.",
          details: { phase: "BENCHMARK_CONFIGURATION" },
        });
      }
      const repository = await this.database.repositories.create({
        name: `benchmark-${execution.caseId}-${execution.id.slice(0, 8)}`,
        sourceKind,
        sourceUri: request.agent.repository.sourceUri,
      });
      const task = await this.database.tasks.create({
        repositoryId: repository.id,
        title: request.agent.task.title,
        description: request.agent.task.description,
        baseCommitSha: request.agent.repository.baseCommit,
      });
      const initialArtifact =
        sourceKind === "LOCAL"
          ? await this.committedSnapshotArtifact(
              request.agent.repository.sourceUri,
              request.agent.repository.baseCommit,
              signal,
            )
          : undefined;
      const persisted = await this.database.runs.create({
        taskId: task.id,
        idempotencyKey: `benchmark:${request.agent.executionId}`,
        modelProvider: profile.model.provider,
        modelName: profile.model.name,
        ...(profile.runtime.configuration.maxSteps === undefined
          ? {}
          : { maxSteps: profile.runtime.configuration.maxSteps }),
        ...(profile.runtime.configuration.maxTestRetries === undefined
          ? {}
          : { maxTestRetries: profile.runtime.configuration.maxTestRetries }),
        ...(profile.runtime.configuration.maxReviewRetries === undefined
          ? {}
          : { maxReviewRetries: profile.runtime.configuration.maxReviewRetries }),
        ...(initialArtifact === undefined ? {} : { initialArtifact }),
      });
      run = persisted.run;
      await this.database.benchmarkExecutions.attachRun(execution.id, run.id);
    }
    assertRuntimeConfigurationApplied(profile.runtime.configuration, run);
    if (run.status === "QUEUED") await this.enqueue(run);

    const deadline = Date.now() + request.agent.limits.timeoutMs + this.completionGraceMs;
    try {
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const detail = await this.database.runs.findDetail(run.id);
        if (detail === null) {
          throw new DevflowError({ code: "NOT_FOUND", message: "Run vanished." });
        }
        if (detail.run.status === "WAITING_APPROVAL") {
          const approval = detail.approvals.find(
            (candidate) => candidate.kind === "PLAN" && candidate.status === "PENDING",
          );
          if (approval !== undefined) {
            const resolved = await this.database.approvals.resolveForWorkflow(approval.id, {
              status: "APPROVED",
              actorId: `benchmark:${execution.id}`,
              comment: "Automatically approved by the trusted benchmark runner.",
            });
            if (resolved.shouldEnqueue && resolved.run !== undefined) {
              await this.enqueue(resolved.run);
            }
          }
        }
        if (isTerminal(detail.run.status)) {
          const recorded = await this.database.benchmarkExecutions.findCase(execution.id);
          if (recorded?.observation !== undefined) {
            return verifiedTerminalObservation(detail.run, recorded.observation);
          }
          return fallbackObservation(request, detail.run);
        }
        await delay(this.pollIntervalMs, signal);
      }
    } catch (error) {
      if (signal?.aborted === true) {
        await this.database.runs.requestCancellation(run.id).catch(() => undefined);
        await this.queue.cancel(run.id).catch(() => false);
      }
      throw error;
    }

    await this.database.runs.requestCancellation(run.id).catch(() => undefined);
    await this.queue.cancel(run.id).catch(() => false);
    throw new DevflowError({
      code: "TIMEOUT",
      message: "Benchmark Run did not finish within its configured timeout.",
      details: { runId: run.id, executionId: execution.id },
    });
  }

  private async committedSnapshotArtifact(
    sourceUri: string,
    baseCommit: string,
    signal?: AbortSignal,
  ) {
    const sourcePath = resolveLocalFilesystemPath(sourceUri, PROJECT_ROOT);
    const snapshot = await captureLocalRepositoryCommitSnapshot({
      sourceUri,
      workspaceRoot: resolveLocalFilesystemPath(
        this.options.localRepositoryRoot ?? sourcePath,
        PROJECT_ROOT,
      ),
      baseCommit,
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      kind: "OTHER" as const,
      name: LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME,
      mimeType: "application/vnd.devflow.local-snapshot+json+gzip",
      content: encodeLocalRepositorySnapshot(snapshot),
      metadata: localRepositorySnapshotMetadata(snapshot),
    };
  }

  private async enqueue(run: RunRecord): Promise<void> {
    await this.queue.enqueue({
      version: 1,
      runId: run.id,
      dispatchRevision: run.dispatchRevision,
    });
  }
}

function isRemoteRepository(sourceUri: string): boolean {
  return /^(?:https?|ssh|git):\/\//iu.test(sourceUri) || /^[^/\\\s]+@[^:\s]+:.+/u.test(sourceUri);
}

function isTerminal(status: RunRecord["status"]): boolean {
  return ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(status);
}

function verifiedTerminalObservation(run: RunRecord, input: unknown): EvaluationObservation {
  const observation = EvaluationObservationSchema.parse(input);
  if (observation.run.runId !== run.id || observation.run.status !== run.status) {
    throw new DevflowError({
      code: "CONFLICT",
      message: "Persisted benchmark observation does not match the terminal Run state.",
      details: {
        phase: "BENCHMARK_INTEGRITY",
        runId: run.id,
        runStatus: run.status,
        observationRunId: observation.run.runId,
        observationStatus: observation.run.status,
      },
    });
  }
  if (run.result !== undefined && run.result.status !== observation.run.status) {
    throw new DevflowError({
      code: "CONFLICT",
      message: "Persisted benchmark observation conflicts with the terminal Run result.",
      details: { phase: "BENCHMARK_INTEGRITY", runId: run.id },
    });
  }
  return observation;
}

function assertRuntimeConfigurationApplied(
  configuration: {
    maxSteps?: number | undefined;
    maxTestRetries?: number | undefined;
    maxReviewRetries?: number | undefined;
  },
  run: RunRecord,
): void {
  const checks = [
    ["maxSteps", configuration.maxSteps, run.maxSteps],
    ["maxTestRetries", configuration.maxTestRetries, run.maxTestRetries],
    ["maxReviewRetries", configuration.maxReviewRetries, run.maxReviewRetries],
  ] as const;
  for (const [name, declared, applied] of checks) {
    if (declared !== undefined && declared !== applied) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: `Benchmark runtime configuration '${name}' does not match the persisted Run.`,
        details: { phase: "BENCHMARK_CONFIGURATION", declared, applied },
      });
    }
  }
}

function fallbackObservation(
  request: BenchmarkExecutionRequest,
  run: RunRecord,
): EvaluationObservation {
  const terminalStatus =
    run.status === "CANCELLED" || run.status === "TIMED_OUT" ? run.status : "FAILED";
  const result: RunResult =
    run.result ??
    ({
      runId: run.id,
      status: terminalStatus,
      metrics: emptyMetrics(),
      error: {
        code: "INTERNAL_ERROR",
        message: "Run ended before the trusted benchmark evaluator produced an observation.",
        retryable: false,
      },
    } satisfies RunResult);
  return EvaluationObservationSchema.parse({
    run: result,
    evaluation: {
      exitCode: null,
      timedOut: result.status === "TIMED_OUT",
      durationMs: 0,
      stdout: "",
      stderr: result.error?.message ?? "Trusted evaluation did not run.",
    },
    workflow: { testPassed: false, repairAttempts: 0, reviewRetries: 0 },
    integrity: {
      observedBaseCommit: request.agent.repository.baseCommit,
      definitionDigest: request.evaluation.integrity.definitionDigest,
      evaluationIsolated: false,
      protectedPaths: [],
    },
    totalLatencyMs: result.metrics.durationMs,
  });
}

function emptyMetrics(): RunResult["metrics"] {
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

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
