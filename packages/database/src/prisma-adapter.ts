import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  DevflowError,
  type AgentEvent,
  type AgentPlan,
  type DevflowErrorShape,
  type NewAgentEvent,
  type RunResult,
  type RunStatus,
  type TaskStatus,
  type WorkflowStage,
} from "@devflow/shared";

import {
  Prisma,
  PrismaClient,
  type Approval as PrismaApproval,
  type Artifact as PrismaArtifact,
  type Event as PrismaEvent,
  type Repository as PrismaRepository,
  type Run as PrismaRun,
  type Step as PrismaStep,
  type Task as PrismaTask,
  type ToolCall as PrismaToolCall,
} from "./generated/prisma/client.js";
import type {
  ApprovalRecord,
  ApprovalStore,
  ArtifactRecord,
  ArtifactStore,
  CreateArtifactInput,
  CreateApprovalInput,
  CreateRepositoryInput,
  CreateRunInput,
  CreateTaskInput,
  DatabaseAdapter,
  EventStore,
  PersistedRunTransition,
  RepositoryRecord,
  RepositoryStore,
  ResolveApprovalInput,
  RunExecutionRecord,
  RunDetailRecord,
  RunRecord,
  RunRepository,
  RunTransitionInput,
  TaskRecord,
  TaskStore,
  StepRecord,
  ToolCallRecord,
  UpdateRepositoryInput,
  UpdateTaskInput,
} from "./contracts.js";

type TransactionClient = Prisma.TransactionClient;
type RunWithTaskAndRepository = Prisma.RunGetPayload<{
  include: { task: { include: { repository: true } } };
}>;

export class PrismaDatabaseAdapter implements DatabaseAdapter {
  readonly repositories: RepositoryStore;
  readonly tasks: TaskStore;
  readonly runs: RunRepository;
  readonly approvals: ApprovalStore;
  readonly artifacts: ArtifactStore;
  readonly events: EventStore;

  constructor(readonly client: PrismaClient) {
    this.repositories = new PrismaRepositoryStore(client);
    this.tasks = new PrismaTaskStore(client);
    this.runs = new PrismaRunStore(client);
    this.approvals = new PrismaApprovalStore(client);
    this.artifacts = new PrismaArtifactStore(client);
    this.events = new PrismaEventWriter(client);
  }

  static fromConnectionString(connectionString: string): PrismaDatabaseAdapter {
    const adapter = new PrismaPg({ connectionString });
    return new PrismaDatabaseAdapter(new PrismaClient({ adapter }));
  }

  async connect(): Promise<void> {
    await this.client.$connect();
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }
}

class PrismaRepositoryStore implements RepositoryStore {
  constructor(private readonly client: PrismaClient) {}

  async create(input: CreateRepositoryInput): Promise<RepositoryRecord> {
    return await databaseCall(async () =>
      mapRepository(
        await this.client.repository.create({
          data: {
            name: input.name,
            sourceKind: input.sourceKind,
            sourceUri: input.sourceUri,
            ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
          },
        }),
      ),
    );
  }

  async list(): Promise<readonly RepositoryRecord[]> {
    return await databaseCall(async () =>
      (
        await this.client.repository.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        })
      ).map(mapRepository),
    );
  }

  async findById(id: string): Promise<RepositoryRecord | null> {
    return await databaseCall(async () => {
      const record = await this.client.repository.findUnique({ where: { id } });
      return record === null ? null : mapRepository(record);
    });
  }

  async update(id: string, input: UpdateRepositoryInput): Promise<RepositoryRecord> {
    return await databaseCall(async () =>
      mapRepository(
        await this.client.repository.update({
          where: { id },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
            ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
          },
        }),
      ),
    );
  }

  async delete(id: string): Promise<void> {
    await databaseCall(async () => {
      await this.client.repository.delete({ where: { id } });
    });
  }
}

class PrismaTaskStore implements TaskStore {
  constructor(private readonly client: PrismaClient) {}

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    return await databaseCall(async () =>
      mapTask(
        await this.client.task.create({
          data: {
            repositoryId: input.repositoryId,
            title: input.title,
            description: input.description,
            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
            ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
          },
        }),
      ),
    );
  }

  async list(repositoryId?: string): Promise<readonly TaskRecord[]> {
    return await databaseCall(async () =>
      (
        await this.client.task.findMany({
          ...(repositoryId === undefined ? {} : { where: { repositoryId } }),
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        })
      ).map(mapTask),
    );
  }

  async findById(id: string): Promise<TaskRecord | null> {
    return await databaseCall(async () => {
      const record = await this.client.task.findUnique({ where: { id } });
      return record === null ? null : mapTask(record);
    });
  }

  async update(id: string, input: UpdateTaskInput): Promise<TaskRecord> {
    return await databaseCall(
      async () =>
        await this.client.$transaction(async (transaction) => {
          const current = await transaction.task.findUnique({ where: { id } });
          if (current === null) throw notFound("Task", id);
          if (input.status !== undefined && !canTransitionTask(current.status, input.status)) {
            throw new DevflowError({
              code: "CONFLICT",
              message: "Invalid task status transition: " + current.status + " -> " + input.status,
            });
          }
          const changed = await transaction.task.updateMany({
            where: { id, status: current.status },
            data: {
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.description === undefined ? {} : { description: input.description }),
              ...(input.status === undefined ? {} : { status: input.status }),
            },
          });
          if (changed.count !== 1) throw conflict("Task was updated concurrently.");
          return mapTask((await transaction.task.findUnique({ where: { id } })) as PrismaTask);
        }),
    );
  }

  async delete(id: string): Promise<void> {
    await databaseCall(async () => {
      await this.client.task.delete({ where: { id } });
    });
  }
}

class PrismaRunStore implements RunRepository {
  constructor(private readonly client: PrismaClient) {}

  async create(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }> {
    return await databaseCall(async () => {
      if (input.idempotencyKey !== undefined) {
        const existing = await this.client.run.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existing !== null) {
          assertSameIdempotentRun(existing, input);
          return { run: mapRun(existing), created: false };
        }
      }
      try {
        const created = await this.client.run.create({
          data: {
            taskId: input.taskId,
            ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
            ...(input.modelProvider === undefined ? {} : { modelProvider: input.modelProvider }),
            ...(input.modelName === undefined ? {} : { modelName: input.modelName }),
            ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
            ...(input.maxTestRetries === undefined ? {} : { maxTestRetries: input.maxTestRetries }),
            ...(input.maxReviewRetries === undefined
              ? {}
              : { maxReviewRetries: input.maxReviewRetries }),
          },
        });
        return { run: mapRun(created), created: true };
      } catch (error) {
        if (input.idempotencyKey !== undefined && isUniqueConstraint(error)) {
          const existing = await this.client.run.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          });
          if (existing !== null) {
            assertSameIdempotentRun(existing, input);
            return { run: mapRun(existing), created: false };
          }
        }
        throw error;
      }
    });
  }

  async list(taskId?: string): Promise<readonly RunRecord[]> {
    return await databaseCall(async () =>
      (
        await this.client.run.findMany({
          ...(taskId === undefined ? {} : { where: { taskId } }),
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        })
      ).map(mapRun),
    );
  }

  async findById(runId: string): Promise<RunRecord | null> {
    return await databaseCall(async () => {
      const run = await this.client.run.findUnique({ where: { id: runId } });
      return run === null ? null : mapRun(run);
    });
  }

  async findExecutionById(runId: string): Promise<RunExecutionRecord | null> {
    return await databaseCall(async () => {
      const run = await this.client.run.findUnique({
        where: { id: runId },
        include: { task: { include: { repository: true } } },
      });
      return run === null ? null : mapExecutionRun(run);
    });
  }

  async findDetail(runId: string): Promise<RunDetailRecord | null> {
    return await databaseCall(async () => {
      const run = await this.client.run.findUnique({
        where: { id: runId },
        include: {
          task: { include: { repository: true } },
          steps: { orderBy: [{ sequence: "asc" }, { id: "asc" }] },
          toolCalls: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
          events: { orderBy: { sequence: "asc" } },
          artifacts: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
          approvals: { orderBy: [{ requestedAt: "asc" }, { id: "asc" }] },
        },
      });
      if (run === null) return null;
      return {
        run: mapRun(run),
        task: mapTask(run.task),
        repository: mapRepository(run.task.repository),
        steps: run.steps.map(mapStep),
        toolCalls: run.toolCalls.map(mapToolCall),
        events: run.events.map(mapEvent),
        artifacts: run.artifacts.map(mapArtifact),
        approvals: run.approvals.map(mapApproval),
      };
    });
  }

  async requestCancellation(runId: string): Promise<RunRecord> {
    return await databaseCall(
      async () =>
        await this.client.$transaction(async (transaction) => {
          const current = await transaction.run.findUnique({ where: { id: runId } });
          if (current === null) throw notFound("Run", runId);
          if (isTerminalStatus(current.status)) return mapRun(current);
          const now = new Date();
          const updated = await transaction.run.update({
            where: { id: runId },
            data:
              current.status === "QUEUED" || current.status === "WAITING_APPROVAL"
                ? {
                    status: "CANCELLED",
                    currentStage: "CANCELLED",
                    cancelRequestedAt: now,
                    finishedAt: now,
                    executionOwner: null,
                    leaseExpiresAt: null,
                  }
                : { cancelRequestedAt: now },
          });
          return mapRun(updated);
        }),
    );
  }

  async claim(
    runId: string,
    owner: string,
    leaseMs: number,
    dispatchRevision?: number,
  ): Promise<RunExecutionRecord | null> {
    return await databaseCall(async () => {
      const now = new Date();
      const changed = await this.client.run.updateMany({
        where: {
          id: runId,
          ...(dispatchRevision === undefined ? {} : { dispatchRevision }),
          cancelRequestedAt: null,
          OR: [{ status: "QUEUED" }, { status: "RUNNING", leaseExpiresAt: { lt: now } }],
        },
        data: {
          status: "RUNNING",
          executionOwner: owner,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          startedAt: now,
          failureCode: null,
          failureMessage: null,
          failureDetails: Prisma.DbNull,
        },
      });
      return changed.count === 1 ? await this.findExecutionById(runId) : null;
    });
  }

  async renewLease(runId: string, owner: string, leaseMs: number): Promise<boolean> {
    return await databaseCall(async () => {
      const changed = await this.client.run.updateMany({
        where: { id: runId, status: "RUNNING", executionOwner: owner },
        data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
      });
      return changed.count === 1;
    });
  }

  async isCancellationRequested(runId: string): Promise<boolean> {
    return await databaseCall(async () => {
      const run = await this.client.run.findUnique({
        where: { id: runId },
        select: { cancelRequestedAt: true, status: true },
      });
      if (run === null) throw notFound("Run", runId);
      return run.cancelRequestedAt !== null || run.status === "CANCELLED";
    });
  }

  async complete(runId: string, owner: string, result: RunResult): Promise<RunRecord> {
    return await databaseCall(async () => {
      if (result.runId !== runId) {
        throw new DevflowError({
          code: "VALIDATION_ERROR",
          message: "Run result ID does not match the claimed run.",
        });
      }
      const error = result.error;
      const changed = await this.client.run.updateMany({
        where: {
          id: runId,
          status: "RUNNING",
          executionOwner: owner,
          ...(result.status === "SUCCEEDED" ? { cancelRequestedAt: null } : {}),
        },
        data: {
          status: result.status,
          currentStage: stageForResult(result),
          summary: result.summary ?? null,
          stepCount: result.metrics.steps,
          modelCallCount: result.metrics.modelCalls,
          toolCallCount: result.metrics.toolCalls,
          durationMs: result.metrics.durationMs,
          modelLatencyMs: result.metrics.modelLatencyMs,
          toolLatencyMs: result.metrics.toolLatencyMs,
          inputTokens: result.metrics.tokenUsage.inputTokens,
          outputTokens: result.metrics.tokenUsage.outputTokens,
          totalTokens: result.metrics.tokenUsage.totalTokens,
          ...(result.metrics.tokenUsage.costUsd === undefined
            ? {}
            : { costUsd: result.metrics.tokenUsage.costUsd }),
          failureCode: error?.code ?? null,
          failureMessage: error?.message ?? null,
          failureDetails: error?.details === undefined ? Prisma.DbNull : jsonInput(error.details),
          executionOwner: null,
          leaseExpiresAt: null,
          finishedAt: new Date(),
        },
      });
      if (changed.count !== 1) throw conflict("Run execution lease is no longer owned.");
      return mapRun((await this.client.run.findUnique({ where: { id: runId } })) as PrismaRun);
    });
  }

  async pauseForApproval(
    runId: string,
    owner: string,
    plan: AgentPlan,
  ): Promise<{ run: RunRecord; approval: ApprovalRecord }> {
    return await databaseCall(
      async () =>
        await this.client.$transaction(async (transaction) => {
          const changed = await transaction.run.updateMany({
            where: {
              id: runId,
              status: "RUNNING",
              executionOwner: owner,
              cancelRequestedAt: null,
            },
            data: {
              status: "WAITING_APPROVAL",
              currentStage: "WAITING_APPROVAL",
              executionOwner: null,
              leaseExpiresAt: null,
            },
          });
          if (changed.count !== 1) {
            throw conflict("Run execution lease is no longer owned or cancellation was requested.");
          }
          await transaction.artifact.create({
            data: {
              runId,
              kind: "PLAN",
              name: "plan.json",
              mimeType: "application/json",
              content: JSON.stringify(plan, null, 2),
              metadata: jsonInput({ summary: plan.summary, stepCount: plan.steps.length }),
            },
          });
          const approval = await transaction.approval.create({
            data: { runId, kind: "PLAN", request: jsonInput({ plan }) },
          });
          await appendEvent(transaction, {
            runId,
            type: "APPROVAL_REQUIRED",
            occurredAt: new Date().toISOString(),
            payload: { approvalId: approval.id, kind: "PLAN", plan },
          });
          const run = await transaction.run.findUnique({ where: { id: runId } });
          if (run === null) throw notFound("Run", runId);
          return { run: mapRun(run), approval: mapApproval(approval) };
        }),
    );
  }

  async releaseForRetry(runId: string, owner: string, error: unknown): Promise<RunRecord> {
    return await databaseCall(async () => {
      const normalized = errorShape(error);
      const changed = await this.client.run.updateMany({
        where: { id: runId, status: "RUNNING", executionOwner: owner },
        data: {
          status: "QUEUED",
          retryCount: { increment: 1 },
          failureCode: normalized.code,
          failureMessage: normalized.message,
          failureDetails:
            normalized.details === undefined ? Prisma.DbNull : jsonInput(normalized.details),
          executionOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (changed.count !== 1) throw conflict("Run execution lease is no longer owned.");
      return mapRun((await this.client.run.findUnique({ where: { id: runId } })) as PrismaRun);
    });
  }

  async listRecoverable(now = new Date(), limit = 100): Promise<readonly RunRecord[]> {
    return await databaseCall(async () =>
      (
        await this.client.run.findMany({
          where: {
            cancelRequestedAt: null,
            OR: [{ status: "QUEUED" }, { status: "RUNNING", leaseExpiresAt: { lt: now } }],
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limit,
        })
      ).map(mapRun),
    );
  }

  async transition(input: RunTransitionInput): Promise<PersistedRunTransition> {
    return await databaseCall(
      async () =>
        await this.client.$transaction(async (transaction) => {
          const changed = await transaction.run.updateMany({
            where: { id: input.runId, status: input.expectedStatus },
            data: { status: input.status, currentStage: input.currentStage },
          });
          if (changed.count !== 1) throw conflict("Run status changed concurrently.");
          const run = await transaction.run.findUnique({ where: { id: input.runId } });
          if (run === null) throw notFound("Run", input.runId);
          const event = await appendEvent(transaction, input.event);
          return { run: mapRun(run), event };
        }),
    );
  }
}

class PrismaApprovalStore implements ApprovalStore {
  constructor(private readonly client: PrismaClient) {}

  async create(input: CreateApprovalInput): Promise<ApprovalRecord> {
    return await databaseCall(async () =>
      mapApproval(
        await this.client.approval.create({
          data: {
            runId: input.runId,
            kind: input.kind,
            request: jsonInput(input.request),
          },
        }),
      ),
    );
  }

  async list(runId?: string): Promise<readonly ApprovalRecord[]> {
    return await databaseCall(async () =>
      (
        await this.client.approval.findMany({
          ...(runId === undefined ? {} : { where: { runId } }),
          orderBy: [{ requestedAt: "desc" }, { id: "asc" }],
        })
      ).map(mapApproval),
    );
  }

  async findById(id: string): Promise<ApprovalRecord | null> {
    return await databaseCall(async () => {
      const approval = await this.client.approval.findUnique({ where: { id } });
      return approval === null ? null : mapApproval(approval);
    });
  }

  async resolve(id: string, input: ResolveApprovalInput): Promise<ApprovalRecord> {
    return await databaseCall(async () => {
      const changed = await this.client.approval.updateMany({
        where: { id, status: "PENDING" },
        data: {
          status: input.status,
          resolvedAt: new Date(),
          ...(input.resolution === undefined ? {} : { resolution: jsonInput(input.resolution) }),
          ...(input.comment === undefined ? {} : { comment: input.comment }),
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        },
      });
      if (changed.count !== 1) {
        const exists = await this.client.approval.findUnique({
          where: { id },
          select: { id: true },
        });
        if (exists === null) throw notFound("Approval", id);
        throw conflict("Approval has already been resolved.");
      }
      return mapApproval(
        (await this.client.approval.findUnique({ where: { id } })) as PrismaApproval,
      );
    });
  }

  async resolveForWorkflow(
    id: string,
    input: ResolveApprovalInput,
  ): Promise<{
    approval: ApprovalRecord;
    run?: RunRecord | undefined;
    shouldEnqueue: boolean;
  }> {
    return await databaseCall(
      async () =>
        await this.client.$transaction(async (transaction) => {
          const current = await transaction.approval.findUnique({
            where: { id },
            include: { run: true },
          });
          if (current === null) throw notFound("Approval", id);
          if (current.status !== "PENDING") throw conflict("Approval has already been resolved.");

          const workflowPlan = current.kind === "PLAN" && isWorkflowPlanRequest(current.request);
          if (workflowPlan && current.run.status !== "WAITING_APPROVAL") {
            throw conflict("Run is no longer waiting for this plan approval.");
          }

          const approvalChanged = await transaction.approval.updateMany({
            where: { id, status: "PENDING" },
            data: approvalResolutionData(input),
          });
          if (approvalChanged.count !== 1) throw conflict("Approval has already been resolved.");
          const approval = (await transaction.approval.findUnique({
            where: { id },
          })) as PrismaApproval;

          if (!workflowPlan) {
            return { approval: mapApproval(approval), shouldEnqueue: false };
          }

          const resume = input.status === "APPROVED" || input.status === "REJECTED";
          const changed = await transaction.run.updateMany({
            where: { id: current.runId, status: "WAITING_APPROVAL" },
            data: resume
              ? {
                  status: "QUEUED",
                  currentStage: input.status === "APPROVED" ? "EXECUTE" : "GENERATE_PLAN",
                  dispatchRevision: { increment: 1 },
                }
              : {
                  status: "CANCELLED",
                  currentStage: "CANCELLED",
                  cancelRequestedAt: new Date(),
                  finishedAt: new Date(),
                },
          });
          if (changed.count !== 1) throw conflict("Run approval state changed concurrently.");
          await appendEvent(transaction, {
            runId: current.runId,
            type:
              input.status === "APPROVED"
                ? "PLAN_APPROVED"
                : input.status === "REJECTED"
                  ? "PLAN_REJECTED"
                  : "RUN_CANCELLED",
            level: input.status === "REJECTED" ? "WARN" : "INFO",
            occurredAt: new Date().toISOString(),
            payload: {
              approvalId: id,
              decision: input.status,
              ...(input.comment === undefined ? {} : { comment: input.comment }),
              ...(input.resolution === undefined
                ? {}
                : { resolution: eventJson(input.resolution) }),
            },
          });
          const run = (await transaction.run.findUnique({
            where: { id: current.runId },
          })) as PrismaRun;
          return {
            approval: mapApproval(approval),
            run: mapRun(run),
            shouldEnqueue: resume,
          };
        }),
    );
  }
}

class PrismaArtifactStore implements ArtifactStore {
  constructor(private readonly client: PrismaClient) {}

  async create(input: CreateArtifactInput): Promise<ArtifactRecord> {
    if (input.content === undefined && input.uri === undefined) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "Artifact requires content or uri.",
      });
    }
    return await databaseCall(async () =>
      mapArtifact(
        await this.client.artifact.create({
          data: {
            runId: input.runId,
            ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
            kind: input.kind,
            name: input.name,
            ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
            ...(input.uri === undefined ? {} : { uri: input.uri }),
            ...(input.content === undefined ? {} : { content: input.content }),
            ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }),
            ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
            ...(input.metadata === undefined ? {} : { metadata: jsonInput(input.metadata) }),
          },
        }),
      ),
    );
  }

  async list(runId: string): Promise<readonly ArtifactRecord[]> {
    return await databaseCall(async () =>
      (
        await this.client.artifact.findMany({
          where: { runId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      ).map(mapArtifact),
    );
  }
}

class PrismaEventWriter implements EventStore {
  constructor(private readonly client: PrismaClient) {}

  async list(
    runId: string,
    query: { afterSequence?: number | undefined; limit?: number | undefined } = {},
  ): Promise<readonly AgentEvent[]> {
    const afterSequence = query.afterSequence ?? 0;
    const limit = query.limit ?? 100;
    assertEventQuery(afterSequence, limit);
    return await databaseCall(async () =>
      (
        await this.client.event.findMany({
          where: { runId, sequence: { gt: afterSequence } },
          orderBy: { sequence: "asc" },
          take: limit,
        })
      ).map(mapEvent),
    );
  }

  async append(event: NewAgentEvent): Promise<AgentEvent> {
    return await databaseCall(
      async () =>
        await this.client.$transaction(
          async (transaction) => await appendEvent(transaction, event),
        ),
    );
  }
}

function mapEvent(event: PrismaEvent): AgentEvent {
  return {
    schemaVersion: 1,
    eventId: event.id,
    runId: event.runId,
    ...(event.stepId === null ? {} : { stepId: event.stepId }),
    ...(event.toolCallId === null ? {} : { toolCallId: event.toolCallId }),
    sequence: event.sequence,
    occurredAt: event.occurredAt.toISOString(),
    type: event.type as AgentEvent["type"],
    level: event.level,
    payload: event.payload as AgentEvent["payload"],
  };
}

function assertEventQuery(afterSequence: number, limit: number): void {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Event cursor must be a non-negative safe integer.",
    });
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Event page limit must be between 1 and 1000.",
    });
  }
}

async function appendEvent(
  transaction: TransactionClient,
  event: NewAgentEvent,
): Promise<AgentEvent> {
  const run = await transaction.run.update({
    where: { id: event.runId },
    data: { nextEventSequence: { increment: 1 } },
    select: { nextEventSequence: true, currentStage: true },
  });
  await projectEvent(transaction, event, run.nextEventSequence, run.currentStage);
  const eventId = randomUUID();
  await transaction.event.create({
    data: {
      id: eventId,
      runId: event.runId,
      ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
      ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
      sequence: run.nextEventSequence,
      type: event.type,
      level: event.level ?? "INFO",
      payload: jsonInput(event.payload),
      occurredAt: new Date(event.occurredAt),
    },
  });
  return {
    schemaVersion: 1,
    eventId,
    runId: event.runId,
    ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
    ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
    sequence: run.nextEventSequence,
    occurredAt: event.occurredAt,
    type: event.type,
    level: event.level ?? "INFO",
    payload: event.payload,
  };
}

async function projectEvent(
  transaction: TransactionClient,
  event: NewAgentEvent,
  sequence: number,
  stage: WorkflowStage,
): Promise<void> {
  const payload = recordValue(event.payload);
  if (event.type === "STEP_STARTED" && event.stepId !== undefined) {
    await transaction.step.upsert({
      where: { id: event.stepId },
      create: {
        id: event.stepId,
        runId: event.runId,
        sequence,
        stage,
        status: "RUNNING",
        title:
          stringValue(payload.title) ??
          `Agent step ${String(numberValue(payload.step) ?? sequence)}`,
        input: jsonInput(event.payload),
        startedAt: new Date(event.occurredAt),
      },
      update: {},
    });
  } else if (event.type === "STEP_COMPLETED" && event.stepId !== undefined) {
    const step = await transaction.step.findUnique({ where: { id: event.stepId } });
    if (step !== null) {
      const finishedAt = new Date(event.occurredAt);
      await transaction.step.update({
        where: { id: event.stepId },
        data: {
          status: "SUCCEEDED",
          output: jsonInput(event.payload),
          finishedAt,
          durationMs:
            step.startedAt === null
              ? null
              : Math.max(0, finishedAt.getTime() - step.startedAt.getTime()),
        },
      });
    }
  }

  if (event.type === "TOOL_CALL" && event.stepId !== undefined && event.toolCallId !== undefined) {
    const externalCallId = stringValue(payload.callId);
    await transaction.toolCall.upsert({
      where: { id: event.toolCallId },
      create: {
        id: event.toolCallId,
        runId: event.runId,
        stepId: event.stepId,
        ...(externalCallId === undefined ? {} : { externalCallId }),
        name: stringValue(payload.name) ?? "unknown",
        status: "RUNNING",
        input: jsonInput(payload.input ?? {}),
        startedAt: new Date(event.occurredAt),
      },
      update: {},
    });
  } else if (event.type === "TOOL_RESULT" && event.toolCallId !== undefined) {
    const toolCall = await transaction.toolCall.findUnique({ where: { id: event.toolCallId } });
    if (toolCall !== null) {
      const ok = payload.ok === true;
      const error = recordValue(payload.error);
      const errorCode = stringValue(error.code);
      await transaction.toolCall.update({
        where: { id: event.toolCallId },
        data: {
          status: ok
            ? "SUCCEEDED"
            : errorCode === "PERMISSION_DENIED"
              ? "DENIED"
              : errorCode === "TIMEOUT"
                ? "TIMED_OUT"
                : errorCode === "CANCELLED"
                  ? "CANCELLED"
                  : "FAILED",
          ...(ok
            ? { output: jsonInput(payload.output ?? null) }
            : { error: jsonInput(payload.error ?? null) }),
          finishedAt: new Date(event.occurredAt),
          durationMs: numberValue(payload.durationMs) ?? 0,
        },
      });
    }
  }

  if (event.type === "RUN_FAILED" || event.type === "RUN_CANCELLED") {
    await transaction.step.updateMany({
      where: { runId: event.runId, status: "RUNNING" },
      data: {
        status: event.type === "RUN_CANCELLED" ? "CANCELLED" : "FAILED",
        finishedAt: new Date(event.occurredAt),
        error: jsonInput(event.payload),
      },
    });
    await transaction.toolCall.updateMany({
      where: { runId: event.runId, status: "RUNNING" },
      data: {
        status: event.type === "RUN_CANCELLED" ? "CANCELLED" : "FAILED",
        finishedAt: new Date(event.occurredAt),
        error: jsonInput(event.payload),
      },
    });
  }
}

function mapRepository(repository: PrismaRepository): RepositoryRecord {
  return {
    id: repository.id,
    name: repository.name,
    sourceKind: repository.sourceKind,
    sourceUri: repository.sourceUri,
    ...(repository.defaultBranch === null ? {} : { defaultBranch: repository.defaultBranch }),
    createdAt: repository.createdAt.toISOString(),
    updatedAt: repository.updatedAt.toISOString(),
  };
}

function mapTask(task: PrismaTask): TaskRecord {
  return {
    id: task.id,
    repositoryId: task.repositoryId,
    title: task.title,
    description: task.description,
    status: task.status,
    ...(task.baseRef === null ? {} : { baseRef: task.baseRef }),
    ...(task.baseCommit === null ? {} : { baseCommit: task.baseCommit }),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function mapRun(run: PrismaRun): RunRecord {
  const result = resultFromRun(run);
  return {
    id: run.id,
    taskId: run.taskId,
    ...(run.idempotencyKey === null ? {} : { idempotencyKey: run.idempotencyKey }),
    status: run.status,
    currentStage: run.currentStage,
    maxSteps: run.maxSteps,
    maxTestRetries: run.maxTestRetries,
    maxReviewRetries: run.maxReviewRetries,
    dispatchRevision: run.dispatchRevision,
    retryCount: run.retryCount,
    ...(run.executionOwner === null ? {} : { executionOwner: run.executionOwner }),
    ...(run.leaseExpiresAt === null ? {} : { leaseExpiresAt: run.leaseExpiresAt.toISOString() }),
    cancellationRequested: run.cancelRequestedAt !== null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    ...(run.startedAt === null ? {} : { startedAt: run.startedAt.toISOString() }),
    ...(run.finishedAt === null ? {} : { finishedAt: run.finishedAt.toISOString() }),
    ...(result === undefined ? {} : { result }),
  };
}

function mapExecutionRun(run: RunWithTaskAndRepository): RunExecutionRecord {
  return {
    ...mapRun(run),
    task: mapTask(run.task),
    repository: mapRepository(run.task.repository),
    ...(run.modelProvider === null ? {} : { modelProvider: run.modelProvider }),
    ...(run.modelName === null ? {} : { modelName: run.modelName }),
  };
}

function mapApproval(approval: PrismaApproval): ApprovalRecord {
  return {
    id: approval.id,
    runId: approval.runId,
    kind: approval.kind,
    status: approval.status,
    request: approval.request,
    ...(approval.resolution === null ? {} : { resolution: approval.resolution }),
    ...(approval.comment === null ? {} : { comment: approval.comment }),
    ...(approval.actorId === null ? {} : { actorId: approval.actorId }),
    requestedAt: approval.requestedAt.toISOString(),
    ...(approval.resolvedAt === null ? {} : { resolvedAt: approval.resolvedAt.toISOString() }),
    updatedAt: approval.updatedAt.toISOString(),
  };
}

function mapStep(step: PrismaStep): StepRecord {
  return {
    id: step.id,
    runId: step.runId,
    sequence: step.sequence,
    stage: step.stage,
    status: step.status,
    ...(step.title === null ? {} : { title: step.title }),
    ...(step.input === null ? {} : { input: step.input }),
    ...(step.output === null ? {} : { output: step.output }),
    ...(step.error === null ? {} : { error: step.error }),
    ...(step.startedAt === null ? {} : { startedAt: step.startedAt.toISOString() }),
    ...(step.finishedAt === null ? {} : { finishedAt: step.finishedAt.toISOString() }),
    ...(step.durationMs === null ? {} : { durationMs: step.durationMs }),
    createdAt: step.createdAt.toISOString(),
    updatedAt: step.updatedAt.toISOString(),
  };
}

function mapToolCall(toolCall: PrismaToolCall): ToolCallRecord {
  return {
    id: toolCall.id,
    runId: toolCall.runId,
    stepId: toolCall.stepId,
    ...(toolCall.externalCallId === null ? {} : { externalCallId: toolCall.externalCallId }),
    name: toolCall.name,
    status: toolCall.status,
    input: toolCall.input,
    ...(toolCall.output === null ? {} : { output: toolCall.output }),
    ...(toolCall.error === null ? {} : { error: toolCall.error }),
    ...(toolCall.startedAt === null ? {} : { startedAt: toolCall.startedAt.toISOString() }),
    ...(toolCall.finishedAt === null ? {} : { finishedAt: toolCall.finishedAt.toISOString() }),
    ...(toolCall.durationMs === null ? {} : { durationMs: toolCall.durationMs }),
    createdAt: toolCall.createdAt.toISOString(),
  };
}

function mapArtifact(artifact: PrismaArtifact): ArtifactRecord {
  return {
    id: artifact.id,
    runId: artifact.runId,
    ...(artifact.stepId === null ? {} : { stepId: artifact.stepId }),
    kind: artifact.kind,
    name: artifact.name,
    ...(artifact.mimeType === null ? {} : { mimeType: artifact.mimeType }),
    ...(artifact.uri === null ? {} : { uri: artifact.uri }),
    ...(artifact.content === null ? {} : { content: artifact.content }),
    ...(artifact.sizeBytes === null ? {} : { sizeBytes: artifact.sizeBytes }),
    ...(artifact.sha256 === null ? {} : { sha256: artifact.sha256 }),
    ...(artifact.metadata === null ? {} : { metadata: artifact.metadata }),
    createdAt: artifact.createdAt.toISOString(),
  };
}

function resultFromRun(run: PrismaRun): RunResult | undefined {
  if (!isTerminalStatus(run.status)) return undefined;
  const error =
    run.failureCode === null
      ? undefined
      : {
          code: run.failureCode as DevflowErrorShape["code"],
          message: run.failureMessage ?? "Run failed.",
          retryable: false,
          ...(run.failureDetails === null
            ? {}
            : { details: run.failureDetails as DevflowErrorShape["details"] }),
        };
  return {
    runId: run.id,
    status: run.status,
    ...(run.summary === null ? {} : { summary: run.summary }),
    metrics: {
      durationMs: run.durationMs,
      steps: run.stepCount,
      modelCalls: run.modelCallCount,
      toolCalls: run.toolCallCount,
      retries: run.retryCount,
      modelLatencyMs: run.modelLatencyMs,
      toolLatencyMs: run.toolLatencyMs,
      tokenUsage: {
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        totalTokens: run.totalTokens,
        ...(run.costUsd === null ? {} : { costUsd: run.costUsd.toString() }),
      },
    },
    ...(error === undefined ? {} : { error }),
  };
}

function stageForResult(result: RunResult): WorkflowStage {
  if (result.status === "SUCCEEDED") return "DONE";
  if (result.status === "CANCELLED") return "CANCELLED";
  return "FAILED";
}

function assertSameIdempotentRun(existing: PrismaRun, input: CreateRunInput): void {
  if (existing.taskId !== input.taskId) {
    throw conflict("Idempotency key is already associated with another task.");
  }
}

function canTransitionTask(current: TaskStatus, next: TaskStatus): boolean {
  if (current === next) return true;
  if (current === "OPEN") return ["COMPLETED", "CANCELLED", "ARCHIVED"].includes(next);
  return next === "ARCHIVED";
}

function isTerminalStatus(status: RunStatus): status is RunResult["status"] {
  return ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(status);
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function eventJson(value: unknown): AgentEvent["payload"] {
  return JSON.parse(JSON.stringify(value)) as AgentEvent["payload"];
}

function approvalResolutionData(
  input: ResolveApprovalInput,
): Prisma.ApprovalUpdateManyMutationInput {
  return {
    status: input.status,
    resolvedAt: new Date(),
    ...(input.resolution === undefined ? {} : { resolution: jsonInput(input.resolution) }),
    ...(input.comment === undefined ? {} : { comment: input.comment }),
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
  };
}

function isWorkflowPlanRequest(value: unknown): boolean {
  return typeof value === "object" && value !== null && "plan" in value;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : undefined;
}

function errorShape(error: unknown): DevflowErrorShape {
  if (error instanceof DevflowError) return error.toJSON();
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function notFound(entity: string, id: string): DevflowError {
  return new DevflowError({ code: "NOT_FOUND", message: entity + " '" + id + "' was not found." });
}

function conflict(message: string): DevflowError {
  return new DevflowError({ code: "CONFLICT", message });
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function databaseCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DevflowError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") throw notFound("Record", "unknown");
      if (error.code === "P2002")
        throw conflict("A record with the same unique key already exists.");
      if (error.code === "P2003")
        throw conflict("The record is still referenced by another entity.");
    }
    throw new DevflowError({
      code: "DATABASE_FAILED",
      message: "Database operation failed.",
      retryable: true,
      details: error instanceof Error ? { name: error.name, message: error.message } : undefined,
      cause: error,
    });
  }
}
