import { randomUUID } from "node:crypto";

import type { RunRepository } from "@devflow/database";
import {
  DevflowError,
  RunJobSchema,
  toDevflowError,
  type RunResult,
  type RunStatus,
} from "@devflow/shared";
import type { Job } from "bullmq";

import type { RunExecutionPort } from "./run-execution.js";

export interface RunProcessorOptions {
  workerId: string;
  leaseMs: number;
  cancellationPollMs: number;
}

export interface RunProcessResult {
  outcome: "COMPLETED" | "SKIPPED";
  status?: RunStatus;
}

export class RunProcessor {
  constructor(
    private readonly runs: RunRepository,
    private readonly executor: RunExecutionPort,
    private readonly options: RunProcessorOptions,
  ) {}

  async process(job: Job<unknown>, workerSignal?: AbortSignal): Promise<RunProcessResult> {
    const runJob = RunJobSchema.parse(job.data);
    const owner = `${this.options.workerId}:${job.id ?? runJob.runId}:${randomUUID()}`;
    const run = await this.runs.claim(
      runJob.runId,
      owner,
      this.options.leaseMs,
      runJob.dispatchRevision,
    );
    if (run === null) return { outcome: "SKIPPED" };

    const cancellation = new AbortController();
    const signal =
      workerSignal === undefined
        ? cancellation.signal
        : AbortSignal.any([workerSignal, cancellation.signal]);
    let checking = false;
    const timer = setInterval(() => {
      if (checking || cancellation.signal.aborted) return;
      checking = true;
      void this.maintainLease(run.id, owner, cancellation).finally(() => {
        checking = false;
      });
    }, this.options.cancellationPollMs);

    try {
      if (await this.runs.isCancellationRequested(run.id)) cancellation.abort();
      const result = await this.executor.execute(run, signal);
      if (result.status === "WAITING_APPROVAL") {
        await this.runs.pauseForApproval(run.id, owner, result.plan);
        return { outcome: "COMPLETED", status: "WAITING_APPROVAL" };
      }
      if (await this.runs.isCancellationRequested(run.id)) {
        const cancelled = cancelledResult(run.id, new Error("Cancellation was requested."));
        const persisted = await this.runs.complete(run.id, owner, cancelled);
        return { outcome: "COMPLETED", status: persisted.status };
      }
      if (result.status === "CANCELLED") {
        throw new DevflowError({
          code: "INTERNAL_ERROR",
          message: "Execution stopped without a persisted user cancellation request.",
          retryable: true,
        });
      }
      const persisted = await this.runs.complete(run.id, owner, result);
      return { outcome: "COMPLETED", status: persisted.status as RunResult["status"] };
    } catch (error) {
      const cancelled = await this.runs.isCancellationRequested(run.id);
      if (cancelled) {
        const result = cancelledResult(run.id, error);
        const persisted = await this.runs.complete(run.id, owner, result);
        return { outcome: "COMPLETED", status: persisted.status as RunResult["status"] };
      }

      const normalized = toDevflowError(error, {
        code: "INTERNAL_ERROR",
        message: "Worker execution failed.",
        retryable: true,
      });
      const attempts = job.opts.attempts ?? 1;
      const hasRetry = normalized.retryable && job.attemptsMade + 1 < attempts;
      if (hasRetry) {
        await this.runs.releaseForRetry(run.id, owner, normalized);
        throw error;
      }

      const result = failedResult(run.id, normalized);
      const persisted = await this.runs.complete(run.id, owner, result);
      return { outcome: "COMPLETED", status: persisted.status };
    } finally {
      clearInterval(timer);
    }
  }

  private async maintainLease(
    runId: string,
    owner: string,
    cancellation: AbortController,
  ): Promise<void> {
    try {
      if (await this.runs.isCancellationRequested(runId)) {
        cancellation.abort();
        return;
      }
      if (!(await this.runs.renewLease(runId, owner, this.options.leaseMs))) {
        cancellation.abort();
      }
    } catch {
      cancellation.abort();
    }
  }
}

function cancelledResult(runId: string, error: unknown): RunResult {
  const normalized = toDevflowError(error, {
    code: "CANCELLED",
    message: "Run execution was cancelled.",
  });
  return {
    runId,
    status: "CANCELLED",
    metrics: emptyMetrics(),
    error: new DevflowError({ code: "CANCELLED", message: normalized.message }).toJSON(),
  };
}

function failedResult(runId: string, error: unknown): RunResult {
  const normalized = toDevflowError(error, {
    code: "INTERNAL_ERROR",
    message: "Worker run execution failed.",
  });
  return {
    runId,
    status: "FAILED",
    metrics: emptyMetrics(),
    error: normalized.toJSON(),
  };
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
