import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import type {
  GitHubPublicationRecord,
  GitHubPullRequestResult,
  GitHubPushResult,
} from "@devflow/github";
import {
  assertCredentialFreeRepositoryUri,
  DevflowError,
  type AgentEvent,
  type AgentPlan,
  type DevflowErrorShape,
  type NewAgentEvent,
  RunMetricsSchema,
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
  type BenchmarkCaseExecution as PrismaBenchmarkCaseExecution,
  type BenchmarkSuiteExecution as PrismaBenchmarkSuiteExecution,
  type Event as PrismaEvent,
  type GitHubPublication as PrismaGitHubPublication,
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
  BenchmarkCaseExecutionRecord,
  BenchmarkExecutionStore,
  BenchmarkSuiteExecutionRecord,
  CreateArtifactInput,
  CreateApprovalInput,
  CreateRepositoryInput,
  CreateRunInput,
  CreateTaskInput,
  DatabaseAdapter,
  DatabaseGitHubPublicationStore,
  EventStore,
  PauseForGitHubApprovalInput,
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
  StartBenchmarkCaseExecutionInput,
  StartBenchmarkSuiteExecutionInput,
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
  readonly githubPublications: DatabaseGitHubPublicationStore;
  readonly benchmarkExecutions: BenchmarkExecutionStore;
  readonly events: EventStore;

  constructor(readonly client: PrismaClient) {
    this.repositories = new PrismaRepositoryStore(client);
    this.tasks = new PrismaTaskStore(client);
    this.runs = new PrismaRunStore(client);
    this.approvals = new PrismaApprovalStore(client);
    this.artifacts = new PrismaArtifactStore(client);
    this.githubPublications = new PrismaGitHubPublicationStore(client);
    this.benchmarkExecutions = new PrismaBenchmarkExecutionStore(client);
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
    assertCredentialFreeRepositoryUri(input.sourceUri);
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
    if (input.sourceUri !== undefined) assertCredentialFreeRepositoryUri(input.sourceUri);
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
            ...(input.baseCommitSha === undefined ? {} : { baseCommitSha: input.baseCommitSha }),
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
            ...(input.initialArtifact === undefined
              ? {}
              : {
                  artifacts: {
                    create: {
                      ...(input.initialArtifact.stepId === undefined
                        ? {}
                        : { stepId: input.initialArtifact.stepId }),
                      kind: input.initialArtifact.kind,
                      name: input.initialArtifact.name,
                      ...(input.initialArtifact.mimeType === undefined
                        ? {}
                        : { mimeType: input.initialArtifact.mimeType }),
                      ...(input.initialArtifact.uri === undefined
                        ? {}
                        : { uri: input.initialArtifact.uri }),
                      ...(input.initialArtifact.content === undefined
                        ? {}
                        : { content: input.initialArtifact.content }),
                      ...(input.initialArtifact.sizeBytes === undefined
                        ? {}
                        : { sizeBytes: input.initialArtifact.sizeBytes }),
                      ...(input.initialArtifact.sha256 === undefined
                        ? {}
                        : { sha256: input.initialArtifact.sha256 }),
                      ...(input.initialArtifact.metadata === undefined
                        ? {}
                        : { metadata: jsonInput(input.initialArtifact.metadata) }),
                    },
                  },
                }),
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

  async findByIdempotencyKey(idempotencyKey: string): Promise<RunRecord | null> {
    return await databaseCall(async () => {
      const run = await this.client.run.findUnique({ where: { idempotencyKey } });
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
          githubPublication: true,
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
        ...(run.githubPublication === null
          ? {}
          : { githubPublication: mapGitHubPublication(run.githubPublication) }),
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
          const becomesTerminal =
            current.status === "QUEUED" || current.status === "WAITING_APPROVAL";
          const updated = await transaction.run.update({
            where: { id: runId },
            data: becomesTerminal
              ? {
                  status: "CANCELLED",
                  currentStage: "CANCELLED",
                  cancelRequestedAt: now,
                  failureCode: "CANCELLED",
                  failureMessage: "Run was cancelled before execution completed.",
                  failureDetails: Prisma.DbNull,
                  finishedAt: now,
                  executionOwner: null,
                  leaseExpiresAt: null,
                }
              : { cancelRequestedAt: now },
          });
          if (becomesTerminal) {
            await appendEvent(transaction, {
              runId,
              type: "RUN_CANCELLED",
              level: "WARN",
              occurredAt: now.toISOString(),
              payload: {
                status: "CANCELLED",
                stage: current.currentStage,
                terminalStage: "CANCELLED",
                code: "CANCELLED",
                message: "Run was cancelled before execution completed.",
              },
            });
          }
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
    return await databaseCall(
      async () =>
        await this.client.$transaction(async (transaction) => {
          if (result.runId !== runId) {
            throw new DevflowError({
              code: "VALIDATION_ERROR",
              message: "Run result ID does not match the claimed run.",
            });
          }
          const current = await transaction.run.findFirst({
            where: { id: runId, status: "RUNNING", executionOwner: owner },
          });
          if (current === null) throw conflict("Run execution lease is no longer owned.");
          if (result.status !== "CANCELLED" && current.cancelRequestedAt !== null) {
            throw conflict(
              "A Run with a persisted cancellation request must complete as cancelled.",
            );
          }

          const error = result.error;
          const finishedAt = new Date();
          const changed = await transaction.run.updateMany({
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
              metricsDetail: jsonInput(result.metrics),
              ...(result.metrics.tokenUsage.costUsd === undefined
                ? {}
                : { costUsd: result.metrics.tokenUsage.costUsd }),
              failureCode: error?.code ?? null,
              failureMessage: error?.message ?? null,
              failureDetails:
                error?.details === undefined ? Prisma.DbNull : jsonInput(error.details),
              executionOwner: null,
              leaseExpiresAt: null,
              finishedAt,
            },
          });
          if (changed.count !== 1) throw conflict("Run execution lease is no longer owned.");
          await appendEvent(
            transaction,
            terminalEventForResult(result, current.currentStage, finishedAt),
          );
          return mapRun((await transaction.run.findUnique({ where: { id: runId } })) as PrismaRun);
        }),
    );
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
            payload: eventJson({ approvalId: approval.id, kind: "PLAN", plan }),
          });
          const run = await transaction.run.findUnique({ where: { id: runId } });
          if (run === null) throw notFound("Run", runId);
          return { run: mapRun(run), approval: mapApproval(approval) };
        }),
    );
  }

  async pauseForGitHubApproval(
    runId: string,
    owner: string,
    input: PauseForGitHubApprovalInput,
  ): Promise<{ run: RunRecord; approval: ApprovalRecord }> {
    assertNoCredentialMaterial(input.request);
    const waitingStage =
      input.kind === "GITHUB_PUSH" ? "WAITING_PUSH_APPROVAL" : "WAITING_PR_APPROVAL";
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
              currentStage: waitingStage,
              executionOwner: null,
              leaseExpiresAt: null,
            },
          });
          if (changed.count !== 1) {
            throw conflict("Run execution lease is no longer owned or cancellation was requested.");
          }

          if (input.publication !== undefined) {
            const current = await transaction.gitHubPublication.findUnique({ where: { runId } });
            if (current === null) {
              await transaction.gitHubPublication.create({
                data: {
                  runId,
                  repositoryOwner: input.publication.repository.owner,
                  repositoryName: input.publication.repository.name,
                  baseCommit: input.publication.baseCommit,
                  baseBranch: input.publication.baseBranch,
                  branchName: input.publication.branchName,
                  pushOperationKey: input.publication.pushOperationKey,
                  changesArtifactId: input.publication.changesArtifactId,
                },
              });
            } else {
              assertSamePublication(current, input.publication);
            }
          }
          const publication = await transaction.gitHubPublication.findUnique({ where: { runId } });
          if (publication === null) {
            throw conflict("GitHub publication metadata must exist before requesting approval.");
          }
          if (input.kind === "GITHUB_PULL_REQUEST" && publication.commitSha === null) {
            throw conflict(
              "A GitHub branch must be pushed before requesting pull request approval.",
            );
          }

          const approval = await transaction.approval.create({
            data: { runId, kind: input.kind, request: jsonInput(input.request) },
          });
          await appendEvent(transaction, {
            runId,
            type: input.kind === "GITHUB_PUSH" ? "PUSH_APPROVAL_REQUIRED" : "PR_APPROVAL_REQUIRED",
            occurredAt: new Date().toISOString(),
            payload: {
              approvalId: approval.id,
              kind: input.kind,
              branchName: publication.branchName,
              baseCommit: publication.baseCommit,
              ...(publication.commitSha === null ? {} : { commitSha: publication.commitSha }),
            },
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

  async finalizeExpiredCancellations(now = new Date(), limit = 100): Promise<number> {
    return await databaseCall(
      async () =>
        await this.client.$transaction(async (transaction) => {
          const candidates = await transaction.run.findMany({
            where: {
              status: "RUNNING",
              cancelRequestedAt: { not: null },
              OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null }],
            },
            select: { id: true, currentStage: true },
            orderBy: [{ cancelRequestedAt: "asc" }, { id: "asc" }],
            take: limit,
          });
          let finalized = 0;
          for (const candidate of candidates) {
            const message = "Run cancellation was finalized after its execution lease expired.";
            const changed = await transaction.run.updateMany({
              where: {
                id: candidate.id,
                status: "RUNNING",
                cancelRequestedAt: { not: null },
                OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null }],
              },
              data: {
                status: "CANCELLED",
                currentStage: "CANCELLED",
                failureCode: "CANCELLED",
                failureMessage: message,
                failureDetails: Prisma.DbNull,
                executionOwner: null,
                leaseExpiresAt: null,
                finishedAt: now,
              },
            });
            if (changed.count !== 1) continue;
            await appendEvent(transaction, {
              runId: candidate.id,
              type: "RUN_CANCELLED",
              level: "WARN",
              occurredAt: now.toISOString(),
              payload: {
                status: "CANCELLED",
                stage: candidate.currentStage,
                terminalStage: "CANCELLED",
                code: "CANCELLED",
                message,
              },
            });
            finalized += 1;
          }
          return finalized;
        }),
    );
  }

  async transition(input: RunTransitionInput): Promise<PersistedRunTransition> {
    assertRunTransitionEvent(input);
    return await databaseCall(
      async () =>
        await this.client.$transaction(async (transaction) => {
          const changed = await transaction.run.updateMany({
            where: {
              id: input.runId,
              status: input.expectedStatus,
              ...(input.expectedStage === undefined ? {} : { currentStage: input.expectedStage }),
            },
            data: { status: input.status, currentStage: input.currentStage },
          });
          if (changed.count !== 1) throw conflict("Run status or stage changed concurrently.");
          const run = await transaction.run.findUnique({ where: { id: input.runId } });
          if (run === null) throw notFound("Run", input.runId);
          const event = await appendEvent(transaction, input.event);
          return { run: mapRun(run), event };
        }),
    );
  }
}

function assertRunTransitionEvent(input: RunTransitionInput): void {
  if (input.event.runId !== input.runId) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Run transition and event must target the same Run.",
    });
  }
  const expectedTerminal =
    input.status === "SUCCEEDED"
      ? { event: "RUN_COMPLETED", stage: "DONE" }
      : input.status === "CANCELLED"
        ? { event: "RUN_CANCELLED", stage: "CANCELLED" }
        : input.status === "FAILED" || input.status === "TIMED_OUT"
          ? { event: "RUN_FAILED", stage: "FAILED" }
          : undefined;
  const terminalEvent = ["RUN_COMPLETED", "RUN_CANCELLED", "RUN_FAILED"].includes(input.event.type);
  if (
    (expectedTerminal === undefined && terminalEvent) ||
    (expectedTerminal !== undefined &&
      (input.event.type !== expectedTerminal.event ||
        input.currentStage !== expectedTerminal.stage))
  ) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Run terminal status, stage, and persisted terminal event must agree.",
      details: {
        status: input.status,
        currentStage: input.currentStage,
        eventType: input.event.type,
      },
    });
  }
}

class PrismaApprovalStore implements ApprovalStore {
  constructor(private readonly client: PrismaClient) {}

  async create(input: CreateApprovalInput): Promise<ApprovalRecord> {
    if (input.kind === "GITHUB_PUSH" || input.kind === "GITHUB_PULL_REQUEST") {
      assertNoCredentialMaterial(input.request);
    }
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
    return await databaseCall(
      async () =>
        await this.client.$transaction(async (transaction) => {
          const current = await transaction.approval.findUnique({ where: { id } });
          if (current === null) throw notFound("Approval", id);
          if (current.status !== "PENDING") throw conflict("Approval has already been resolved.");
          assertSafeGitHubApprovalResolution(current.kind, input);

          const changed = await transaction.approval.updateMany({
            where: { id, status: "PENDING" },
            data: approvalResolutionData(input),
          });
          if (changed.count !== 1) throw conflict("Approval has already been resolved.");
          return mapApproval(
            (await transaction.approval.findUnique({ where: { id } })) as PrismaApproval,
          );
        }),
    );
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
          assertSafeGitHubApprovalResolution(current.kind, input);

          const workflowKind =
            current.kind === "PLAN" && isWorkflowPlanRequest(current.request)
              ? "PLAN"
              : current.kind === "GITHUB_PUSH" || current.kind === "GITHUB_PULL_REQUEST"
                ? current.kind
                : undefined;
          const expectedStage =
            workflowKind === "PLAN"
              ? "WAITING_APPROVAL"
              : workflowKind === "GITHUB_PUSH"
                ? "WAITING_PUSH_APPROVAL"
                : "WAITING_PR_APPROVAL";
          if (
            workflowKind !== undefined &&
            (current.run.status !== "WAITING_APPROVAL" ||
              current.run.currentStage !== expectedStage)
          ) {
            throw conflict("Run is no longer waiting for this approval.");
          }

          const approvalChanged = await transaction.approval.updateMany({
            where: { id, status: "PENDING" },
            data: approvalResolutionData(input),
          });
          if (approvalChanged.count !== 1) throw conflict("Approval has already been resolved.");
          const approval = (await transaction.approval.findUnique({
            where: { id },
          })) as PrismaApproval;

          if (workflowKind === undefined) {
            return { approval: mapApproval(approval), shouldEnqueue: false };
          }

          const resume =
            input.status === "APPROVED" || (workflowKind === "PLAN" && input.status === "REJECTED");
          const resumeStage =
            workflowKind === "PLAN"
              ? input.status === "APPROVED"
                ? "EXECUTE"
                : "GENERATE_PLAN"
              : workflowKind === "GITHUB_PUSH"
                ? "PUSH"
                : "CREATE_PR";
          const decisionAt = new Date();
          const terminalMessage =
            input.status === "CANCELLED"
              ? `${workflowKind} approval was cancelled.`
              : `${workflowKind} approval was rejected.`;
          const changed = await transaction.run.updateMany({
            where: { id: current.runId, status: "WAITING_APPROVAL" },
            data: resume
              ? {
                  status: "QUEUED",
                  currentStage: resumeStage,
                  dispatchRevision: { increment: 1 },
                }
              : {
                  status: "CANCELLED",
                  currentStage: "CANCELLED",
                  cancelRequestedAt: decisionAt,
                  failureCode: "CANCELLED",
                  failureMessage: terminalMessage,
                  failureDetails: Prisma.DbNull,
                  finishedAt: decisionAt,
                },
          });
          if (changed.count !== 1) throw conflict("Run approval state changed concurrently.");
          const decisionEvent =
            workflowKind === "PLAN"
              ? input.status === "APPROVED"
                ? "PLAN_APPROVED"
                : input.status === "REJECTED"
                  ? "PLAN_REJECTED"
                  : "RUN_CANCELLED"
              : workflowKind === "GITHUB_PUSH"
                ? input.status === "APPROVED"
                  ? "PUSH_APPROVED"
                  : input.status === "REJECTED"
                    ? "PUSH_REJECTED"
                    : "RUN_CANCELLED"
                : input.status === "APPROVED"
                  ? "PR_APPROVED"
                  : input.status === "REJECTED"
                    ? "PR_REJECTED"
                    : "RUN_CANCELLED";
          await appendEvent(transaction, {
            runId: current.runId,
            type: decisionEvent,
            level: input.status === "REJECTED" ? "WARN" : "INFO",
            occurredAt: decisionAt.toISOString(),
            payload: {
              approvalId: id,
              decision: input.status,
              ...(decisionEvent === "RUN_CANCELLED"
                ? {
                    status: "CANCELLED",
                    stage: current.run.currentStage,
                    terminalStage: "CANCELLED",
                    code: "CANCELLED",
                    message: terminalMessage,
                  }
                : {}),
              ...(input.comment === undefined ? {} : { comment: input.comment }),
              ...(input.resolution === undefined
                ? {}
                : { resolution: eventJson(input.resolution) }),
            },
          });
          if (!resume && decisionEvent !== "RUN_CANCELLED") {
            await appendEvent(transaction, {
              runId: current.runId,
              type: "RUN_CANCELLED",
              level: "WARN",
              occurredAt: decisionAt.toISOString(),
              payload: {
                approvalId: id,
                status: "CANCELLED",
                stage: current.run.currentStage,
                terminalStage: "CANCELLED",
                code: "CANCELLED",
                message: terminalMessage,
              },
            });
          }
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

class PrismaGitHubPublicationStore implements DatabaseGitHubPublicationStore {
  constructor(private readonly client: PrismaClient) {}

  async initialize(
    runId: string,
    input: Parameters<DatabaseGitHubPublicationStore["initialize"]>[1],
  ): Promise<GitHubPublicationRecord> {
    return await databaseCall(async () => {
      const current = await this.client.gitHubPublication.findUnique({ where: { runId } });
      if (current !== null) {
        assertSamePublication(current, input);
        return mapGitHubPublication(current);
      }
      return mapGitHubPublication(
        await this.client.gitHubPublication.create({
          data: {
            runId,
            repositoryOwner: input.repository.owner,
            repositoryName: input.repository.name,
            baseCommit: input.baseCommit,
            baseBranch: input.baseBranch,
            branchName: input.branchName,
            pushOperationKey: input.pushOperationKey,
            changesArtifactId: input.changesArtifactId,
          },
        }),
      );
    });
  }

  async findByRunId(runId: string): Promise<GitHubPublicationRecord | null> {
    return await databaseCall(async () => {
      const publication = await this.client.gitHubPublication.findUnique({ where: { runId } });
      return publication === null ? null : mapGitHubPublication(publication);
    });
  }

  async recordPush(runId: string, operationKey: string, result: GitHubPushResult): Promise<void> {
    await databaseCall(
      async () =>
        await this.client.$transaction(async (transaction) => {
          const current = await transaction.gitHubPublication.findUnique({ where: { runId } });
          if (current === null) throw notFound("GitHub publication", runId);
          if (current.pushOperationKey !== operationKey) {
            throw conflict("GitHub push operation key does not match the persisted publication.");
          }
          if (current.branchName !== result.branchName) {
            throw conflict("GitHub provider returned an unexpected branch.");
          }
          if (current.commitSha !== null && current.commitSha !== result.commitSha) {
            throw conflict("A different GitHub commit is already persisted for this run.");
          }
          if (current.commitSha === null) {
            await transaction.gitHubPublication.update({
              where: { runId },
              data: { commitSha: result.commitSha, branchUrl: result.remoteUrl },
            });
            await appendEvent(transaction, {
              runId,
              type: "PUSH_COMPLETED",
              occurredAt: new Date().toISOString(),
              payload: {
                branchName: result.branchName,
                commitSha: result.commitSha,
                remoteUrl: result.remoteUrl,
                idempotent: result.idempotent,
              },
            });
          }
        }),
    );
  }

  async recordPullRequest(
    runId: string,
    operationKey: string,
    result: GitHubPullRequestResult,
  ): Promise<void> {
    await databaseCall(
      async () =>
        await this.client.$transaction(async (transaction) => {
          const current = await transaction.gitHubPublication.findUnique({ where: { runId } });
          if (current === null) throw notFound("GitHub publication", runId);
          if (
            current.pullRequestOperationKey !== null &&
            current.pullRequestOperationKey !== operationKey
          ) {
            throw conflict(
              "GitHub pull request operation key does not match the persisted publication.",
            );
          }
          if (current.pullRequestNumber !== null && current.pullRequestNumber !== result.number) {
            throw conflict("A different GitHub pull request is already persisted for this run.");
          }
          if (current.pullRequestNumber === null) {
            await transaction.gitHubPublication.update({
              where: { runId },
              data: {
                pullRequestOperationKey: operationKey,
                pullRequestNumber: result.number,
                pullRequestUrl: result.url,
                pullRequestState: result.state,
              },
            });
            await appendEvent(transaction, {
              runId,
              type: "PR_CREATED",
              occurredAt: new Date().toISOString(),
              payload: {
                number: result.number,
                url: result.url,
                state: result.state,
                idempotent: result.idempotent,
              },
            });
          }
        }),
    );
  }
}

class PrismaBenchmarkExecutionStore implements BenchmarkExecutionStore {
  constructor(private readonly client: PrismaClient) {}

  async startSuite(
    input: StartBenchmarkSuiteExecutionInput,
  ): Promise<BenchmarkSuiteExecutionRecord> {
    assertCredentialFreeSourceUris(input.profile);
    return await databaseCall(async () => {
      const current = await this.client.benchmarkSuiteExecution.findUnique({
        where: { id: input.id },
      });
      if (current !== null) {
        if (
          current.suiteId !== input.suiteId ||
          current.suiteVersion !== input.suiteVersion ||
          current.pricingVersion !== input.pricingVersion
        ) {
          throw conflict("Benchmark suite execution id is already used by another definition.");
        }
        return mapBenchmarkSuiteExecution(current);
      }
      return mapBenchmarkSuiteExecution(
        await this.client.benchmarkSuiteExecution.create({
          data: {
            id: input.id,
            suiteId: input.suiteId,
            suiteVersion: input.suiteVersion,
            profile: jsonInput(input.profile),
            pricingVersion: input.pricingVersion,
          },
        }),
      );
    });
  }

  async startCase(input: StartBenchmarkCaseExecutionInput): Promise<BenchmarkCaseExecutionRecord> {
    assertCredentialFreeSourceUris(input.definition);
    assertCredentialFreeSourceUris(input.profile);
    return await databaseCall(async () => {
      const current = await this.client.benchmarkCaseExecution.findUnique({
        where: { id: input.id },
      });
      if (current !== null) {
        if (
          current.suiteExecutionId !== (input.suiteExecutionId ?? null) ||
          current.suiteId !== input.suiteId ||
          current.suiteVersion !== input.suiteVersion ||
          current.caseId !== input.caseId ||
          current.caseVersion !== input.caseVersion ||
          current.definitionDigest !== input.definitionDigest
        ) {
          throw conflict("Benchmark case execution id is already used by another definition.");
        }
        return mapBenchmarkCaseExecution(current);
      }
      return mapBenchmarkCaseExecution(
        await this.client.benchmarkCaseExecution.create({
          data: {
            id: input.id,
            ...(input.suiteExecutionId === undefined
              ? {}
              : { suiteExecutionId: input.suiteExecutionId }),
            suiteId: input.suiteId,
            suiteVersion: input.suiteVersion,
            caseId: input.caseId,
            caseVersion: input.caseVersion,
            definitionDigest: input.definitionDigest,
            definition: jsonInput(input.definition),
            profile: jsonInput(input.profile),
          },
        }),
      );
    });
  }

  async attachRun(executionId: string, runId: string): Promise<BenchmarkCaseExecutionRecord> {
    return await databaseCall(async () => {
      const current = await this.requireCase(executionId);
      if (current.runId !== null && current.runId !== runId) {
        throw conflict("Benchmark case execution is already attached to another Run.");
      }
      if (isTerminalBenchmarkStatus(current.status)) return mapBenchmarkCaseExecution(current);
      return mapBenchmarkCaseExecution(
        await this.client.benchmarkCaseExecution.update({
          where: { id: executionId },
          data: { runId, status: "RUNNING" },
        }),
      );
    });
  }

  async markEvaluating(executionId: string): Promise<BenchmarkCaseExecutionRecord> {
    return await databaseCall(async () => {
      const current = await this.requireCase(executionId);
      if (current.status === "EVALUATING") return mapBenchmarkCaseExecution(current);
      if (current.status !== "RUNNING") {
        throw conflict(`Benchmark case cannot enter evaluation from ${current.status}.`);
      }
      return mapBenchmarkCaseExecution(
        await this.client.benchmarkCaseExecution.update({
          where: { id: executionId },
          data: { status: "EVALUATING" },
        }),
      );
    });
  }

  async recordObservation(
    executionId: string,
    observation: unknown,
  ): Promise<BenchmarkCaseExecutionRecord> {
    assertCredentialFreeSourceUris(observation);
    return await databaseCall(async () => {
      const current = await this.requireCase(executionId);
      if (isTerminalBenchmarkStatus(current.status)) {
        throw conflict("A terminal benchmark case observation cannot be replaced.");
      }
      return mapBenchmarkCaseExecution(
        await this.client.benchmarkCaseExecution.update({
          where: { id: executionId },
          data: { observation: jsonInput(observation) },
        }),
      );
    });
  }

  async completeCase(
    executionId: string,
    input: { result: unknown; metrics: unknown; provenance: unknown; succeeded: boolean },
  ): Promise<BenchmarkCaseExecutionRecord> {
    assertCredentialFreeSourceUris(input.result);
    assertCredentialFreeSourceUris(input.metrics);
    assertCredentialFreeSourceUris(input.provenance);
    return await databaseCall(async () => {
      const current = await this.requireCase(executionId);
      if (isTerminalBenchmarkStatus(current.status)) {
        if (jsonEqual(current.result, input.result)) return mapBenchmarkCaseExecution(current);
        throw conflict("A terminal benchmark case result cannot be replaced.");
      }
      return mapBenchmarkCaseExecution(
        await this.client.benchmarkCaseExecution.update({
          where: { id: executionId },
          data: {
            status: input.succeeded ? "SUCCEEDED" : "FAILED",
            result: jsonInput(input.result),
            metrics: jsonInput(input.metrics),
            provenance: jsonInput(input.provenance),
            finishedAt: new Date(),
          },
        }),
      );
    });
  }

  async failCase(executionId: string, failure: unknown): Promise<BenchmarkCaseExecutionRecord> {
    assertCredentialFreeSourceUris(failure);
    return await databaseCall(async () => {
      const current = await this.requireCase(executionId);
      if (isTerminalBenchmarkStatus(current.status)) return mapBenchmarkCaseExecution(current);
      return mapBenchmarkCaseExecution(
        await this.client.benchmarkCaseExecution.update({
          where: { id: executionId },
          data: { status: "FAILED", failure: jsonInput(failure), finishedAt: new Date() },
        }),
      );
    });
  }

  async completeSuite(
    suiteExecutionId: string,
    input: { result: unknown; metrics: unknown; succeeded: boolean },
  ): Promise<BenchmarkSuiteExecutionRecord> {
    assertCredentialFreeSourceUris(input.result);
    assertCredentialFreeSourceUris(input.metrics);
    return await databaseCall(async () => {
      const current = await this.requireSuite(suiteExecutionId);
      if (isTerminalBenchmarkStatus(current.status)) {
        if (jsonEqual(current.result, input.result)) return mapBenchmarkSuiteExecution(current);
        throw conflict("A terminal benchmark suite result cannot be replaced.");
      }
      return mapBenchmarkSuiteExecution(
        await this.client.benchmarkSuiteExecution.update({
          where: { id: suiteExecutionId },
          data: {
            status: input.succeeded ? "SUCCEEDED" : "FAILED",
            result: jsonInput(input.result),
            metrics: jsonInput(input.metrics),
            finishedAt: new Date(),
          },
        }),
      );
    });
  }

  async failSuite(
    suiteExecutionId: string,
    failure: unknown,
  ): Promise<BenchmarkSuiteExecutionRecord> {
    assertCredentialFreeSourceUris(failure);
    return await databaseCall(async () => {
      const current = await this.requireSuite(suiteExecutionId);
      if (isTerminalBenchmarkStatus(current.status)) return mapBenchmarkSuiteExecution(current);
      return mapBenchmarkSuiteExecution(
        await this.client.benchmarkSuiteExecution.update({
          where: { id: suiteExecutionId },
          data: { status: "FAILED", failure: jsonInput(failure), finishedAt: new Date() },
        }),
      );
    });
  }

  async findCase(executionId: string): Promise<BenchmarkCaseExecutionRecord | null> {
    return await databaseCall(async () => {
      const record = await this.client.benchmarkCaseExecution.findUnique({
        where: { id: executionId },
      });
      return record === null ? null : mapBenchmarkCaseExecution(record);
    });
  }

  async findCaseByRunId(runId: string): Promise<BenchmarkCaseExecutionRecord | null> {
    return await databaseCall(async () => {
      const record = await this.client.benchmarkCaseExecution.findUnique({ where: { runId } });
      return record === null ? null : mapBenchmarkCaseExecution(record);
    });
  }

  async findSuite(suiteExecutionId: string): Promise<BenchmarkSuiteExecutionRecord | null> {
    return await databaseCall(async () => {
      const record = await this.client.benchmarkSuiteExecution.findUnique({
        where: { id: suiteExecutionId },
      });
      return record === null ? null : mapBenchmarkSuiteExecution(record);
    });
  }

  async listCases(suiteId: string): Promise<readonly BenchmarkCaseExecutionRecord[]> {
    return await databaseCall(async () =>
      (
        await this.client.benchmarkCaseExecution.findMany({
          where: { suiteId },
          orderBy: [{ startedAt: "asc" }, { id: "asc" }],
        })
      ).map(mapBenchmarkCaseExecution),
    );
  }

  async listUnfinished(limit = 100): Promise<readonly BenchmarkCaseExecutionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "Benchmark recovery limit must be between 1 and 1000.",
      });
    }
    return await databaseCall(async () =>
      (
        await this.client.benchmarkCaseExecution.findMany({
          where: { status: { in: ["QUEUED", "RUNNING", "EVALUATING"] } },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: limit,
        })
      ).map(mapBenchmarkCaseExecution),
    );
  }

  async recoverInterrupted(staleBefore: Date): Promise<number> {
    return await databaseCall(async () => {
      const recovered = await this.client.benchmarkCaseExecution.updateMany({
        where: {
          status: { in: ["QUEUED", "RUNNING", "EVALUATING"] },
          updatedAt: { lt: staleBefore },
        },
        data: {
          status: "INTERRUPTED",
          failure: {
            code: "WORKER_INTERRUPTED",
            message: "Benchmark worker stopped unexpectedly.",
          },
          finishedAt: new Date(),
        },
      });
      return recovered.count;
    });
  }

  private async requireCase(executionId: string): Promise<PrismaBenchmarkCaseExecution> {
    const record = await this.client.benchmarkCaseExecution.findUnique({
      where: { id: executionId },
    });
    if (record === null) throw notFound("Benchmark case execution", executionId);
    return record;
  }

  private async requireSuite(suiteExecutionId: string): Promise<PrismaBenchmarkSuiteExecution> {
    const record = await this.client.benchmarkSuiteExecution.findUnique({
      where: { id: suiteExecutionId },
    });
    if (record === null) throw notFound("Benchmark suite execution", suiteExecutionId);
    return record;
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
    ...(task.baseCommitSha === null ? {} : { baseCommitSha: task.baseCommitSha }),
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

function mapGitHubPublication(publication: PrismaGitHubPublication): GitHubPublicationRecord {
  return {
    runId: publication.runId,
    repository: {
      owner: publication.repositoryOwner,
      name: publication.repositoryName,
    },
    baseCommit: publication.baseCommit,
    baseBranch: publication.baseBranch,
    branchName: publication.branchName,
    pushOperationKey: publication.pushOperationKey,
    ...(publication.changesArtifactId === null
      ? {}
      : { changesArtifactId: publication.changesArtifactId }),
    ...(publication.commitSha === null ? {} : { commitSha: publication.commitSha }),
    ...(publication.branchUrl === null ? {} : { branchUrl: publication.branchUrl }),
    ...(publication.pullRequestOperationKey === null
      ? {}
      : { pullRequestOperationKey: publication.pullRequestOperationKey }),
    ...(publication.pullRequestNumber === null
      ? {}
      : { pullRequestNumber: publication.pullRequestNumber }),
    ...(publication.pullRequestUrl === null ? {} : { pullRequestUrl: publication.pullRequestUrl }),
    ...(publication.pullRequestState === null
      ? {}
      : { pullRequestState: publication.pullRequestState as "open" | "closed" }),
  };
}

function mapBenchmarkSuiteExecution(
  execution: PrismaBenchmarkSuiteExecution,
): BenchmarkSuiteExecutionRecord {
  return {
    id: execution.id,
    suiteId: execution.suiteId,
    suiteVersion: execution.suiteVersion,
    status: execution.status,
    profile: execution.profile,
    pricingVersion: execution.pricingVersion,
    ...(execution.metrics === null ? {} : { metrics: execution.metrics }),
    ...(execution.result === null ? {} : { result: execution.result }),
    ...(execution.failure === null ? {} : { failure: execution.failure }),
    startedAt: execution.startedAt.toISOString(),
    ...(execution.finishedAt === null ? {} : { finishedAt: execution.finishedAt.toISOString() }),
    updatedAt: execution.updatedAt.toISOString(),
  };
}

function mapBenchmarkCaseExecution(
  execution: PrismaBenchmarkCaseExecution,
): BenchmarkCaseExecutionRecord {
  return {
    id: execution.id,
    ...(execution.suiteExecutionId === null
      ? {}
      : { suiteExecutionId: execution.suiteExecutionId }),
    suiteId: execution.suiteId,
    suiteVersion: execution.suiteVersion,
    caseId: execution.caseId,
    caseVersion: execution.caseVersion,
    status: execution.status,
    ...(execution.runId === null ? {} : { runId: execution.runId }),
    definitionDigest: execution.definitionDigest,
    definition: execution.definition,
    profile: execution.profile,
    ...(execution.observation === null ? {} : { observation: execution.observation }),
    ...(execution.metrics === null ? {} : { metrics: execution.metrics }),
    ...(execution.provenance === null ? {} : { provenance: execution.provenance }),
    ...(execution.result === null ? {} : { result: execution.result }),
    ...(execution.failure === null ? {} : { failure: execution.failure }),
    startedAt: execution.startedAt.toISOString(),
    ...(execution.finishedAt === null ? {} : { finishedAt: execution.finishedAt.toISOString() }),
    updatedAt: execution.updatedAt.toISOString(),
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
  const legacyMetrics: RunResult["metrics"] = {
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
  };
  const parsedMetrics = RunMetricsSchema.safeParse(run.metricsDetail);
  const persistedMetrics = parsedMetrics.success ? parsedMetrics.data : undefined;
  return {
    runId: run.id,
    status: run.status,
    ...(run.summary === null ? {} : { summary: run.summary }),
    metrics: persistedMetrics ?? legacyMetrics,
    ...(error === undefined ? {} : { error }),
  };
}

function stageForResult(result: RunResult): WorkflowStage {
  if (result.status === "SUCCEEDED") return "DONE";
  if (result.status === "CANCELLED") return "CANCELLED";
  return "FAILED";
}

function terminalEventForResult(
  result: RunResult,
  failedStage: WorkflowStage,
  occurredAt: Date,
): NewAgentEvent {
  if (result.status === "SUCCEEDED") {
    return {
      runId: result.runId,
      type: "RUN_COMPLETED",
      occurredAt: occurredAt.toISOString(),
      payload: {
        status: result.status,
        stage: "DONE",
        ...(result.summary === undefined ? {} : { summary: result.summary }),
        metrics: eventJson(result.metrics),
      },
    };
  }

  const cancelled = result.status === "CANCELLED";
  const code = result.error?.code ?? (cancelled ? "CANCELLED" : "INTERNAL_ERROR");
  const message =
    result.error?.message ??
    (cancelled ? "Run execution was cancelled." : "Run execution failed without an error message.");
  return {
    runId: result.runId,
    type: cancelled ? "RUN_CANCELLED" : "RUN_FAILED",
    level: cancelled ? "WARN" : "ERROR",
    occurredAt: occurredAt.toISOString(),
    payload: {
      status: result.status,
      stage: failedStage,
      terminalStage: stageForResult(result),
      code,
      message,
      error: eventJson(
        result.error ?? {
          code,
          message,
          retryable: false,
        },
      ),
      metrics: eventJson(result.metrics),
    },
  };
}

function assertSameIdempotentRun(existing: PrismaRun, input: CreateRunInput): void {
  if (existing.taskId !== input.taskId) {
    throw conflict("Idempotency key is already associated with another task.");
  }
  const mismatches = [
    existing.modelProvider !== (input.modelProvider ?? null) ? "modelProvider" : undefined,
    existing.modelName !== (input.modelName ?? null) ? "modelName" : undefined,
    existing.maxSteps !== (input.maxSteps ?? 25) ? "maxSteps" : undefined,
    existing.maxTestRetries !== (input.maxTestRetries ?? 3) ? "maxTestRetries" : undefined,
    existing.maxReviewRetries !== (input.maxReviewRetries ?? 1) ? "maxReviewRetries" : undefined,
  ].filter((field): field is string => field !== undefined);
  if (mismatches.length > 0) {
    throw conflict(
      `Idempotency key is already associated with different Run options: ${mismatches.join(", ")}.`,
    );
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

function isTerminalBenchmarkStatus(status: BenchmarkCaseExecutionRecord["status"]): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "INTERRUPTED";
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function assertSafeGitHubApprovalResolution(
  kind: PrismaApproval["kind"],
  input: ResolveApprovalInput,
): void {
  if (kind !== "GITHUB_PUSH" && kind !== "GITHUB_PULL_REQUEST") return;
  assertNoCredentialMaterial({
    ...(input.comment === undefined ? {} : { comment: input.comment }),
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
  });
}

function isWorkflowPlanRequest(value: unknown): boolean {
  return typeof value === "object" && value !== null && "plan" in value;
}

function assertSamePublication(
  current: PrismaGitHubPublication,
  input: Parameters<DatabaseGitHubPublicationStore["initialize"]>[1],
): void {
  if (
    current.repositoryOwner !== input.repository.owner ||
    current.repositoryName !== input.repository.name ||
    current.baseCommit !== input.baseCommit ||
    current.baseBranch !== input.baseBranch ||
    current.branchName !== input.branchName ||
    current.pushOperationKey !== input.pushOperationKey ||
    current.changesArtifactId !== input.changesArtifactId
  ) {
    throw conflict("Run already has different GitHub publication metadata.");
  }
}

function assertNoCredentialMaterial(value: unknown): void {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (
        /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u.test(candidate) ||
        /\b(?:authorization|access[_ -]?token|github[_ -]?token|password|secret|credential)\s*[:=]\s*(?:bearer\s+)?\S+/iu.test(
          candidate,
        ) ||
        /https?:\/\/[^/\s:@]+:[^/\s@]+@/iu.test(candidate) ||
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(candidate)
      ) {
        throw new DevflowError({
          code: "VALIDATION_ERROR",
          message: "GitHub workflow metadata must not contain credentials.",
        });
      }
      return;
    }
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (/(?:authorization|credential|password|secret|token)/iu.test(key)) {
        throw new DevflowError({
          code: "VALIDATION_ERROR",
          message: "GitHub workflow metadata contains a forbidden credential field.",
        });
      }
      visit(nested);
    }
  };
  visit(value);
}

function assertCredentialFreeSourceUris(value: unknown): void {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (key === "sourceUri" && typeof nested === "string") {
        assertCredentialFreeRepositoryUri(nested);
      }
      visit(nested);
    }
  };
  visit(value);
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
