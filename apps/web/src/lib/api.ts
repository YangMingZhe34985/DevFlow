import type {
  AgentEvent,
  ApprovalRecord,
  CreateRepositoryInput,
  CreateRunInput,
  CreateRunResponse,
  CreateTaskInput,
  RepositoryRecord,
  ResolveApprovalInput,
  RunDetail,
  RunRecord,
  TaskRecord,
} from "./types";

const configuredBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();

export const API_BASE_URL = (configuredBaseUrl || "http://localhost:3001/api/v1").replace(
  /\/+$/u,
  "",
);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiUrl(
  path: string,
  query?: Readonly<Record<string, number | string | undefined>>,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${API_BASE_URL}${normalizedPath}`);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });

  const payload = await parseResponse(response);
  if (!response.ok) {
    const error = asObject(payload);
    const nestedError = asObject(error?.error);
    const message =
      readString(error, "message") ??
      readString(nestedError, "message") ??
      `${response.status} ${response.statusText}`;
    const code = readString(error, "code") ?? readString(nestedError, "code");
    throw new ApiError(message, response.status, code);
  }
  return payload as T;
}

export async function listRepositories(): Promise<readonly RepositoryRecord[]> {
  return await apiRequest<readonly RepositoryRecord[]>("/repositories");
}

export async function createRepository(input: CreateRepositoryInput): Promise<RepositoryRecord> {
  return await apiRequest<RepositoryRecord>("/repositories", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listTasks(): Promise<readonly TaskRecord[]> {
  return await apiRequest<readonly TaskRecord[]>("/tasks");
}

export async function createTask(input: CreateTaskInput): Promise<TaskRecord> {
  return await apiRequest<TaskRecord>("/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listRuns(): Promise<readonly RunRecord[]> {
  return await apiRequest<readonly RunRecord[]>("/runs");
}

export async function createRun(input: CreateRunInput): Promise<CreateRunResponse> {
  return await apiRequest<CreateRunResponse>("/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function cancelRun(runId: string): Promise<RunRecord> {
  return await apiRequest<RunRecord>(`/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
}

export async function getRunDetail(runId: string): Promise<RunDetail> {
  const encodedRunId = encodeURIComponent(runId);
  try {
    const detail = await apiRequest<RunDetail>(`/runs/${encodedRunId}/detail`);
    return normalizeDetail(detail);
  } catch (error) {
    // This fallback keeps the UI useful while a P4/P5 API is upgraded. P6 uses
    // the detail endpoint as its canonical snapshot once it is available.
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return await getLegacyRunDetail(encodedRunId);
  }
}

export async function listRunEvents(
  runId: string,
  afterSequence?: number,
  limit = 500,
  signal?: AbortSignal,
): Promise<readonly AgentEvent[]> {
  const payload = await apiRequest<unknown>(
    `/runs/${encodeURIComponent(runId)}/events${eventQuery(afterSequence, limit)}`,
    signal === undefined ? undefined : { signal },
  );
  if (Array.isArray(payload)) return payload as AgentEvent[];
  const record = asObject(payload);
  const events = record?.events ?? record?.items ?? record?.data;
  return Array.isArray(events) ? (events as AgentEvent[]) : [];
}

export async function resolveApproval(
  approvalId: string,
  input: ResolveApprovalInput,
): Promise<ApprovalRecord> {
  return await apiRequest<ApprovalRecord>(`/approvals/${encodeURIComponent(approvalId)}/resolve`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

async function getLegacyRunDetail(encodedRunId: string): Promise<RunDetail> {
  const run = await apiRequest<RunRecord>(`/runs/${encodedRunId}`);
  const [task, approvals, events] = await Promise.all([
    apiRequest<TaskRecord>(`/tasks/${encodeURIComponent(run.taskId)}`),
    apiRequest<readonly ApprovalRecord[]>(`/approvals?runId=${encodedRunId}`),
    listRunEvents(run.id),
  ]);
  const repository = await apiRequest<RepositoryRecord>(
    `/repositories/${encodeURIComponent(task.repositoryId)}`,
  );
  return { run, task, repository, approvals, events, steps: [], toolCalls: [], artifacts: [] };
}

function normalizeDetail(detail: RunDetail): RunDetail {
  return {
    ...detail,
    steps: Array.isArray(detail.steps) ? detail.steps : [],
    toolCalls: Array.isArray(detail.toolCalls) ? detail.toolCalls : [],
    events: Array.isArray(detail.events) ? detail.events : [],
    artifacts: Array.isArray(detail.artifacts) ? detail.artifacts : [],
    approvals: Array.isArray(detail.approvals) ? detail.approvals : [],
  };
}

function eventQuery(afterSequence: number | undefined, limit: number): string {
  const search = new URLSearchParams({ limit: String(limit) });
  if (afterSequence !== undefined) search.set("afterSequence", String(afterSequence));
  return `?${search.toString()}`;
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}
