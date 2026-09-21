export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type RepositorySourceKind = "LOCAL" | "GIT";
export type TaskStatus = "OPEN" | "COMPLETED" | "CANCELLED" | "ARCHIVED";
export type RunStatus =
  "QUEUED" | "RUNNING" | "WAITING_APPROVAL" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
export type WorkflowStage =
  | "START"
  | "ANALYZE_REPOSITORY"
  | "ANALYZE_TASK"
  | "GENERATE_PLAN"
  | "WAITING_APPROVAL"
  | "EXECUTE"
  | "TEST"
  | "FIX"
  | "REVIEW"
  | "GENERATE_DIFF"
  | "WAITING_PUSH_APPROVAL"
  | "PUSH"
  | "WAITING_PR_APPROVAL"
  | "CREATE_PR"
  | "DONE"
  | "FAILED"
  | "CANCELLED";

export interface RepositoryRecord {
  id: string;
  name: string;
  sourceKind: RepositorySourceKind;
  sourceUri: string;
  defaultBranch?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  repositoryId: string;
  title: string;
  description: string;
  status: TaskStatus;
  baseRef?: string;
  baseCommitSha?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  costUsd?: string;
}

export type RunComplexity = "SIMPLE" | "MEDIUM" | "COMPLEX";
export type RunMetricStage = "PLAN" | "EXECUTE" | "TEST" | "REPAIR" | "REVIEW";

export interface StageMetrics {
  steps: number;
  attempts: number;
  modelCalls: number;
  toolCalls: number;
  toolExecutions: number;
  cacheHits: number;
  modelLatencyMs: number;
  toolLatencyMs: number;
  wallLatencyMs: number;
  reasoningTokens: number;
  formatRepairCalls: number;
  tokenUsage: TokenUsage;
}

export type RunStageMetrics = Partial<Record<RunMetricStage, StageMetrics>>;

export interface RunControlMetrics {
  duplicateToolCalls: number;
  contextCacheHits: number;
  structuredOutputFailures: number;
  structuredOutputRepairAttempts: number;
  stalledDetections: number;
}

export interface AdaptiveBudgetMetrics {
  complexity: RunComplexity;
  estimatedSteps: number;
  confidence: number;
  softLimit: number;
  activeLimit: number;
  hardLimit: number;
  planSteps: number;
  executeSteps: number;
  repairSteps: number;
  reviewSteps: number;
  unusedSteps: number;
  budgetExtensions: number;
  rawEstimatedSteps?: number;
  adaptiveMargin?: number;
  estimateClamped?: boolean;
}

export interface RunMetrics {
  durationMs: number;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  toolExecutions?: number;
  cacheHits?: number;
  reasoningTokens?: number;
  retries: number;
  modelLatencyMs: number;
  toolLatencyMs: number;
  tokenUsage: TokenUsage;
  control?: RunControlMetrics;
  stages?: RunStageMetrics;
  budget?: AdaptiveBudgetMetrics;
  /** Legacy flat adaptive-budget fields retained for historical Runs and events. */
  complexity?: RunComplexity;
  complexityConfidence?: number;
  estimatedSteps?: number;
  softLimit?: number;
  hardLimit?: number;
  planSteps?: number;
  executeSteps?: number;
  repairSteps?: number;
  reviewSteps?: number;
  unusedSteps?: number;
  budgetExtensions?: number;
}

export interface RunResult {
  runId: string;
  status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  summary?: string;
  metrics: RunMetrics;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: JsonValue;
  };
}

export interface RunRecord {
  id: string;
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

export interface AgentEvent {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  stepId?: string;
  toolCallId?: string;
  sequence: number;
  occurredAt: string;
  type: string;
  level: "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";
  payload: JsonValue;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  stepId?: string;
  toolCallId?: string;
  kind: "PLAN" | "TOOL_CALL" | "GITHUB_PUSH" | "GITHUB_PULL_REQUEST";
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED";
  request: JsonValue;
  resolution?: JsonValue;
  comment?: string;
  actorId?: string;
  requestedAt: string;
  resolvedAt?: string;
  updatedAt: string;
}

export interface StepRecord {
  id: string;
  runId: string;
  sequence: number;
  stage: WorkflowStage;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "CANCELLED";
  title?: string;
  input?: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ToolCallRecord {
  id: string;
  runId: string;
  stepId: string;
  externalCallId?: string;
  name: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DENIED" | "TIMED_OUT" | "CANCELLED";
  input: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  createdAt?: string;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  stepId?: string;
  kind:
    | "PLAN"
    | "PATCH"
    | "DIFF"
    | "TEST_REPORT"
    | "REVIEW_REPORT"
    | "GITHUB_CHANGESET"
    | "LOG"
    | "OTHER";
  name: string;
  mimeType?: string;
  uri?: string;
  content?: string;
  sizeBytes?: number;
  sha256?: string;
  metadata?: JsonValue;
  createdAt: string;
}

export interface RunDetail {
  run: RunRecord;
  task: TaskRecord;
  repository: RepositoryRecord;
  steps: readonly StepRecord[];
  toolCalls: readonly ToolCallRecord[];
  events: readonly AgentEvent[];
  artifacts: readonly ArtifactRecord[];
  approvals: readonly ApprovalRecord[];
  githubPublication?: GitHubPublicationRecord;
}

export interface GitHubPublicationRecord {
  runId: string;
  repository: { owner: string; name: string };
  baseCommit: string;
  baseBranch: string;
  branchName: string;
  pushOperationKey: string;
  changesArtifactId?: string;
  commitSha?: string;
  branchUrl?: string;
  pullRequestOperationKey?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  pullRequestState?: "open" | "closed";
}

export interface CreateRepositoryInput {
  name: string;
  sourceKind: RepositorySourceKind;
  sourceUri: string;
  defaultBranch?: string;
}

export interface CreateTaskInput {
  repositoryId: string;
  title: string;
  description: string;
  baseRef?: string;
}

export interface CreateRunInput {
  taskId: string;
  idempotencyKey?: string;
  modelProvider?: string;
  modelName?: string;
  maxSteps?: number;
  maxTestRetries?: number;
  maxReviewRetries?: number;
}

export interface CreateRunResponse {
  run: RunRecord;
  created: boolean;
}

export interface ResolveApprovalInput {
  status: "APPROVED" | "REJECTED" | "CANCELLED";
  resolution?: JsonValue;
  comment?: string;
  actorId?: string;
}
