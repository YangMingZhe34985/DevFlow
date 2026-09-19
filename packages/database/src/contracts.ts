import type {
  AgentPlan,
  AgentEvent,
  EventSink,
  NewAgentEvent,
  RunId,
  RunResult,
  RunStatus,
  TaskStatus,
  WorkflowStage,
} from "@devflow/shared";

export type RepositorySourceKind = "LOCAL" | "GIT";
export type ApprovalKind = "PLAN" | "TOOL_CALL";
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED";
export type ArtifactKind =
  "PLAN" | "PATCH" | "DIFF" | "TEST_REPORT" | "REVIEW_REPORT" | "LOG" | "OTHER";

export interface DatabaseLifecycle {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<void>;
}

export interface RepositoryRecord {
  id: string;
  name: string;
  sourceKind: RepositorySourceKind;
  sourceUri: string;
  defaultBranch?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRepositoryInput {
  name: string;
  sourceKind: RepositorySourceKind;
  sourceUri: string;
  defaultBranch?: string | undefined;
}

export interface UpdateRepositoryInput {
  name?: string | undefined;
  sourceUri?: string | undefined;
  defaultBranch?: string | null | undefined;
}

export interface RepositoryStore {
  create(input: CreateRepositoryInput): Promise<RepositoryRecord>;
  list(): Promise<readonly RepositoryRecord[]>;
  findById(id: string): Promise<RepositoryRecord | null>;
  update(id: string, input: UpdateRepositoryInput): Promise<RepositoryRecord>;
  delete(id: string): Promise<void>;
}

export interface TaskRecord {
  id: string;
  repositoryId: string;
  title: string;
  description: string;
  status: TaskStatus;
  baseRef?: string | undefined;
  baseCommit?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  repositoryId: string;
  title: string;
  description: string;
  baseRef?: string | undefined;
  baseCommit?: string | undefined;
}

export interface UpdateTaskInput {
  title?: string | undefined;
  description?: string | undefined;
  status?: TaskStatus | undefined;
}

export interface TaskStore {
  create(input: CreateTaskInput): Promise<TaskRecord>;
  list(repositoryId?: string): Promise<readonly TaskRecord[]>;
  findById(id: string): Promise<TaskRecord | null>;
  update(id: string, input: UpdateTaskInput): Promise<TaskRecord>;
  delete(id: string): Promise<void>;
}

export interface RunRecord {
  id: RunId;
  taskId: string;
  idempotencyKey?: string;
  status: RunStatus;
  currentStage: WorkflowStage;
  maxSteps: number;
  maxTestRetries: number;
  maxReviewRetries: number;
  dispatchRevision: number;
  retryCount: number;
  executionOwner?: string;
  leaseExpiresAt?: string;
  cancellationRequested: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: RunResult;
}

export interface RunExecutionRecord extends RunRecord {
  task: TaskRecord;
  repository: RepositoryRecord;
  modelProvider?: string;
  modelName?: string;
}

export interface CreateRunInput {
  taskId: string;
  idempotencyKey?: string | undefined;
  modelProvider?: string | undefined;
  modelName?: string | undefined;
  maxSteps?: number | undefined;
  maxTestRetries?: number | undefined;
  maxReviewRetries?: number | undefined;
}

export interface RunTransitionInput {
  runId: RunId;
  expectedStatus: RunStatus;
  status: RunStatus;
  currentStage: WorkflowStage;
  event: NewAgentEvent;
}

export interface PersistedRunTransition {
  run: RunRecord;
  event: AgentEvent;
}

export interface RunRepository {
  create(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }>;
  list(taskId?: string): Promise<readonly RunRecord[]>;
  findById(runId: RunId): Promise<RunRecord | null>;
  findExecutionById(runId: RunId): Promise<RunExecutionRecord | null>;
  findDetail(runId: RunId): Promise<RunDetailRecord | null>;
  requestCancellation(runId: RunId): Promise<RunRecord>;
  claim(
    runId: RunId,
    owner: string,
    leaseMs: number,
    dispatchRevision?: number,
  ): Promise<RunExecutionRecord | null>;
  renewLease(runId: RunId, owner: string, leaseMs: number): Promise<boolean>;
  isCancellationRequested(runId: RunId): Promise<boolean>;
  complete(runId: RunId, owner: string, result: RunResult): Promise<RunRecord>;
  pauseForApproval(
    runId: RunId,
    owner: string,
    plan: AgentPlan,
  ): Promise<{ run: RunRecord; approval: ApprovalRecord }>;
  releaseForRetry(runId: RunId, owner: string, error: unknown): Promise<RunRecord>;
  listRecoverable(now?: Date, limit?: number): Promise<readonly RunRecord[]>;
  transition(input: RunTransitionInput): Promise<PersistedRunTransition>;
}

export interface ApprovalRecord {
  id: string;
  runId: RunId;
  kind: ApprovalKind;
  status: ApprovalStatus;
  request: unknown;
  resolution?: unknown;
  comment?: string | undefined;
  actorId?: string | undefined;
  requestedAt: string;
  resolvedAt?: string;
  updatedAt: string;
}

export interface CreateApprovalInput {
  runId: RunId;
  kind: ApprovalKind;
  request: unknown;
}

export interface ResolveApprovalInput {
  status: "APPROVED" | "REJECTED" | "CANCELLED";
  resolution?: unknown;
  comment?: string | undefined;
  actorId?: string | undefined;
}

export interface ApprovalStore {
  create(input: CreateApprovalInput): Promise<ApprovalRecord>;
  list(runId?: RunId): Promise<readonly ApprovalRecord[]>;
  findById(id: string): Promise<ApprovalRecord | null>;
  resolve(id: string, input: ResolveApprovalInput): Promise<ApprovalRecord>;
  resolveForWorkflow(
    id: string,
    input: ResolveApprovalInput,
  ): Promise<{
    approval: ApprovalRecord;
    run?: RunRecord | undefined;
    shouldEnqueue: boolean;
  }>;
}

export interface StepRecord {
  id: string;
  runId: RunId;
  sequence: number;
  stage: WorkflowStage;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "CANCELLED";
  title?: string | undefined;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  durationMs?: number | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCallRecord {
  id: string;
  runId: RunId;
  stepId: string;
  externalCallId?: string | undefined;
  name: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DENIED" | "TIMED_OUT" | "CANCELLED";
  input: unknown;
  output?: unknown;
  error?: unknown;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  durationMs?: number | undefined;
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  runId: RunId;
  stepId?: string | undefined;
  kind: ArtifactKind;
  name: string;
  mimeType?: string | undefined;
  uri?: string | undefined;
  content?: string | undefined;
  sizeBytes?: number | undefined;
  sha256?: string | undefined;
  metadata?: unknown;
  createdAt: string;
}

export interface CreateArtifactInput {
  runId: RunId;
  stepId?: string | undefined;
  kind: ArtifactKind;
  name: string;
  mimeType?: string | undefined;
  uri?: string | undefined;
  content?: string | undefined;
  sizeBytes?: number | undefined;
  sha256?: string | undefined;
  metadata?: unknown;
}

export interface ArtifactStore {
  create(input: CreateArtifactInput): Promise<ArtifactRecord>;
  list(runId: RunId): Promise<readonly ArtifactRecord[]>;
}

export interface RunDetailRecord {
  run: RunRecord;
  task: TaskRecord;
  repository: RepositoryRecord;
  steps: readonly StepRecord[];
  toolCalls: readonly ToolCallRecord[];
  events: readonly AgentEvent[];
  artifacts: readonly ArtifactRecord[];
  approvals: readonly ApprovalRecord[];
}

export interface DatabaseAdapter extends DatabaseLifecycle {
  readonly repositories: RepositoryStore;
  readonly tasks: TaskStore;
  readonly runs: RunRepository;
  readonly approvals: ApprovalStore;
  readonly artifacts: ArtifactStore;
  readonly events: EventStore;
}

export interface AtomicEventWriter extends EventSink {
  append(event: NewAgentEvent): Promise<AgentEvent>;
}

export interface EventQuery {
  /** Exclusive event sequence cursor. */
  afterSequence?: number | undefined;
  limit?: number | undefined;
}

export interface EventStore extends AtomicEventWriter {
  /**
   * Reads a stable ascending slice of a run's persisted event log.
   * Only events whose sequence is strictly greater than `afterSequence` are returned.
   */
  list(runId: RunId, query?: EventQuery): Promise<readonly AgentEvent[]>;
}
