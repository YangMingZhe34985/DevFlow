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
import type {
  GitHubPublicationRecord,
  GitHubPublicationStore,
  GitHubRepository,
} from "@devflow/github";

export type RepositorySourceKind = "LOCAL" | "GIT";
export type ApprovalKind = "PLAN" | "TOOL_CALL" | "GITHUB_PUSH" | "GITHUB_PULL_REQUEST";
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED";
export type ArtifactKind =
  | "PLAN"
  | "PATCH"
  | "DIFF"
  | "TEST_REPORT"
  | "REVIEW_REPORT"
  | "GITHUB_CHANGESET"
  | "LOG"
  | "OTHER";

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
  baseCommitSha?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  repositoryId: string;
  title: string;
  description: string;
  baseRef?: string | undefined;
  baseCommitSha?: string | undefined;
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
  /** Persisted atomically with a newly-created Run before it can be queued. */
  initialArtifact?: Omit<CreateArtifactInput, "runId"> | undefined;
}

export interface RunTransitionInput {
  runId: RunId;
  expectedStatus: RunStatus;
  /** Optional stage compare-and-swap guard for callers that know the current workflow stage. */
  expectedStage?: WorkflowStage | undefined;
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
  findByIdempotencyKey(idempotencyKey: string): Promise<RunRecord | null>;
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
  pauseForGitHubApproval(
    runId: RunId,
    owner: string,
    input: PauseForGitHubApprovalInput,
  ): Promise<{ run: RunRecord; approval: ApprovalRecord }>;
  releaseForRetry(runId: RunId, owner: string, error: unknown): Promise<RunRecord>;
  /** Finalizes cancellation requests whose Worker lease can no longer do so. */
  finalizeExpiredCancellations?(now?: Date, limit?: number): Promise<number>;
  listRecoverable(now?: Date, limit?: number): Promise<readonly RunRecord[]>;
  transition(input: RunTransitionInput): Promise<PersistedRunTransition>;
}

export interface InitializeGitHubPublicationInput {
  repository: GitHubRepository;
  baseCommit: string;
  baseBranch: string;
  branchName: string;
  pushOperationKey: string;
  changesArtifactId: string;
}

export interface PauseForGitHubApprovalInput {
  kind: "GITHUB_PUSH" | "GITHUB_PULL_REQUEST";
  request: unknown;
  publication?: InitializeGitHubPublicationInput | undefined;
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

export interface DatabaseGitHubPublicationStore extends GitHubPublicationStore {
  initialize(
    runId: RunId,
    input: InitializeGitHubPublicationInput,
  ): Promise<GitHubPublicationRecord>;
}

export type BenchmarkExecutionStatus =
  "QUEUED" | "RUNNING" | "EVALUATING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED";

export interface BenchmarkSuiteExecutionRecord {
  id: string;
  suiteId: string;
  suiteVersion: string;
  status: BenchmarkExecutionStatus;
  profile: unknown;
  pricingVersion: string;
  metrics?: unknown;
  result?: unknown;
  failure?: unknown;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface BenchmarkCaseExecutionRecord {
  id: string;
  suiteExecutionId?: string;
  suiteId: string;
  suiteVersion: string;
  caseId: string;
  caseVersion: string;
  status: BenchmarkExecutionStatus;
  runId?: RunId;
  definitionDigest: string;
  definition: unknown;
  profile: unknown;
  observation?: unknown;
  metrics?: unknown;
  provenance?: unknown;
  result?: unknown;
  failure?: unknown;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface StartBenchmarkSuiteExecutionInput {
  id: string;
  suiteId: string;
  suiteVersion: string;
  profile: unknown;
  pricingVersion: string;
}

export interface StartBenchmarkCaseExecutionInput {
  id: string;
  suiteExecutionId?: string;
  suiteId: string;
  suiteVersion: string;
  caseId: string;
  caseVersion: string;
  definitionDigest: string;
  definition: unknown;
  profile: unknown;
}

/** Durable state for production benchmark execution and crash recovery. */
export interface BenchmarkExecutionStore {
  startSuite(input: StartBenchmarkSuiteExecutionInput): Promise<BenchmarkSuiteExecutionRecord>;
  startCase(input: StartBenchmarkCaseExecutionInput): Promise<BenchmarkCaseExecutionRecord>;
  attachRun(executionId: string, runId: RunId): Promise<BenchmarkCaseExecutionRecord>;
  markEvaluating(executionId: string): Promise<BenchmarkCaseExecutionRecord>;
  recordObservation(
    executionId: string,
    observation: unknown,
  ): Promise<BenchmarkCaseExecutionRecord>;
  completeCase(
    executionId: string,
    input: { result: unknown; metrics: unknown; provenance: unknown; succeeded: boolean },
  ): Promise<BenchmarkCaseExecutionRecord>;
  failCase(executionId: string, failure: unknown): Promise<BenchmarkCaseExecutionRecord>;
  completeSuite(
    suiteExecutionId: string,
    input: { result: unknown; metrics: unknown; succeeded: boolean },
  ): Promise<BenchmarkSuiteExecutionRecord>;
  failSuite(suiteExecutionId: string, failure: unknown): Promise<BenchmarkSuiteExecutionRecord>;
  findCase(executionId: string): Promise<BenchmarkCaseExecutionRecord | null>;
  findCaseByRunId(runId: RunId): Promise<BenchmarkCaseExecutionRecord | null>;
  findSuite(suiteExecutionId: string): Promise<BenchmarkSuiteExecutionRecord | null>;
  listCases(suiteId: string): Promise<readonly BenchmarkCaseExecutionRecord[]>;
  listUnfinished(limit?: number): Promise<readonly BenchmarkCaseExecutionRecord[]>;
  recoverInterrupted(staleBefore: Date): Promise<number>;
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
  githubPublication?: GitHubPublicationRecord | undefined;
}

export interface DatabaseAdapter extends DatabaseLifecycle {
  readonly repositories: RepositoryStore;
  readonly tasks: TaskStore;
  readonly runs: RunRepository;
  readonly approvals: ApprovalStore;
  readonly artifacts: ArtifactStore;
  readonly githubPublications: DatabaseGitHubPublicationStore;
  readonly benchmarkExecutions: BenchmarkExecutionStore;
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
