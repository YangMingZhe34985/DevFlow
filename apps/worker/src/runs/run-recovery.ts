import type { RunRepository } from "@devflow/database";
import type { RunQueuePort } from "@devflow/shared";

export class RunRecovery {
  constructor(
    private readonly runs: RunRepository,
    private readonly queue: RunQueuePort,
  ) {}

  async recover(): Promise<number> {
    await this.runs.finalizeExpiredCancellations?.();
    const recoverable = await this.runs.listRecoverable();
    await Promise.all(
      recoverable.map(async (run) => {
        await this.queue.enqueue({
          version: 1,
          runId: run.id,
          dispatchRevision: run.dispatchRevision,
        });
      }),
    );
    return recoverable.length;
  }
}
