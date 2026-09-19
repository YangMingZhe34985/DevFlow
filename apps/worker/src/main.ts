import { randomUUID } from "node:crypto";

import { PrismaDatabaseAdapter } from "@devflow/database";
import { type RunJob } from "@devflow/shared";
import { Worker } from "bullmq";
import { Redis } from "ioredis";

import { loadWorkerEnvironment } from "./config/env.js";
import { startHealthServer, stopHealthServer } from "./health/server.js";
import { BullRunQueue } from "./queue/bull-run-queue.js";
import { ApprovalWorkflowRunExecutor } from "./runs/approval-workflow-run-executor.js";
import { RunProcessor } from "./runs/run.processor.js";
import { RunRecovery } from "./runs/run-recovery.js";

const environment = loadWorkerEnvironment();
const database = PrismaDatabaseAdapter.fromConnectionString(environment.DATABASE_URL);
const redis = new Redis(environment.REDIS_URL, { maxRetriesPerRequest: null });
const runQueue = new BullRunQueue(environment.RUN_QUEUE_NAME, redis);
const executor = new ApprovalWorkflowRunExecutor(database, environment);
const processor = new RunProcessor(database.runs, executor, {
  workerId: `worker-${process.pid}-${randomUUID()}`,
  leaseMs: environment.WORKER_LEASE_MS,
  cancellationPollMs: environment.WORKER_CANCEL_POLL_MS,
});

let shuttingDown = false;
let ready = false;
const queueWorker = new Worker<RunJob>(
  environment.RUN_QUEUE_NAME,
  async (job, _token, signal) => await processor.process(job, signal),
  {
    connection: redis,
    concurrency: environment.WORKER_CONCURRENCY,
    lockDuration: environment.WORKER_LEASE_MS,
    maxStalledCount: 2,
  },
);
queueWorker.on("failed", (job, error) => {
  console.error(`Run job ${job?.id ?? "unknown"} failed: ${error.message}`);
});
queueWorker.on("error", (error) => {
  ready = false;
  console.error(`Queue worker error: ${error.message}`);
});

const healthServer = await startHealthServer(environment.WORKER_HEALTH_PORT, () => ({
  ready: ready && !shuttingDown,
  checks: {
    shutdown: shuttingDown ? "in-progress" : "no",
    database: ready ? "ok" : "not-ready",
    redis: ready ? "ok" : "not-ready",
    queueWorker: ready ? "ok" : "not-ready",
  },
}));

await database.connect();
await Promise.all([database.ping(), runQueue.ping(), queueWorker.waitUntilReady()]);
const recovery = new RunRecovery(database.runs, runQueue);
await recovery.recover();
ready = true;

const recoveryTimer = setInterval(() => {
  if (shuttingDown) return;
  void recovery.recover().catch((error: unknown) => {
    console.error(`Run recovery failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}, environment.WORKER_RECOVERY_INTERVAL_MS);
recoveryTimer.unref();

console.info(`DevFlow worker health probe listening on port ${environment.WORKER_HEALTH_PORT}.`);
console.info(`DevFlow worker consuming queue '${environment.RUN_QUEUE_NAME}'.`);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  clearInterval(recoveryTimer);
  console.info(`Received ${signal}; stopping worker.`);
  await Promise.allSettled([queueWorker.close(), runQueue.close(), stopHealthServer(healthServer)]);
  await Promise.allSettled([database.disconnect(), redis.quit()]);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
