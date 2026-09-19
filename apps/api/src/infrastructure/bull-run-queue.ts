import { Queue } from "bullmq";
import { Redis } from "ioredis";

import { RunJobSchema, type RunJob, type RunQueuePort } from "@devflow/shared";

export class BullRunQueue implements RunQueuePort {
  private readonly redis: Redis;
  private readonly queue: Queue<RunJob>;

  constructor(queueName: string, redisUrl: string) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<RunJob>(queueName, { connection: this.redis });
  }

  async enqueue(input: RunJob): Promise<void> {
    const job = RunJobSchema.parse(input);
    await this.queue.add("execute-run", job, {
      jobId: jobId(job),
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 604_800, count: 10_000 },
    });
  }

  async cancel(runId: string, dispatchRevision = 0): Promise<boolean> {
    const job = await this.queue.getJob(jobId({ version: 1, runId, dispatchRevision }));
    if (job === undefined) return false;
    const state = await job.getState();
    if (!["waiting", "delayed", "paused", "prioritized"].includes(state)) return false;
    await job.remove();
    return true;
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.redis.quit();
  }
}

function jobId(job: RunJob): string {
  return `${job.runId}-${String(job.dispatchRevision ?? 0)}`;
}
