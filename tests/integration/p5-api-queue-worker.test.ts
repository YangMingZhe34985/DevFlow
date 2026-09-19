import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import { PrismaDatabaseAdapter, type RunExecutionRecord } from "@devflow/database";
import type { RunResult } from "@devflow/shared";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "../../apps/api/src/app.module.js";
import { ApiExceptionFilter } from "../../apps/api/src/common/api-exception.filter.js";
import { BullRunQueue as ApiRunQueue } from "../../apps/api/src/infrastructure/bull-run-queue.js";
import { loadWorkerEnvironment } from "../../apps/worker/src/config/env.js";
import { BullRunQueue as WorkerRunQueue } from "../../apps/worker/src/queue/bull-run-queue.js";
import {
  DockerAgentRunExecutor,
  type LanguageModelFactory,
} from "../../apps/worker/src/runs/docker-agent-run-executor.js";
import type { RunExecutionPort } from "../../apps/worker/src/runs/run-execution.js";
import { RunProcessor } from "../../apps/worker/src/runs/run.processor.js";
import { RunRecovery } from "../../apps/worker/src/runs/run-recovery.js";

const integrationEnabled = process.env.DEVFLOW_P5_INTEGRATION === "1";
const integrationDescribe = integrationEnabled ? describe : describe.skip;

integrationDescribe("P4-P5 API, persistence and queue", () => {
  const databaseUrl = requiredEnvironment("TEST_DATABASE_URL");
  const redisUrl = requiredEnvironment("TEST_REDIS_URL");
  const queueName = "devflow-runs-test-" + randomUUID();
  const fixturePath = path.resolve("tests/fixtures/calculator-bug");
  let database: PrismaDatabaseAdapter;
  let apiQueue: ApiRunQueue;
  let workerQueue: WorkerRunQueue;
  let workerRedis: Redis;
  let queueWorker: Worker | undefined;
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;
  let stateDirectory: string;
  const executionAttempts = new Map<string, number>();
  const modelCreations = new Map<string, number>();

  beforeAll(async () => {
    database = PrismaDatabaseAdapter.fromConnectionString(databaseUrl);
    await database.connect();
    await database.client.$executeRawUnsafe(
      'TRUNCATE TABLE "Approval", "Artifact", "Event", "ToolCall", "Step", "Run", "Task", "Repository" CASCADE',
    );
    apiQueue = new ApiRunQueue(queueName, redisUrl);
    app = await NestFactory.create(AppModule.register({ database, runQueue: apiQueue }), {
      logger: false,
      forceCloseConnections: true,
    });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = "http://127.0.0.1:" + String(address.port) + "/api/v1";
    stateDirectory = await mkdtemp(path.join(os.tmpdir(), "devflow-p5-state-"));
  }, 120_000);

  afterAll(async () => {
    await queueWorker?.close();
    await workerQueue?.close();
    await workerRedis?.quit();
    await app?.close();
    if (stateDirectory !== undefined) {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }, 120_000);

  it("validates CRUD, transitions and queued cancellation over HTTP", async () => {
    const invalid = await request("POST", "/repositories", { name: "" });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: "VALIDATION_ERROR" });

    const repository = await createRepository();
    const task = await createTask(repository.id, "Queued cancellation");
    const queued = await createRun(task.id, "cancel-" + randomUUID());

    const cancelled = await request("POST", "/runs/" + queued.id + "/cancel");
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ id: queued.id, status: "CANCELLED" });

    const approval = await request("POST", "/approvals", {
      runId: queued.id,
      kind: "PLAN",
      request: { summary: "approve plan" },
    });
    expect(approval.status).toBe(201);
    const approvalId = String(approval.body.id);
    const resolved = await request("POST", "/approvals/" + approvalId + "/resolve", {
      status: "APPROVED",
      actorId: "integration-test",
    });
    expect(resolved.body).toMatchObject({ status: "APPROVED" });
    const duplicateResolution = await request("POST", "/approvals/" + approvalId + "/resolve", {
      status: "REJECTED",
    });
    expect(duplicateResolution.status).toBe(409);

    const completedTask = await request("PATCH", "/tasks/" + task.id, {
      status: "COMPLETED",
    });
    expect(completedTask.body).toMatchObject({ status: "COMPLETED" });
    const invalidTransition = await request("PATCH", "/tasks/" + task.id, {
      status: "CANCELLED",
    });
    expect(invalidTransition.status).toBe(409);
  }, 120_000);

  it("runs API -> BullMQ -> Worker -> Agent/Docker -> PostgreSQL exactly once", async () => {
    await startWorker();
    const repository = await createRepository();
    const task = await createTask(repository.id, "Full Docker Agent");
    const idempotencyKey = "full-" + randomUUID();
    const first = await request("POST", "/runs", {
      taskId: task.id,
      idempotencyKey,
      maxSteps: 4,
    });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    const runId = String((first.body.run as Record<string, unknown>).id);

    const succeeded = await waitForRun(runId, ["SUCCEEDED"]);
    expect(succeeded.result).toMatchObject({
      status: "SUCCEEDED",
      metrics: { modelCalls: 2, toolCalls: 1 },
    });
    expect(await database.client.event.count({ where: { runId } })).toBeGreaterThan(0);

    const duplicate = await request("POST", "/runs", {
      taskId: task.id,
      idempotencyKey,
      maxSteps: 4,
    });
    expect(duplicate.body).toMatchObject({ created: false, run: { id: runId } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(modelCreations.get(runId)).toBe(1);
  }, 180_000);

  it("retries transient failures, cancels active work and recovers expired leases", async () => {
    const repository = await createRepository();

    const retryTask = await createTask(repository.id, "Retry once");
    const retryRun = await createRun(retryTask.id, "retry-" + randomUUID());
    const retried = await waitForRun(retryRun.id, ["SUCCEEDED"]);
    expect(retried.retryCount).toBe(1);
    expect(executionAttempts.get(retryRun.id)).toBe(2);

    const cancelTask = await createTask(repository.id, "Long cancellable run");
    const cancelRun = await createRun(cancelTask.id, "active-cancel-" + randomUUID());
    await waitForRun(cancelRun.id, ["RUNNING"]);
    await request("POST", "/runs/" + cancelRun.id + "/cancel");
    const cancelled = await waitForRun(cancelRun.id, ["CANCELLED"]);
    expect(cancelled.cancellationRequested).toBe(true);

    const recoveryTask = await createTask(repository.id, "Recovered run");
    const persisted = await database.runs.create({
      taskId: recoveryTask.id,
      idempotencyKey: "recovery-" + randomUUID(),
    });
    const stale = await database.runs.claim(persisted.run.id, "dead-worker", 20);
    expect(stale).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await new RunRecovery(database.runs, workerQueue).recover();
    const recovered = await waitForRun(persisted.run.id, ["SUCCEEDED"]);
    expect(recovered.status).toBe("SUCCEEDED");
  }, 180_000);

  async function startWorker(): Promise<void> {
    if (queueWorker !== undefined) return;
    const environment = loadWorkerEnvironment({
      ...process.env,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      RUN_QUEUE_NAME: queueName,
      DEVFLOW_STATE_DIR: stateDirectory,
      DEVFLOW_TIMEOUT_MS: "60000",
      DEVFLOW_SANDBOX_MEMORY_MB: "256",
      DEVFLOW_SANDBOX_PIDS: "64",
      DEVFLOW_SANDBOX_NETWORK_ENABLED: "false",
    });
    const modelFactory: LanguageModelFactory = (run) => {
      modelCreations.set(run.id, (modelCreations.get(run.id) ?? 0) + 1);
      return new FakeLanguageModel([
        fakeModelResponse({
          toolCalls: [{ id: randomUUID(), name: "listFiles", input: { path: "." } }],
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          latencyMs: 3,
        }),
        fakeModelResponse({
          toolCalls: [],
          text: "Inspected the repository in Docker.",
          usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
          latencyMs: 2,
        }),
      ]);
    };
    const dockerExecutor = new DockerAgentRunExecutor(database, environment, modelFactory);
    const compositeExecutor: RunExecutionPort = {
      execute: async (run, signal) => {
        const attempt = (executionAttempts.get(run.id) ?? 0) + 1;
        executionAttempts.set(run.id, attempt);
        if (run.task.title === "Retry once" && attempt === 1) {
          throw new Error("transient test failure");
        }
        if (run.task.title === "Long cancellable run") {
          return await waitUntilCancelled(run, signal);
        }
        if (run.task.title === "Full Docker Agent") {
          return await dockerExecutor.execute(run, signal);
        }
        return succeededResult(run.id);
      },
    };
    const processor = new RunProcessor(database.runs, compositeExecutor, {
      workerId: "integration-" + randomUUID(),
      leaseMs: 5_000,
      cancellationPollMs: 100,
    });
    workerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    workerQueue = new WorkerRunQueue(queueName, workerRedis);
    queueWorker = new Worker(
      queueName,
      async (job, _token, signal) => await processor.process(job, signal),
      {
        connection: workerRedis,
        concurrency: 2,
        lockDuration: 5_000,
        maxStalledCount: 2,
      },
    );
    await queueWorker.waitUntilReady();
  }

  async function createRepository(): Promise<{ id: string }> {
    const response = await request("POST", "/repositories", {
      name: "fixture-" + randomUUID(),
      sourceKind: "LOCAL",
      sourceUri: fixturePath,
      defaultBranch: "main",
    });
    expect(response.status).toBe(201);
    return response.body as { id: string };
  }

  async function createTask(repositoryId: string, title: string): Promise<{ id: string }> {
    const response = await request("POST", "/tasks", {
      repositoryId,
      title,
      description: title,
    });
    expect(response.status).toBe(201);
    return response.body as { id: string };
  }

  async function createRun(taskId: string, idempotencyKey: string): Promise<{ id: string }> {
    const response = await request("POST", "/runs", { taskId, idempotencyKey, maxSteps: 4 });
    expect(response.status).toBe(201);
    return response.body.run as { id: string };
  }

  async function waitForRun(
    runId: string,
    statuses: readonly string[],
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await request("GET", "/runs/" + runId);
      if (statuses.includes(String(response.body.status))) return response.body;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      "Timed out waiting for run " + runId + " to reach " + statuses.join(", ") + ".",
    );
  }

  async function request(
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(baseUrl + endpoint, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: responseBody };
  }
});

function waitUntilCancelled(run: RunExecutionRecord, signal: AbortSignal): Promise<RunResult> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("cancelled " + run.id)), {
      once: true,
    });
  });
}

function succeededResult(runId: string): RunResult {
  return {
    runId,
    status: "SUCCEEDED",
    summary: "completed",
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

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (integrationEnabled && (value === undefined || value.length === 0)) {
    throw new Error("Missing " + name + " for P5 integration test.");
  }
  return value ?? "not-configured";
}
