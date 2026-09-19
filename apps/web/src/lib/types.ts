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
  baseCommit?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: string;
}

export interface RunMetrics {
  durationMs: number;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  retries: number;
  modelLatencyMs: number;
  toolLatencyMs: number;
  tokenUsage: TokenUsage;
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
  kind: "PLAN" | "TOOL_CALL";
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
  kind: "PLAN" | "PATCH" | "DIFF" | "TEST_REPORT" | "REVIEW_REPORT" | "LOG" | "OTHER";
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
  baseCommit?: string;
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
