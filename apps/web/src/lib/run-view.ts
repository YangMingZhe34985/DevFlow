import type {
  AgentEvent,
  ApprovalRecord,
  ArtifactRecord,
  JsonValue,
  RunDetail,
  RunMetrics,
  StepRecord,
  ToolCallRecord,
} from "./types";

export interface PlanView {
  summary?: string;
  steps: readonly { id: string; title: string; description?: string }[];
  raw: JsonValue;
}

export interface MetricItem {
  label: string;
  value: string;
}

export function extractPlan(
  detail: RunDetail,
  events: readonly AgentEvent[],
): PlanView | undefined {
  const planArtifact = [...detail.artifacts].reverse().find((artifact) => artifact.kind === "PLAN");
  const artifactValue = parseArtifact(planArtifact);
  const planApproval = [...detail.approvals].reverse().find((approval) => approval.kind === "PLAN");
  const approvalValue = planApproval?.request;
  const eventValue = [...events]
    .reverse()
    .find(
      (event) => event.type === "PLAN_GENERATED" || event.type === "APPROVAL_REQUIRED",
    )?.payload;

  for (const candidate of [artifactValue, approvalValue, eventValue]) {
    const plan = normalizePlan(candidate);
    if (plan !== undefined) return plan;
  }
  return undefined;
}

export function mergeSteps(
  persisted: readonly StepRecord[],
  events: readonly AgentEvent[],
): readonly StepRecord[] {
  const records = new Map<string, StepRecord>(persisted.map((step) => [step.id, step]));
  for (const event of events) {
    if (event.type !== "STEP_STARTED" && event.type !== "STEP_COMPLETED") continue;
    const payload = asObject(event.payload);
    const payloadSequence = readNumber(payload, "step");
    const id = event.stepId ?? `event-step-${payloadSequence ?? event.sequence}`;
    const existing = records.get(id);
    const sequence = existing?.sequence ?? payloadSequence ?? event.sequence;
    records.set(id, {
      id,
      runId: event.runId,
      sequence,
      stage: existing?.stage ?? stageFromEvents(events, id, sequence),
      status: event.type === "STEP_COMPLETED" ? "SUCCEEDED" : (existing?.status ?? "RUNNING"),
      ...(existing?.title === undefined
        ? { title: `Agent step ${sequence}` }
        : { title: existing.title }),
      ...(existing?.input === undefined ? {} : { input: existing.input }),
      ...(existing?.output === undefined ? {} : { output: existing.output }),
      ...(existing?.error === undefined ? {} : { error: existing.error }),
      ...(existing?.startedAt === undefined
        ? event.type === "STEP_STARTED"
          ? { startedAt: event.occurredAt }
          : {}
        : { startedAt: existing.startedAt }),
      ...(event.type === "STEP_COMPLETED"
        ? { finishedAt: event.occurredAt }
        : existing?.finishedAt === undefined
          ? {}
          : { finishedAt: existing.finishedAt }),
      ...(existing?.durationMs === undefined ? {} : { durationMs: existing.durationMs }),
      ...(existing?.createdAt === undefined ? {} : { createdAt: existing.createdAt }),
      ...(existing?.updatedAt === undefined ? {} : { updatedAt: existing.updatedAt }),
    });
  }
  return [...records.values()].sort((left, right) => left.sequence - right.sequence);
}

export function mergeToolCalls(
  persisted: readonly ToolCallRecord[],
  events: readonly AgentEvent[],
): readonly ToolCallRecord[] {
  const records = new Map<string, ToolCallRecord>(
    persisted.map((toolCall) => [toolCall.id, toolCall]),
  );
  for (const event of events) {
    if (event.type !== "TOOL_CALL" && event.type !== "TOOL_RESULT") continue;
    const id = event.toolCallId ?? `event-tool-${event.sequence}`;
    const payload = asObject(event.payload);
    const existing = records.get(id);
    const ok = readBoolean(payload, "ok");
    records.set(id, {
      id,
      runId: event.runId,
      stepId: existing?.stepId ?? event.stepId ?? "unknown-step",
      ...(existing?.externalCallId === undefined
        ? {}
        : { externalCallId: existing.externalCallId }),
      name: existing?.name ?? readString(payload, "name") ?? "unknown tool",
      status:
        event.type === "TOOL_CALL"
          ? (existing?.status ?? "RUNNING")
          : ok === false
            ? "FAILED"
            : "SUCCEEDED",
      input: existing?.input ?? (payload?.input as JsonValue | undefined) ?? null,
      ...(event.type === "TOOL_RESULT" && payload?.output !== undefined
        ? { output: payload.output as JsonValue }
        : existing?.output === undefined
          ? {}
          : { output: existing.output }),
      ...(event.type === "TOOL_RESULT" && payload?.error !== undefined
        ? { error: payload.error as JsonValue }
        : existing?.error === undefined
          ? {}
          : { error: existing.error }),
      ...(existing?.startedAt === undefined
        ? event.type === "TOOL_CALL"
          ? { startedAt: event.occurredAt }
          : {}
        : { startedAt: existing.startedAt }),
      ...(event.type === "TOOL_RESULT"
        ? { finishedAt: event.occurredAt }
        : existing?.finishedAt === undefined
          ? {}
          : { finishedAt: existing.finishedAt }),
      ...(readNumber(payload, "durationMs") === undefined && existing?.durationMs === undefined
        ? {}
        : { durationMs: readNumber(payload, "durationMs") ?? existing?.durationMs ?? 0 }),
      ...(existing?.createdAt === undefined ? {} : { createdAt: existing.createdAt }),
    });
  }
  return [...records.values()].sort((left, right) =>
    (left.startedAt ?? left.createdAt ?? "").localeCompare(
      right.startedAt ?? right.createdAt ?? "",
    ),
  );
}

export function metricItems(
  detail: RunDetail,
  events: readonly AgentEvent[],
): readonly MetricItem[] {
  const metrics = detail.run.result?.metrics ?? metricsFromEvents(events);
  if (metrics === undefined) {
    return [
      { label: "Events", value: String(events.length) },
      { label: "Steps", value: String(mergeSteps(detail.steps, events).length) },
      { label: "Tool calls", value: String(mergeToolCalls(detail.toolCalls, events).length) },
      { label: "Queue retries", value: String(detail.run.retryCount) },
    ];
  }
  return [
    { label: "Duration", value: formatDuration(metrics.durationMs) },
    { label: "Steps", value: String(metrics.steps) },
    { label: "Model calls", value: String(metrics.modelCalls) },
    { label: "Tool calls", value: String(metrics.toolCalls) },
    { label: "Retries", value: String(metrics.retries) },
    { label: "Model latency", value: formatDuration(metrics.modelLatencyMs) },
    { label: "Tool latency", value: formatDuration(metrics.toolLatencyMs) },
    { label: "Tokens", value: metrics.tokenUsage.totalTokens.toLocaleString() },
    ...(metrics.tokenUsage.costUsd === undefined
      ? []
      : [{ label: "Cost", value: `$${metrics.tokenUsage.costUsd}` }]),
  ];
}

export function diffText(detail: RunDetail, events: readonly AgentEvent[]): string | undefined {
  const artifact = [...detail.artifacts]
    .reverse()
    .find((candidate) => candidate.kind === "DIFF" || candidate.kind === "PATCH");
  if (artifact?.content !== undefined) return artifact.content;
  if (artifact?.uri !== undefined) return `Artifact: ${artifact.uri}`;
  return findLatestText(events, ["diff", "patch", "unifiedDiff"]);
}

export function reviewText(detail: RunDetail, events: readonly AgentEvent[]): string | undefined {
  const artifact = [...detail.artifacts]
    .reverse()
    .find((candidate) => candidate.kind === "REVIEW_REPORT");
  if (artifact?.content !== undefined) return artifact.content;
  if (artifact?.metadata !== undefined) return formatJson(artifact.metadata);
  if (artifact?.uri !== undefined) return `Artifact: ${artifact.uri}`;
  return findLatestText(events, ["review", "reviewReport", "findings"]);
}

export function testEvents(events: readonly AgentEvent[]): readonly AgentEvent[] {
  return events.filter(
    (event) => event.type.startsWith("TEST_") || event.type.startsWith("REPAIR_"),
  );
}

export function eventSummary(event: AgentEvent): string {
  const payload = asObject(event.payload);
  const name = readString(payload, "name");
  if (name !== undefined) return name;
  const summary = readString(payload, "summary");
  if (summary !== undefined) return summary;
  const reason = readString(payload, "reason");
  if (reason !== undefined) return reason;
  const error = asObject(payload?.error);
  const errorMessage = readString(error, "message");
  if (errorMessage !== undefined) return errorMessage;
  const step = readNumber(payload, "step");
  if (step !== undefined) return `Step ${step}`;
  const ok = readBoolean(payload, "ok");
  if (ok !== undefined) return ok ? "Completed" : "Failed";
  return "";
}

export function approvalPlan(approval: ApprovalRecord): PlanView | undefined {
  return normalizePlan(approval.request);
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatDate(value: string | undefined): string {
  if (value === undefined) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "—";
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

function normalizePlan(value: unknown): PlanView | undefined {
  const outer = asObject(value);
  const nested = asObject(outer?.plan);
  const record = nested ?? outer;
  if (record === undefined) return undefined;
  const steps = record.steps;
  if (!Array.isArray(steps)) return undefined;
  const normalizedSteps = steps.flatMap((step, index) => {
    const item = asObject(step);
    const title = readString(item, "title") ?? readString(item, "name");
    if (title === undefined) return [];
    const description = readString(item, "description");
    return [
      {
        id: readString(item, "id") ?? `plan-step-${index + 1}`,
        title,
        ...(description === undefined ? {} : { description }),
      },
    ];
  });
  if (normalizedSteps.length === 0) return undefined;
  const summary = readString(record, "summary");
  return {
    ...(summary === undefined ? {} : { summary }),
    steps: normalizedSteps,
    raw: (nested ?? outer ?? null) as JsonValue,
  };
}

function parseArtifact(artifact: ArtifactRecord | undefined): unknown {
  if (artifact === undefined) return undefined;
  if (artifact.content !== undefined) {
    try {
      return JSON.parse(artifact.content) as unknown;
    } catch {
      return { summary: artifact.content, steps: [] };
    }
  }
  return artifact.metadata;
}

function stageFromEvents(
  events: readonly AgentEvent[],
  stepId: string,
  sequence: number,
): StepRecord["stage"] {
  const associated = events.filter(
    (event) => event.stepId === stepId || readNumber(asObject(event.payload), "step") === sequence,
  );
  if (associated.some((event) => event.type.startsWith("TEST_"))) return "TEST";
  if (associated.some((event) => event.type === "APPROVAL_REQUIRED")) return "WAITING_APPROVAL";
  return "EXECUTE";
}

function metricsFromEvents(events: readonly AgentEvent[]): RunMetrics | undefined {
  for (const event of [...events].reverse()) {
    const payload = asObject(event.payload);
    const metrics = asObject(payload?.metrics);
    const tokenUsage = asObject(metrics?.tokenUsage);
    if (metrics === undefined || tokenUsage === undefined) continue;
    const values = {
      durationMs: readNumber(metrics, "durationMs"),
      steps: readNumber(metrics, "steps"),
      modelCalls: readNumber(metrics, "modelCalls"),
      toolCalls: readNumber(metrics, "toolCalls"),
      retries: readNumber(metrics, "retries"),
      modelLatencyMs: readNumber(metrics, "modelLatencyMs"),
      toolLatencyMs: readNumber(metrics, "toolLatencyMs"),
      inputTokens: readNumber(tokenUsage, "inputTokens"),
      outputTokens: readNumber(tokenUsage, "outputTokens"),
      totalTokens: readNumber(tokenUsage, "totalTokens"),
    };
    if (Object.values(values).some((value) => value === undefined)) continue;
    const costUsd = readString(tokenUsage, "costUsd");
    return {
      durationMs: values.durationMs ?? 0,
      steps: values.steps ?? 0,
      modelCalls: values.modelCalls ?? 0,
      toolCalls: values.toolCalls ?? 0,
      retries: values.retries ?? 0,
      modelLatencyMs: values.modelLatencyMs ?? 0,
      toolLatencyMs: values.toolLatencyMs ?? 0,
      tokenUsage: {
        inputTokens: values.inputTokens ?? 0,
        outputTokens: values.outputTokens ?? 0,
        totalTokens: values.totalTokens ?? 0,
        ...(costUsd === undefined ? {} : { costUsd }),
      },
    };
  }
  return undefined;
}

function findLatestText(
  events: readonly AgentEvent[],
  keys: readonly string[],
): string | undefined {
  for (const event of [...events].reverse()) {
    const value = findText(event.payload, new Set(keys), 0);
    if (value !== undefined) return value;
  }
  return undefined;
}

function findText(value: unknown, keys: ReadonlySet<string>, depth: number): string | undefined {
  if (depth > 4) return undefined;
  const record = asObject(value);
  if (record === undefined) return undefined;
  for (const [key, nested] of Object.entries(record)) {
    if (keys.has(key)) {
      if (typeof nested === "string") return nested;
      if (nested !== undefined) return formatJson(nested);
    }
  }
  for (const nested of Object.values(record)) {
    const found = findText(nested, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
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

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}
