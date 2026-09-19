import { z } from "zod";

import { EntityIdSchema } from "./ids.js";

export const RunJobSchema = z.object({
  version: z.literal(1),
  runId: EntityIdSchema,
  dispatchRevision: z.number().int().nonnegative().optional(),
});
export type RunJob = z.infer<typeof RunJobSchema>;

export const RUN_QUEUE_NAME = "devflow-runs";

export interface RunQueuePort {
  enqueue(job: RunJob): Promise<void>;
  cancel(runId: string, dispatchRevision?: number): Promise<boolean>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
