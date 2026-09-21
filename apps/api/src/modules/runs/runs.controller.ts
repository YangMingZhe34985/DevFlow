import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Sse,
  type MessageEvent,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { z } from "zod";
import { fileURLToPath } from "node:url";

import type { CreateRunInput, DatabaseAdapter } from "@devflow/database";
import {
  captureLocalRepositorySnapshot,
  encodeLocalRepositorySnapshot,
  LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME,
  localRepositorySnapshotMetadata,
  resolveLocalFilesystemPath,
} from "@devflow/sandbox";
import type { RunQueuePort } from "@devflow/shared";

import { IdSchema, requiredRecord } from "../../common/validation.js";
import { DATABASE, RUN_QUEUE } from "../../infrastructure/tokens.js";
import { RunEventStreamService } from "./run-event-stream.service.js";

const CreateRunSchema = z.strictObject({
  taskId: IdSchema,
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
  modelProvider: z.string().trim().min(1).max(100).optional(),
  modelName: z.string().trim().min(1).max(200).optional(),
  maxSteps: z.number().int().min(1).max(200).optional(),
  maxTestRetries: z.number().int().min(0).max(20).optional(),
  maxReviewRetries: z.number().int().min(0).max(10).optional(),
});

const CursorSchema = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d*)$/, "Event cursor must be a non-negative integer.")
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(2_147_483_647));

const LimitSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d*$/, "Event limit must be a positive integer.")
  .transform(Number)
  .pipe(z.number().int().min(1).max(500));

const PROJECT_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

@Controller("runs")
export class RunsController {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseAdapter,
    @Inject(RUN_QUEUE) private readonly runQueue: RunQueuePort,
    @Inject(RunEventStreamService) private readonly eventStream: RunEventStreamService,
  ) {}

  @Post()
  async create(@Body() body: unknown) {
    const input = CreateRunSchema.parse(body);
    const existing =
      input.idempotencyKey === undefined
        ? null
        : await this.database.runs.findByIdempotencyKey(input.idempotencyKey);
    // An idempotent replay must not re-read a mutable (or since removed) host
    // repository. Calling create still validates that all immutable Run options
    // match the original request.
    const initialArtifact =
      existing === null
        ? await captureInitialLocalSnapshot(this.database, input.taskId)
        : undefined;
    const persisted = await this.database.runs.create({
      ...input,
      ...(initialArtifact === undefined ? {} : { initialArtifact }),
    });
    if (persisted.run.status === "QUEUED") {
      await this.runQueue.enqueue({
        version: 1,
        runId: persisted.run.id,
        dispatchRevision: persisted.run.dispatchRevision,
      });
    }
    return persisted;
  }

  @Get()
  async list(@Query("taskId") rawTaskId?: string) {
    const taskId = rawTaskId === undefined ? undefined : IdSchema.parse(rawTaskId);
    return await this.database.runs.list(taskId);
  }

  @Get(":id/events")
  async listEvents(
    @Param("id") rawId: string,
    @Query("afterSequence") rawAfterSequence?: string,
    @Query("limit") rawLimit?: string,
  ) {
    const id = IdSchema.parse(rawId);
    await this.requireRun(id);
    const afterSequence = CursorSchema.parse(rawAfterSequence ?? "0");
    const limit = LimitSchema.parse(rawLimit ?? "100");
    const page = await this.database.events.list(id, {
      afterSequence,
      limit: limit + 1,
    });
    const hasMore = page.length > limit;
    const events = hasMore ? page.slice(0, limit) : page;
    return {
      events,
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
      hasMore,
    };
  }

  @Sse(":id/events/stream")
  @Header("Cache-Control", "no-cache, no-transform")
  @Header("X-Accel-Buffering", "no")
  async streamEvents(
    @Param("id") rawId: string,
    @Headers("last-event-id") lastEventId?: string,
    @Query("afterSequence") rawAfterSequence?: string,
  ): Promise<Observable<MessageEvent>> {
    const id = IdSchema.parse(rawId);
    await this.requireRun(id);
    return this.eventStream.stream(id, resolveEventCursor(lastEventId, rawAfterSequence));
  }

  @Get(":id/detail")
  async detail(@Param("id") rawId: string) {
    const id = IdSchema.parse(rawId);
    return requiredRecord(await this.database.runs.findDetail(id), "Run", id);
  }

  @Get(":id")
  async get(@Param("id") rawId: string) {
    const id = IdSchema.parse(rawId);
    return requiredRecord(await this.database.runs.findById(id), "Run", id);
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  async cancel(@Param("id") rawId: string) {
    const id = IdSchema.parse(rawId);
    const run = await this.database.runs.requestCancellation(id);
    await this.runQueue.cancel(id, run.dispatchRevision);
    return run;
  }

  private async requireRun(id: string): Promise<void> {
    requiredRecord(await this.database.runs.findById(id), "Run", id);
  }
}

export async function captureInitialLocalSnapshot(
  database: DatabaseAdapter,
  taskId: string,
): Promise<CreateRunInput["initialArtifact"]> {
  const task = requiredRecord(await database.tasks.findById(taskId), "Task", taskId);
  const repository = requiredRecord(
    await database.repositories.findById(task.repositoryId),
    "Repository",
    task.repositoryId,
  );
  if (repository.sourceKind !== "LOCAL") return undefined;
  const sourcePath = resolveLocalFilesystemPath(repository.sourceUri, PROJECT_ROOT);
  const configuredRoot = process.env.DEVFLOW_LOCAL_REPOSITORY_ROOT;
  const snapshot = await captureLocalRepositorySnapshot({
    sourceUri: repository.sourceUri,
    workspaceRoot:
      configuredRoot === undefined || configuredRoot.trim().length === 0
        ? sourcePath
        : resolveLocalFilesystemPath(configuredRoot, PROJECT_ROOT),
    ...(task.baseRef === undefined ? {} : { baseRef: task.baseRef }),
    ...(task.baseCommitSha === undefined ? {} : { baseCommit: task.baseCommitSha }),
  });
  return {
    kind: "OTHER",
    name: LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME,
    mimeType: "application/vnd.devflow.local-snapshot+json+gzip",
    content: encodeLocalRepositorySnapshot(snapshot),
    metadata: localRepositorySnapshotMetadata(snapshot),
  };
}

export function resolveEventCursor(
  lastEventId: string | undefined,
  rawAfterSequence: string | undefined,
): number {
  const headerCursor = lastEventId?.trim();
  return CursorSchema.parse(
    headerCursor === undefined || headerCursor.length === 0
      ? (rawAfterSequence ?? "0")
      : headerCursor,
  );
}
