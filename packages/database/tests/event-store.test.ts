import { describe, expect, it, vi } from "vitest";

import type { RunResult } from "@devflow/shared";

import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaDatabaseAdapter } from "../src/prisma-adapter.js";

describe("Prisma event store", () => {
  it("reads a run event log strictly after the cursor in sequence order", async () => {
    const occurredAt = new Date("2026-09-19T01:02:03.000Z");
    const findMany = vi.fn(async () => [
      {
        id: "00000000-0000-4000-8000-000000000003",
        runId: "00000000-0000-4000-8000-000000000001",
        stepId: null,
        toolCallId: null,
        sequence: 3,
        type: "STEP_COMPLETED",
        level: "INFO" as const,
        payload: { stage: "TEST" },
        occurredAt,
      },
    ]);
    const client = { event: { findMany } } as unknown as PrismaClient;
    const database = new PrismaDatabaseAdapter(client);

    const events = await database.events.list("00000000-0000-4000-8000-000000000001", {
      afterSequence: 2,
      limit: 25,
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        runId: "00000000-0000-4000-8000-000000000001",
        sequence: { gt: 2 },
      },
      orderBy: { sequence: "asc" },
      take: 25,
    });
    expect(events).toEqual([
      {
        schemaVersion: 1,
        eventId: "00000000-0000-4000-8000-000000000003",
        runId: "00000000-0000-4000-8000-000000000001",
        sequence: 3,
        occurredAt: "2026-09-19T01:02:03.000Z",
        type: "STEP_COMPLETED",
        level: "INFO",
        payload: { stage: "TEST" },
      },
    ]);
  });

  it("rejects invalid cursors and unbounded page sizes before querying Prisma", async () => {
    const findMany = vi.fn();
    const client = { event: { findMany } } as unknown as PrismaClient;
    const database = new PrismaDatabaseAdapter(client);

    await expect(database.events.list("run", { afterSequence: -1 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(database.events.list("run", { limit: 1_001 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("persists a structured terminal failure event in the same transaction as Run failure", async () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const owner = "worker:test";
    const now = new Date("2026-09-19T01:02:03.000Z");
    const current = prismaRun({
      id: runId,
      status: "RUNNING",
      currentStage: "EXECUTE",
      executionOwner: owner,
      startedAt: now,
    });
    const terminal = prismaRun({
      ...current,
      status: "FAILED",
      currentStage: "FAILED",
      executionOwner: null,
      finishedAt: now,
      failureCode: "SANDBOX_FAILED",
      failureMessage: "Failed to create Docker sandbox.",
    });
    const eventCreate = vi.fn(async () => undefined);
    const transaction = {
      run: {
        findFirst: vi.fn(async () => current),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({ nextEventSequence: 1, currentStage: "FAILED" })),
        findUnique: vi.fn(async () => terminal),
      },
      event: { create: eventCreate },
      step: { updateMany: vi.fn(async () => ({ count: 0 })) },
      toolCall: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const client = {
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) => await callback(transaction),
      ),
    } as unknown as PrismaClient;
    const database = new PrismaDatabaseAdapter(client);
    const result: RunResult = {
      runId,
      status: "FAILED",
      metrics: emptyMetrics(),
      error: {
        code: "SANDBOX_FAILED",
        message: "Failed to create Docker sandbox.",
        retryable: false,
        details: { operation: "create" },
      },
    };

    await expect(database.runs.complete(runId, owner, result)).resolves.toMatchObject({
      status: "FAILED",
      currentStage: "FAILED",
      result: { error: { code: "SANDBOX_FAILED" } },
    });
    expect(client.$transaction).toHaveBeenCalledOnce();
    expect(eventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId,
        sequence: 1,
        type: "RUN_FAILED",
        level: "ERROR",
        payload: expect.objectContaining({
          status: "FAILED",
          stage: "EXECUTE",
          terminalStage: "FAILED",
          code: "SANDBOX_FAILED",
          message: "Failed to create Docker sandbox.",
        }),
      }),
    });
  });

  it("atomically emits RUN_CANCELLED when a queued Run becomes terminal", async () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const current = prismaRun({ id: runId, status: "QUEUED", currentStage: "START" });
    const terminal = prismaRun({
      ...current,
      status: "CANCELLED",
      currentStage: "CANCELLED",
      failureCode: "CANCELLED",
      failureMessage: "Run was cancelled before execution completed.",
      cancelRequestedAt: new Date("2026-09-19T01:02:03.000Z"),
      finishedAt: new Date("2026-09-19T01:02:03.000Z"),
    });
    const eventCreate = vi.fn(async () => undefined);
    const transaction = {
      run: {
        findUnique: vi.fn(async () => current),
        update: vi.fn(async (input: { select?: unknown }) =>
          input.select === undefined
            ? terminal
            : { nextEventSequence: 1, currentStage: "CANCELLED" },
        ),
      },
      event: { create: eventCreate },
      step: { updateMany: vi.fn(async () => ({ count: 0 })) },
      toolCall: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const client = {
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) => await callback(transaction),
      ),
    } as unknown as PrismaClient;
    const database = new PrismaDatabaseAdapter(client);

    await expect(database.runs.requestCancellation(runId)).resolves.toMatchObject({
      status: "CANCELLED",
      currentStage: "CANCELLED",
      result: { error: { code: "CANCELLED" } },
    });
    expect(eventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "RUN_CANCELLED",
        sequence: 1,
        payload: expect.objectContaining({
          stage: "START",
          code: "CANCELLED",
          message: "Run was cancelled before execution completed.",
        }),
      }),
    });
  });

  it("atomically finalizes cancellation after a crashed Worker's lease expires", async () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const now = new Date("2026-09-19T01:02:03.000Z");
    const eventCreate = vi.fn(async () => undefined);
    const transaction = {
      run: {
        findMany: vi.fn(async () => [{ id: runId, currentStage: "TEST" }]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({ nextEventSequence: 1, currentStage: "CANCELLED" })),
      },
      event: { create: eventCreate },
      step: { updateMany: vi.fn(async () => ({ count: 0 })) },
      toolCall: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const client = {
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) => await callback(transaction),
      ),
    } as unknown as PrismaClient;
    const database = new PrismaDatabaseAdapter(client);

    await expect(database.runs.finalizeExpiredCancellations?.(now)).resolves.toBe(1);
    expect(transaction.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED", currentStage: "CANCELLED" }),
      }),
    );
    expect(eventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "RUN_CANCELLED",
        sequence: 1,
        payload: expect.objectContaining({
          stage: "TEST",
          code: "CANCELLED",
          terminalStage: "CANCELLED",
        }),
      }),
    });
  });

  it("rejects terminal transitions whose status, stage, and event disagree", async () => {
    const transaction = vi.fn();
    const database = new PrismaDatabaseAdapter({
      $transaction: transaction,
    } as unknown as PrismaClient);

    await expect(
      database.runs.transition({
        runId: "00000000-0000-4000-8000-000000000001",
        expectedStatus: "RUNNING",
        status: "FAILED",
        currentStage: "FAILED",
        event: {
          runId: "00000000-0000-4000-8000-000000000001",
          type: "STEP_COMPLETED",
          occurredAt: "2026-09-19T01:02:03.000Z",
          payload: {},
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("persists and restores extended Run metrics without changing the legacy columns", async () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const owner = "worker:test";
    const metrics: RunResult["metrics"] = {
      ...emptyMetrics(),
      durationMs: 20,
      steps: 2,
      modelCalls: 2,
      toolCalls: 3,
      toolExecutions: 2,
      cacheHits: 1,
      reasoningTokens: 7,
      modelLatencyMs: 11,
      toolLatencyMs: 4,
      tokenUsage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        reasoningTokens: 7,
      },
      control: {
        duplicateToolCalls: 1,
        contextCacheHits: 1,
        structuredOutputFailures: 0,
        structuredOutputRepairAttempts: 0,
        stalledDetections: 0,
      },
      stages: {
        EXECUTE: {
          steps: 2,
          attempts: 1,
          modelCalls: 2,
          toolCalls: 3,
          toolExecutions: 2,
          cacheHits: 1,
          modelLatencyMs: 11,
          toolLatencyMs: 4,
          wallLatencyMs: 20,
          reasoningTokens: 7,
          formatRepairCalls: 0,
          tokenUsage: {
            inputTokens: 12,
            outputTokens: 8,
            totalTokens: 20,
            reasoningTokens: 7,
          },
        },
      },
    };
    const current = prismaRun({ id: runId, executionOwner: owner });
    const terminal = prismaRun({
      ...current,
      status: "SUCCEEDED",
      currentStage: "DONE",
      executionOwner: null,
      metricsDetail: metrics,
      finishedAt: new Date("2026-09-19T01:02:03.000Z"),
    });
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const transaction = {
      run: {
        findFirst: vi.fn(async () => current),
        updateMany,
        update: vi.fn(async () => ({ nextEventSequence: 1, currentStage: "DONE" })),
        findUnique: vi.fn(async () => terminal),
      },
      event: { create: vi.fn(async () => undefined) },
      step: { updateMany: vi.fn(async () => ({ count: 0 })) },
      toolCall: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const database = new PrismaDatabaseAdapter({
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) => await callback(transaction),
      ),
    } as unknown as PrismaClient);

    const completed = await database.runs.complete(runId, owner, {
      runId,
      status: "SUCCEEDED",
      metrics,
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stepCount: 2,
          modelCallCount: 2,
          toolCallCount: 3,
          metricsDetail: metrics,
        }),
      }),
    );
    expect(completed.result?.metrics).toEqual(metrics);
  });

  it("uses expectedStage as an optional transition compare-and-swap guard", async () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const transaction = {
      run: {
        updateMany,
        update: vi.fn(async () => ({ nextEventSequence: 1, currentStage: "TEST" })),
        findUnique: vi.fn(async () =>
          prismaRun({ id: runId, status: "RUNNING", currentStage: "TEST" }),
        ),
      },
      event: { create: vi.fn(async () => undefined) },
      step: {},
      toolCall: {},
    };
    const database = new PrismaDatabaseAdapter({
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) => await callback(transaction),
      ),
    } as unknown as PrismaClient);

    await database.runs.transition({
      runId,
      expectedStatus: "RUNNING",
      expectedStage: "EXECUTE",
      status: "RUNNING",
      currentStage: "TEST",
      event: {
        runId,
        type: "TEST_STARTED",
        occurredAt: "2026-09-19T01:02:03.000Z",
        payload: {},
      },
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: runId, status: "RUNNING", currentStage: "EXECUTE" },
      data: { status: "RUNNING", currentStage: "TEST" },
    });
  });
});

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

function prismaRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date("2026-09-19T01:02:03.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000001",
    taskId: "00000000-0000-4000-8000-000000000002",
    idempotencyKey: null,
    status: "RUNNING",
    currentStage: "EXECUTE",
    baseCommitSha: null,
    modelProvider: null,
    modelName: null,
    modelConfig: null,
    maxSteps: 25,
    maxTestRetries: 3,
    maxReviewRetries: 1,
    dispatchRevision: 0,
    stepCount: 0,
    retryCount: 0,
    modelCallCount: 0,
    toolCallCount: 0,
    durationMs: 0,
    modelLatencyMs: 0,
    toolLatencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: null,
    metricsDetail: null,
    startedAt: null,
    finishedAt: null,
    failureCode: null,
    failureMessage: null,
    failureDetails: null,
    summary: null,
    executionOwner: null,
    leaseExpiresAt: null,
    cancelRequestedAt: null,
    nextEventSequence: 0,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
