import { randomUUID } from "node:crypto";

import type { RunExecutionRecord, RunRepository } from "@devflow/database";
import { DevflowError, type RunQueuePort, type RunResult } from "@devflow/shared";
import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { RunExecutionPort } from "../src/runs/run-execution.js";
import { RunProcessor } from "../src/runs/run.processor.js";
import { RunRecovery } from "../src/runs/run-recovery.js";

describe("RunProcessor", () => {
  it("executes a run only once when the same job is consumed concurrently", async () => {
    const run = executionRecord();
    let claimed = false;
    const runs = runRepository({
      claim: vi.fn(async () => {
        if (claimed) return null;
        claimed = true;
        return run;
      }),
    });
    const executor: RunExecutionPort = {
      execute: vi.fn(async () => succeeded(run.id)),
    };
    const processor = createProcessor(runs, executor);

    const results = await Promise.all([
      processor.process(job(run.id)),
      processor.process(job(run.id)),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["COMPLETED", "SKIPPED"]);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(runs.complete).toHaveBeenCalledTimes(1);
  });

  it("releases infrastructure failures for BullMQ retry", async () => {
    const run = executionRecord();
    const runs = runRepository({ claim: vi.fn(async () => run) });
    const failure = new Error("temporary infrastructure failure");
    const executor: RunExecutionPort = {
      execute: vi.fn(async () => await Promise.reject(failure)),
    };
    const processor = createProcessor(runs, executor);

    await expect(processor.process(job(run.id, 0, 3))).rejects.toBe(failure);
    expect(runs.releaseForRetry).toHaveBeenCalledOnce();
    expect(runs.complete).not.toHaveBeenCalled();
  });

  it("completes a non-retryable sandbox setup failure with structured terminal data", async () => {
    const run = executionRecord();
    const runs = runRepository({ claim: vi.fn(async () => run) });
    const executor: RunExecutionPort = {
      execute: vi.fn(async () => {
        throw new DevflowError({
          code: "SANDBOX_FAILED",
          message: "Failed to restore LOCAL snapshot.",
          details: { stage: "EXECUTE" },
        });
      }),
    };

    await expect(createProcessor(runs, executor).process(job(run.id, 0, 3))).resolves.toMatchObject(
      {
        outcome: "COMPLETED",
        status: "FAILED",
      },
    );
    expect(runs.releaseForRetry).not.toHaveBeenCalled();
    expect(runs.complete).toHaveBeenCalledWith(
      run.id,
      expect.any(String),
      expect.objectContaining({
        status: "FAILED",
        error: expect.objectContaining({
          code: "SANDBOX_FAILED",
          message: "Failed to restore LOCAL snapshot.",
          details: { stage: "EXECUTE" },
        }),
      }),
    );
  });

  it("parks a generated plan without completing the run", async () => {
    const run = { ...executionRecord(), currentStage: "GENERATE_PLAN" as const };
    const runs = runRepository({ claim: vi.fn(async () => run) });
    const plan = {
      summary: "Review the implementation plan",
      steps: [{ id: "one", title: "Inspect", description: "Inspect tests first." }],
    };
    const executor: RunExecutionPort = {
      execute: vi.fn(async () => ({ status: "WAITING_APPROVAL" as const, plan })),
    };

    await expect(createProcessor(runs, executor).process(job(run.id))).resolves.toMatchObject({
      outcome: "COMPLETED",
      status: "WAITING_APPROVAL",
    });
    expect(runs.pauseForApproval).toHaveBeenCalledWith(run.id, expect.any(String), plan);
    expect(runs.complete).not.toHaveBeenCalled();
  });

  it("parks a GitHub side-effect approval without completing the run", async () => {
    const run = { ...executionRecord(), currentStage: "GENERATE_DIFF" as const };
    const runs = runRepository({ claim: vi.fn(async () => run) });
    const approval = {
      kind: "GITHUB_PUSH" as const,
      request: { branchName: `devflow/run-${run.id}` },
      publication: {
        repository: { owner: "devflow", name: "fixture" },
        baseCommit: "a".repeat(40),
        baseBranch: "main",
        branchName: `devflow/run-${run.id}`,
        pushOperationKey: `${run.id}:push:0`,
        changesArtifactId: randomUUID(),
      },
    };
    const executor: RunExecutionPort = {
      execute: vi.fn(async () => ({
        status: "WAITING_APPROVAL" as const,
        approvalKind: "GITHUB" as const,
        approval,
      })),
    };

    await expect(createProcessor(runs, executor).process(job(run.id))).resolves.toMatchObject({
      outcome: "COMPLETED",
      status: "WAITING_APPROVAL",
    });
    expect(runs.pauseForGitHubApproval).toHaveBeenCalledWith(run.id, expect.any(String), approval);
    expect(runs.complete).not.toHaveBeenCalled();
  });

  it("aborts active execution after a persisted cancellation request", async () => {
    const run = executionRecord();
    const cancellationChecks = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const runs = runRepository({
      claim: vi.fn(async () => run),
      isCancellationRequested: cancellationChecks,
      complete: vi.fn(async (_id, _owner, result: RunResult) => ({
        ...run,
        status: result.status,
        currentStage: "CANCELLED",
        result,
      })),
    });
    const executor: RunExecutionPort = {
      execute: vi.fn(
        async (_run, signal) =>
          await new Promise<RunResult>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      ),
    };
    const processor = new RunProcessor(runs, executor, {
      workerId: "test-worker",
      leaseMs: 1_000,
      cancellationPollMs: 5,
    });

    await expect(processor.process(job(run.id))).resolves.toMatchObject({
      outcome: "COMPLETED",
      status: "CANCELLED",
    });
    expect(runs.complete).toHaveBeenCalledOnce();
  });
});

describe("RunRecovery", () => {
  it("re-enqueues queued and expired leased runs", async () => {
    const first = executionRecord();
    const second = executionRecord();
    const finalizeExpiredCancellations = vi.fn(async () => 1);
    const runs = runRepository({
      finalizeExpiredCancellations,
      listRecoverable: vi.fn(async () => [first, second]),
    });
    const queue: RunQueuePort = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => false),
      ping: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    await expect(new RunRecovery(runs, queue).recover()).resolves.toBe(2);
    expect(finalizeExpiredCancellations).toHaveBeenCalledOnce();
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });
});

function createProcessor(runs: RunRepository, executor: RunExecutionPort): RunProcessor {
  return new RunProcessor(runs, executor, {
    workerId: "test-worker",
    leaseMs: 10_000,
    cancellationPollMs: 1_000,
  });
}

function job(runId: string, attemptsMade = 0, attempts = 1): Job<unknown> {
  return {
    id: runId,
    data: { version: 1, runId },
    attemptsMade,
    opts: { attempts },
  } as Job<unknown>;
}

function executionRecord(): RunExecutionRecord {
  const runId = randomUUID();
  const taskId = randomUUID();
  const repositoryId = randomUUID();
  const now = new Date().toISOString();
  return {
    id: runId,
    taskId,
    status: "RUNNING",
    currentStage: "EXECUTE",
    maxSteps: 5,
    maxTestRetries: 1,
    maxReviewRetries: 1,
    dispatchRevision: 0,
    retryCount: 0,
    executionOwner: "owner",
    cancellationRequested: false,
    createdAt: now,
    updatedAt: now,
    task: {
      id: taskId,
      repositoryId,
      title: "Test run",
      description: "Exercise worker semantics",
      status: "OPEN",
      createdAt: now,
      updatedAt: now,
    },
    repository: {
      id: repositoryId,
      name: "fixture",
      sourceKind: "LOCAL",
      sourceUri: ".",
      createdAt: now,
      updatedAt: now,
    },
  };
}

function runRepository(overrides: Partial<RunRepository> = {}): RunRepository {
  const run = executionRecord();
  return {
    create: vi.fn(async () => ({ run, created: true })),
    list: vi.fn(async () => []),
    findById: vi.fn(async () => run),
    findExecutionById: vi.fn(async () => run),
    requestCancellation: vi.fn(async () => run),
    claim: vi.fn(async () => run),
    renewLease: vi.fn(async () => true),
    isCancellationRequested: vi.fn(async () => false),
    complete: vi.fn(async (_id, _owner, result) => ({
      ...run,
      status: result.status,
      currentStage: result.status === "SUCCEEDED" ? "DONE" : "FAILED",
      result,
    })),
    pauseForApproval: vi.fn(async () => ({
      run: { ...run, status: "WAITING_APPROVAL", currentStage: "WAITING_APPROVAL" },
      approval: {
        id: randomUUID(),
        runId: run.id,
        kind: "PLAN",
        status: "PENDING",
        request: {},
        requestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    })),
    pauseForGitHubApproval: vi.fn(async () => ({
      run: { ...run, status: "WAITING_APPROVAL", currentStage: "WAITING_PUSH_APPROVAL" },
      approval: {
        id: randomUUID(),
        runId: run.id,
        kind: "GITHUB_PUSH",
        status: "PENDING",
        request: {},
        requestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    })),
    releaseForRetry: vi.fn(async () => ({ ...run, status: "QUEUED" })),
    listRecoverable: vi.fn(async () => []),
    transition: vi.fn(async () => await Promise.reject(new Error("not used"))),
    ...overrides,
  } as RunRepository;
}

function succeeded(runId: string): RunResult {
  return {
    runId,
    status: "SUCCEEDED",
    summary: "done",
    metrics: {
      durationMs: 1,
      steps: 1,
      modelCalls: 1,
      toolCalls: 0,
      retries: 0,
      modelLatencyMs: 1,
      toolLatencyMs: 0,
      tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  };
}
