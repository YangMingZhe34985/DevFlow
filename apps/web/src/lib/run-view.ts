import type {
  AdaptiveBudgetMetrics,
  AgentEvent,
  ApprovalRecord,
  ArtifactRecord,
  JsonValue,
  RunDetail,
  RunControlMetrics,
  RunComplexity,
  RunMetrics,
  RunRecord,
  RunStageMetrics,
  StageMetrics,
  StepRecord,
  ToolCallRecord,
  WorkflowStage,
} from "./types";

export interface PlanView {
  summary?: string;
  steps: readonly { id: string; title: string; description?: string }[];
  raw: JsonValue;
}

export interface MetricItem {
  key: string;
  label: string;
  value: string;
  group: MetricGroupId;
}

export type MetricGroupId = "primary" | "budget" | "operations" | "latency";

export interface MetricGroup {
  id: MetricGroupId;
  label: string;
  items: readonly MetricItem[];
}

export type WorkflowNodeId =
  | "PLAN"
  | "APPROVAL"
  | "EXECUTE"
  | "TEST"
  | "REPAIR"
  | "REVIEW"
  | "DIFF"
  | "PUSH"
  | "PR"
  | "RESULT";

export type WorkflowNodeState = "completed" | "running" | "failed" | "skipped" | "future";

export interface WorkflowItem {
  id: WorkflowNodeId;
  label: string;
  state: WorkflowNodeState;
  stages: readonly WorkflowStage[];
}

export type ReviewVerdict = "PASSED" | "CHANGES_REQUESTED" | "UNKNOWN";
export type ReviewFindingSeverity = "INFO" | "WARNING" | "ERROR";

export interface ReviewFindingView {
  severity: ReviewFindingSeverity;
  message: string;
}

export interface ReviewView {
  verdict: ReviewVerdict;
  approved?: boolean;
  summary?: string;
  findings: readonly ReviewFindingView[];
  raw: string;
  source: "ARTIFACT" | "EVENT";
}

export type ActivityStatus =
  "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "CANCELLED" | "WARNING";

export interface ActivityView {
  id: string;
  title: string;
  status: ActivityStatus;
  stage?: WorkflowStage;
  durationMs?: number;
  summary: string;
}

export interface StepActivityView extends ActivityView {
  step: StepRecord;
}

export interface ToolActivityView extends ActivityView {
  toolCall: ToolCallRecord;
}

export interface EventActivityView extends ActivityView {
  event: AgentEvent;
}

interface WorkflowDefinition {
  id: WorkflowNodeId;
  label: string;
  stages: readonly WorkflowStage[];
}

const WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] = [
  {
    id: "PLAN",
    label: "Plan",
    stages: ["START", "ANALYZE_REPOSITORY", "ANALYZE_TASK", "GENERATE_PLAN"],
  },
  { id: "APPROVAL", label: "Approval", stages: ["WAITING_APPROVAL"] },
  { id: "EXECUTE", label: "Execute", stages: ["EXECUTE"] },
  { id: "TEST", label: "Test", stages: ["TEST"] },
  { id: "REPAIR", label: "Repair", stages: ["FIX"] },
  { id: "REVIEW", label: "Review", stages: ["REVIEW"] },
  { id: "DIFF", label: "Diff", stages: ["GENERATE_DIFF"] },
  { id: "PUSH", label: "Push", stages: ["WAITING_PUSH_APPROVAL", "PUSH"] },
  { id: "PR", label: "Pull request", stages: ["WAITING_PR_APPROVAL", "CREATE_PR"] },
  { id: "RESULT", label: "Result", stages: ["DONE"] },
];

const WORKFLOW_STAGES = new Set<WorkflowStage>([
  "START",
  "ANALYZE_REPOSITORY",
  "ANALYZE_TASK",
  "GENERATE_PLAN",
  "WAITING_APPROVAL",
  "EXECUTE",
  "TEST",
  "FIX",
  "REVIEW",
  "GENERATE_DIFF",
  "WAITING_PUSH_APPROVAL",
  "PUSH",
  "WAITING_PR_APPROVAL",
  "CREATE_PR",
  "DONE",
  "FAILED",
  "CANCELLED",
]);

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

/** Returns the workflow stage that actually failed, rather than the terminal FAILED sentinel. */
export function failureStage(
  run: RunRecord,
  events: readonly AgentEvent[],
  steps: readonly StepRecord[] = [],
): WorkflowStage | undefined {
  const terminalEvent = [...events]
    .reverse()
    .find((event) => event.type === "RUN_FAILED" || event.type === "RUN_CANCELLED");
  const terminalPayloadStage = workflowStageFromValue(asObject(terminalEvent?.payload)?.stage);
  if (isProgressStage(terminalPayloadStage)) return terminalPayloadStage;

  for (const event of [...events].reverse()) {
    const stage = stageFromEvent(event);
    if (isProgressStage(stage)) return stage;
  }

  if (isProgressStage(run.currentStage)) return run.currentStage;

  const latestStep = [...steps]
    .filter((step) => isProgressStage(step.stage))
    .sort((left, right) => right.sequence - left.sequence)[0];
  return latestStep?.stage;
}

/** Builds the ten user-facing workflow nodes and their visual states. */
export function workflowItems(
  detail: RunDetail,
  events: readonly AgentEvent[],
): readonly WorkflowItem[] {
  const terminalFailure = ["FAILED", "TIMED_OUT", "CANCELLED"].includes(detail.run.status);
  const activeStage = terminalFailure
    ? (failureStage(detail.run, events, detail.steps) ?? "START")
    : detail.run.currentStage;
  const resolvedActiveIndex = WORKFLOW_DEFINITIONS.findIndex(({ stages }) =>
    stages.includes(activeStage),
  );
  const activeIndex = resolvedActiveIndex < 0 ? 0 : resolvedActiveIndex;
  const latestTestResult = [...events].reverse().find((event) => event.type === "TEST_RESULT");
  const testSkipped = readBoolean(asObject(latestTestResult?.payload), "skipped") === true;
  const repairOccurred =
    detail.steps.some((step) => step.stage === "FIX") ||
    events.some((event) => event.type === "REPAIR_STARTED" || event.type === "REPAIR_COMPLETED");
  const localRepository = detail.repository.sourceKind === "LOCAL";

  return WORKFLOW_DEFINITIONS.map((definition, index) => {
    if (localRepository && (definition.id === "PUSH" || definition.id === "PR")) {
      return { ...definition, state: "skipped" };
    }
    if (definition.id === "TEST" && testSkipped && index <= activeIndex) {
      return { ...definition, state: "skipped" };
    }
    if (
      definition.id === "REPAIR" &&
      !repairOccurred &&
      (index < activeIndex || detail.run.status === "SUCCEEDED")
    ) {
      return { ...definition, state: "skipped" };
    }

    let state: WorkflowNodeState;
    if (index < activeIndex) {
      state = "completed";
    } else if (index > activeIndex) {
      state = "future";
    } else if (terminalFailure) {
      state = "failed";
    } else if (detail.run.status === "SUCCEEDED") {
      state = "completed";
    } else {
      state = "running";
    }
    return { ...definition, state };
  });
}

export function toolActivities(
  toolCalls: readonly ToolCallRecord[],
  steps: readonly StepRecord[],
): readonly ToolActivityView[] {
  const stagesByStep = new Map(steps.map((step) => [step.id, step.stage]));
  return toolCalls.map((toolCall) => {
    const stage = stagesByStep.get(toolCall.stepId);
    const status = activityStatusFromTool(toolCall.status);
    const summary = [stage, status, formatDuration(toolCall.durationMs)]
      .filter((value) => value !== undefined && value !== "—")
      .join(" · ");
    return {
      id: toolCall.id,
      title: toolCall.name,
      status,
      ...(stage === undefined ? {} : { stage }),
      ...(toolCall.durationMs === undefined ? {} : { durationMs: toolCall.durationMs }),
      summary,
      toolCall,
    };
  });
}

export function stepActivities(steps: readonly StepRecord[]): readonly StepActivityView[] {
  return steps.map((step) => {
    const status = activityStatusFromStep(step.status);
    const summary = [step.stage, status, formatDuration(step.durationMs)]
      .filter((value) => value !== "—")
      .join(" · ");
    return {
      id: step.id,
      title: step.title ?? `Agent step ${String(step.sequence)}`,
      status,
      stage: step.stage,
      ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
      summary,
      step,
    };
  });
}

export function eventActivity(event: AgentEvent): EventActivityView {
  const payload = asObject(event.payload);
  const stage = stageFromEvent(event);
  const durationMs = readNumber(payload, "durationMs");
  const status = activityStatusFromEvent(event, payload);
  const detail = eventSummary(event);
  const summary = [stage, detail, formatDuration(durationMs)]
    .filter((value) => value !== undefined && value !== "" && value !== "—")
    .join(" · ");
  return {
    id: event.eventId,
    title: event.type,
    status,
    ...(stage === undefined ? {} : { stage }),
    ...(durationMs === undefined ? {} : { durationMs }),
    summary,
    event,
  };
}

export function metricItems(
  detail: RunDetail,
  events: readonly AgentEvent[],
): readonly MetricItem[] {
  return metricGroups(detail, events).flatMap((group) => group.items);
}

export function metricGroups(
  detail: RunDetail,
  events: readonly AgentEvent[],
): readonly MetricGroup[] {
  const metrics = detail.run.result?.metrics ?? metricsFromEvents(events);
  if (metrics === undefined) {
    const groups: MetricGroup[] = [
      {
        id: "primary",
        label: "Overview",
        items: [
          metricItem(
            "steps",
            "Actual steps",
            String(mergeSteps(detail.steps, events).length),
            "primary",
          ),
        ],
      },
    ];
    const budgetGroup = adaptiveBudgetMetricGroup(adaptiveBudgetView(detail, events));
    if (budgetGroup !== undefined) groups.push(budgetGroup);
    groups.push({
      id: "operations",
      label: "Operations",
      items: [
        metricItem("events", "Events", String(events.length), "operations"),
        metricItem(
          "toolCalls",
          "Tool calls",
          String(mergeToolCalls(detail.toolCalls, events).length),
          "operations",
        ),
        metricItem("queueRetries", "Queue retries", String(detail.run.retryCount), "operations"),
      ],
    });
    return groups;
  }

  const groups: MetricGroup[] = [
    {
      id: "primary",
      label: "Overview",
      items: [
        metricItem("duration", "Duration", formatDuration(metrics.durationMs), "primary"),
        metricItem("steps", "Actual steps", String(metrics.steps), "primary"),
        metricItem("tokens", "Tokens", metrics.tokenUsage.totalTokens.toLocaleString(), "primary"),
        ...(metrics.tokenUsage.costUsd === undefined
          ? []
          : [metricItem("cost", "Cost", `$${metrics.tokenUsage.costUsd}`, "primary")]),
      ],
    },
  ];

  const budgetGroup = adaptiveBudgetMetricGroup(adaptiveBudgetView(detail, events, metrics));
  if (budgetGroup !== undefined) groups.push(budgetGroup);

  groups.push(
    {
      id: "operations",
      label: "Operations",
      items: [
        metricItem("modelCalls", "Model calls", String(metrics.modelCalls), "operations"),
        metricItem("toolCalls", "Tool calls", String(metrics.toolCalls), "operations"),
        metricItem("retries", "Retries", String(metrics.retries), "operations"),
      ],
    },
    {
      id: "latency",
      label: "Latency",
      items: [
        metricItem(
          "modelLatency",
          "Model latency",
          formatDuration(metrics.modelLatencyMs),
          "latency",
        ),
        metricItem("toolLatency", "Tool latency", formatDuration(metrics.toolLatencyMs), "latency"),
      ],
    },
  );
  return groups;
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

/** Normalizes the persisted review artifact/event into a structured presentation model. */
export function reviewView(
  detail: RunDetail,
  events: readonly AgentEvent[],
): ReviewView | undefined {
  const artifact = [...detail.artifacts]
    .reverse()
    .find((candidate) => candidate.kind === "REVIEW_REPORT");
  if (artifact?.content !== undefined) {
    try {
      return normalizeReviewView(
        JSON.parse(artifact.content) as unknown,
        artifact.content,
        "ARTIFACT",
      );
    } catch {
      const summary = artifact.content.trim();
      return {
        verdict: "UNKNOWN",
        ...(summary.length === 0 ? {} : { summary }),
        findings: [],
        raw: artifact.content,
        source: "ARTIFACT",
      };
    }
  }

  if (artifact?.metadata !== undefined) {
    const normalized = normalizeReviewView(
      artifact.metadata,
      formatJson(artifact.metadata),
      "ARTIFACT",
    );
    if (reviewHasStructuredContent(normalized)) return normalized;
  }
  if (artifact?.uri !== undefined) {
    return {
      verdict: "UNKNOWN",
      summary: `Artifact: ${artifact.uri}`,
      findings: [],
      raw: artifact.uri,
      source: "ARTIFACT",
    };
  }

  const reviewEvent = [...events].reverse().find((event) => event.type === "REVIEW_RESULT");
  if (reviewEvent !== undefined) {
    return normalizeReviewView(reviewEvent.payload, formatJson(reviewEvent.payload), "EVENT");
  }
  return undefined;
}

export function testEvents(events: readonly AgentEvent[]): readonly AgentEvent[] {
  return events.filter(
    (event) => event.type.startsWith("TEST_") || event.type.startsWith("REPAIR_"),
  );
}

/**
 * Optimistically projects a durable terminal event into the Run snapshot. The
 * detail endpoint remains canonical, but the UI must not look RUNNING after SSE
 * has already delivered an atomic terminal transition.
 */
export function projectTerminalRun(run: RunRecord, events: readonly AgentEvent[]): RunRecord {
  const terminal = [...events]
    .reverse()
    .find((event) => ["RUN_COMPLETED", "RUN_FAILED", "RUN_CANCELLED"].includes(event.type));
  if (terminal === undefined) return run;

  const payload = asObject(terminal.payload);
  const status = terminalStatus(terminal, payload);
  const currentStage =
    status === "SUCCEEDED" ? "DONE" : status === "CANCELLED" ? "CANCELLED" : "FAILED";
  const metrics = metricsFromEvents([terminal]) ?? run.result?.metrics ?? emptyMetrics();
  const summary = readString(payload, "summary") ?? run.result?.summary;
  const nestedError = asObject(payload?.error);
  const code =
    readString(nestedError, "code") ??
    readString(payload, "code") ??
    (status === "CANCELLED" ? "CANCELLED" : "INTERNAL_ERROR");
  const message =
    readString(nestedError, "message") ??
    readString(payload, "message") ??
    (status === "CANCELLED" ? "Run execution was cancelled." : "Run execution failed.");
  const retryable = readBoolean(nestedError, "retryable");
  const details = nestedError?.details as JsonValue | undefined;

  return {
    ...run,
    status,
    currentStage,
    updatedAt: terminal.occurredAt,
    finishedAt: terminal.occurredAt,
    result: {
      runId: run.id,
      status,
      ...(summary === undefined ? {} : { summary }),
      metrics,
      ...(status === "SUCCEEDED"
        ? {}
        : {
            error: {
              code,
              message,
              ...(retryable === undefined ? {} : { retryable }),
              ...(details === undefined ? {} : { details }),
            },
          }),
    },
  };
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

function metricItem(key: string, label: string, value: string, group: MetricGroupId): MetricItem {
  return { key, label, value, group };
}

function adaptiveBudgetMetricGroup(
  budget: AdaptiveBudgetView | undefined,
): MetricGroup | undefined {
  if (budget === undefined) return undefined;
  const items: MetricItem[] = [];
  if (budget.complexity !== undefined) {
    items.push(metricItem("complexity", "Complexity", budget.complexity, "budget"));
  }
  if (budget.confidence !== undefined) {
    items.push(
      metricItem(
        "complexityConfidence",
        "Confidence",
        `${Math.round(budget.confidence * 100)}%`,
        "budget",
      ),
    );
  }
  if (budget.estimatedSteps !== undefined) {
    items.push(
      metricItem("estimatedSteps", "Estimated steps", String(budget.estimatedSteps), "budget"),
    );
  }
  if (budget.softLimit !== undefined && budget.activeLimit !== undefined) {
    items.push(metricItem("softLimit", "Soft limit", String(budget.softLimit), "budget"));
  }
  const displayedLimit = budget.activeLimit ?? budget.softLimit;
  if (displayedLimit !== undefined) {
    items.push(
      metricItem(
        "budget",
        "Budget",
        `${String(displayedLimit)} / ${String(budget.hardLimit)}`,
        "budget",
      ),
    );
  }
  if (budget.phaseSteps !== undefined) {
    items.push(metricItem("phaseSteps", "Phase steps", budget.phaseSteps, "budget"));
  }
  if (budget.unusedSteps !== undefined) {
    items.push(metricItem("unusedSteps", "Unused steps", String(budget.unusedSteps), "budget"));
  }
  if (budget.extensions !== undefined) {
    items.push(metricItem("budgetExtensions", "Extensions", String(budget.extensions), "budget"));
  }
  return { id: "budget", label: "Adaptive budget", items };
}

interface AdaptiveBudgetView {
  complexity?: string;
  confidence?: number;
  estimatedSteps?: number;
  softLimit?: number;
  activeLimit?: number;
  hardLimit: number;
  phaseSteps?: string;
  unusedSteps?: number;
  extensions?: number;
}

function adaptiveBudgetView(
  detail: RunDetail,
  events: readonly AgentEvent[],
  metrics?: RunMetrics,
): AdaptiveBudgetView | undefined {
  const budgetRecord = latestBudgetRecord(events);
  const limits = asObject(budgetRecord?.limits);
  const nested = metrics?.budget;
  const complexity =
    nested?.complexity ??
    metrics?.complexity ??
    normalizeComplexity(readString(budgetRecord, "complexity"));
  const confidence =
    nested?.confidence ??
    metrics?.complexityConfidence ??
    readNumber(budgetRecord, "confidence") ??
    readNumber(budgetRecord, "complexityConfidence");
  const estimatedSteps =
    nested?.estimatedSteps ?? metrics?.estimatedSteps ?? readNumber(budgetRecord, "estimatedSteps");
  const softLimit =
    nested?.softLimit ?? metrics?.softLimit ?? readNumber(budgetRecord, "softLimit");
  const activeLimit = nested?.activeLimit ?? readNumber(budgetRecord, "activeLimit");
  const hardLimit =
    nested?.hardLimit ??
    metrics?.hardLimit ??
    readNumber(budgetRecord, "hardLimit") ??
    readNumber(limits, "agentSteps") ??
    detail.run.maxSteps;
  const unusedSteps =
    nested?.unusedSteps ?? metrics?.unusedSteps ?? readNumber(budgetRecord, "unusedSteps");
  const extensions =
    nested?.budgetExtensions ??
    metrics?.budgetExtensions ??
    readNumber(budgetRecord, "budgetExtensions");
  const phaseValues = {
    Plan:
      nested?.planSteps ??
      metrics?.planSteps ??
      metrics?.stages?.PLAN?.steps ??
      readNumber(budgetRecord, "planSteps"),
    Execute:
      nested?.executeSteps ??
      metrics?.executeSteps ??
      metrics?.stages?.EXECUTE?.steps ??
      readNumber(budgetRecord, "executeSteps"),
    Repair:
      nested?.repairSteps ??
      metrics?.repairSteps ??
      metrics?.stages?.REPAIR?.steps ??
      readNumber(budgetRecord, "repairSteps"),
    Review:
      nested?.reviewSteps ??
      metrics?.reviewSteps ??
      metrics?.stages?.REVIEW?.steps ??
      readNumber(budgetRecord, "reviewSteps"),
  };
  const phaseSteps = Object.entries(phaseValues)
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([label, value]) => `${label} ${String(value)}`)
    .join(" · ");

  const hasAdaptiveBudget =
    complexity !== undefined ||
    confidence !== undefined ||
    estimatedSteps !== undefined ||
    softLimit !== undefined ||
    activeLimit !== undefined ||
    unusedSteps !== undefined ||
    extensions !== undefined ||
    phaseSteps.length > 0;
  if (!hasAdaptiveBudget) return undefined;
  return {
    ...(complexity === undefined ? {} : { complexity }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(estimatedSteps === undefined ? {} : { estimatedSteps }),
    ...(softLimit === undefined ? {} : { softLimit }),
    ...(activeLimit === undefined ? {} : { activeLimit }),
    hardLimit,
    ...(phaseSteps.length === 0 ? {} : { phaseSteps }),
    ...(unusedSteps === undefined ? {} : { unusedSteps }),
    ...(extensions === undefined ? {} : { extensions }),
  };
}

function latestBudgetRecord(events: readonly AgentEvent[]): Record<string, unknown> | undefined {
  for (const event of [...events].reverse()) {
    const payload = asObject(event.payload);
    const eventMetricsBudget = asObject(asObject(payload?.metrics)?.budget);
    if (eventMetricsBudget !== undefined) return eventMetricsBudget;
    const budget = asObject(payload?.budget);
    if (budget === undefined) continue;
    return asObject(budget.budget) ?? asObject(budget.adaptive) ?? budget;
  }
  return undefined;
}

function normalizeReviewView(
  value: unknown,
  raw: string,
  source: ReviewView["source"],
): ReviewView {
  const outer = asObject(value);
  const record = asObject(outer?.review) ?? asObject(outer?.reviewReport) ?? outer;
  const explicitApproved = readBoolean(record, "approved");
  const verdictValue = (readString(record, "verdict") ?? "").toUpperCase();
  const approved =
    explicitApproved ??
    (verdictValue === "PASS" || verdictValue === "PASSED" || verdictValue === "APPROVED"
      ? true
      : verdictValue === "FAIL" ||
          verdictValue === "FAILED" ||
          verdictValue === "REJECTED" ||
          verdictValue === "CHANGES_REQUESTED"
        ? false
        : undefined);
  const verdict: ReviewVerdict =
    approved === true ? "PASSED" : approved === false ? "CHANGES_REQUESTED" : "UNKNOWN";
  const summary = readString(record, "summary");
  const findingValues = Array.isArray(record?.findings)
    ? record.findings
    : Array.isArray(record?.issues)
      ? record.issues
      : [];
  const findings = findingValues.flatMap((finding): ReviewFindingView[] => {
    if (typeof finding === "string") return [{ severity: "WARNING", message: finding }];
    const item = asObject(finding);
    const message = readString(item, "message") ?? readString(item, "summary");
    if (message === undefined) return [];
    return [{ severity: reviewSeverity(readString(item, "severity")), message }];
  });
  return {
    verdict,
    ...(approved === undefined ? {} : { approved }),
    ...(summary === undefined ? {} : { summary }),
    findings,
    raw,
    source,
  };
}

function reviewHasStructuredContent(review: ReviewView): boolean {
  return (
    review.approved !== undefined || review.summary !== undefined || review.findings.length > 0
  );
}

function reviewSeverity(value: string | undefined): ReviewFindingSeverity {
  switch (value?.toUpperCase()) {
    case "ERROR":
    case "HIGH":
      return "ERROR";
    case "INFO":
    case "LOW":
      return "INFO";
    default:
      return "WARNING";
  }
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
  for (const event of [...associated].reverse()) {
    const stage = stageFromEvent(event);
    if (stage !== undefined) return stage;
  }
  if (associated.some((event) => event.type.startsWith("TEST_"))) return "TEST";
  if (associated.some((event) => event.type === "APPROVAL_REQUIRED")) return "WAITING_APPROVAL";
  return "EXECUTE";
}

function stageFromEvent(event: AgentEvent): WorkflowStage | undefined {
  const payload = asObject(event.payload);
  const explicit =
    workflowStageFromValue(payload?.stage) ?? workflowStageFromValue(payload?.purpose);
  if (explicit !== undefined) return explicit;
  switch (event.type) {
    case "RUN_STARTED":
      return "START";
    case "PLAN_GENERATED":
      return "GENERATE_PLAN";
    case "PLAN_APPROVED":
    case "PLAN_REJECTED":
    case "APPROVAL_REQUIRED":
      return "WAITING_APPROVAL";
    case "TEST_STARTED":
    case "TEST_RESULT":
      return "TEST";
    case "REPAIR_STARTED":
    case "REPAIR_COMPLETED":
      return "FIX";
    case "REVIEW_STARTED":
    case "REVIEW_RESULT":
      return "REVIEW";
    case "DIFF_GENERATED":
      return "GENERATE_DIFF";
    case "PUSH_APPROVAL_REQUIRED":
    case "PUSH_APPROVED":
    case "PUSH_REJECTED":
      return "WAITING_PUSH_APPROVAL";
    case "PUSH_COMPLETED":
    case "GITHUB_OPERATION_FAILED":
      return "PUSH";
    case "PR_APPROVAL_REQUIRED":
    case "PR_APPROVED":
    case "PR_REJECTED":
      return "WAITING_PR_APPROVAL";
    case "PR_CREATED":
      return "CREATE_PR";
    case "RUN_COMPLETED":
      return "DONE";
    default:
      return undefined;
  }
}

function workflowStageFromValue(value: unknown): WorkflowStage | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toUpperCase();
  const aliases: Readonly<Record<string, WorkflowStage>> = {
    PLAN: "GENERATE_PLAN",
    REPAIR: "FIX",
    REVIEW_REPAIR: "FIX",
    TEST_REPAIR: "FIX",
    DIFF: "GENERATE_DIFF",
    RESULT: "DONE",
  };
  const alias = aliases[normalized];
  if (alias !== undefined) return alias;
  return WORKFLOW_STAGES.has(normalized as WorkflowStage)
    ? (normalized as WorkflowStage)
    : undefined;
}

function isProgressStage(stage: WorkflowStage | undefined): stage is WorkflowStage {
  return stage !== undefined && stage !== "FAILED" && stage !== "CANCELLED";
}

function activityStatusFromTool(status: ToolCallRecord["status"]): ActivityStatus {
  switch (status) {
    case "SUCCEEDED":
      return "SUCCEEDED";
    case "FAILED":
    case "DENIED":
    case "TIMED_OUT":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
    case "RUNNING":
      return "RUNNING";
    default:
      return "PENDING";
  }
}

function activityStatusFromStep(status: StepRecord["status"]): ActivityStatus {
  switch (status) {
    case "SUCCEEDED":
      return "SUCCEEDED";
    case "FAILED":
      return "FAILED";
    case "SKIPPED":
      return "SKIPPED";
    case "CANCELLED":
      return "CANCELLED";
    case "RUNNING":
      return "RUNNING";
    default:
      return "PENDING";
  }
}

function activityStatusFromEvent(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined,
): ActivityStatus {
  if (readBoolean(payload, "skipped") === true) return "SKIPPED";
  if (event.type.includes("CANCELLED")) return "CANCELLED";
  if (
    event.level === "ERROR" ||
    event.type.includes("FAILED") ||
    event.type.includes("REJECTED") ||
    readBoolean(payload, "ok") === false
  ) {
    return "FAILED";
  }
  if (event.type.includes("APPROVAL_REQUIRED")) return "PENDING";
  if (
    event.type.endsWith("_STARTED") ||
    event.type === "LLM_REQUEST" ||
    event.type === "TOOL_CALL" ||
    event.type === "RUN_STARTED"
  ) {
    return "RUNNING";
  }
  if (event.level === "WARN") return "WARNING";
  return "SUCCEEDED";
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
    const tokenReasoning = readNumber(tokenUsage, "reasoningTokens");
    const stages = parseRunStageMetrics(asObject(metrics.stages));
    const control = parseRunControlMetrics(asObject(metrics.control));
    const budget = parseAdaptiveBudgetMetrics(asObject(metrics.budget));
    const complexity = normalizeComplexity(readString(metrics, "complexity"));
    return {
      durationMs: values.durationMs ?? 0,
      steps: values.steps ?? 0,
      modelCalls: values.modelCalls ?? 0,
      toolCalls: values.toolCalls ?? 0,
      ...optionalNumber(metrics, "toolExecutions"),
      ...optionalNumber(metrics, "cacheHits"),
      ...optionalNumber(metrics, "reasoningTokens"),
      retries: values.retries ?? 0,
      modelLatencyMs: values.modelLatencyMs ?? 0,
      toolLatencyMs: values.toolLatencyMs ?? 0,
      tokenUsage: {
        inputTokens: values.inputTokens ?? 0,
        outputTokens: values.outputTokens ?? 0,
        totalTokens: values.totalTokens ?? 0,
        ...(tokenReasoning === undefined ? {} : { reasoningTokens: tokenReasoning }),
        ...(costUsd === undefined ? {} : { costUsd }),
      },
      ...(control === undefined ? {} : { control }),
      ...(stages === undefined ? {} : { stages }),
      ...(budget === undefined ? {} : { budget }),
      ...(complexity === undefined ? {} : { complexity }),
      ...optionalNumber(metrics, "complexityConfidence"),
      ...optionalNumber(metrics, "estimatedSteps"),
      ...optionalNumber(metrics, "softLimit"),
      ...optionalNumber(metrics, "hardLimit"),
      ...optionalNumber(metrics, "planSteps"),
      ...optionalNumber(metrics, "executeSteps"),
      ...optionalNumber(metrics, "repairSteps"),
      ...optionalNumber(metrics, "reviewSteps"),
      ...optionalNumber(metrics, "unusedSteps"),
      ...optionalNumber(metrics, "budgetExtensions"),
    };
  }
  return undefined;
}

function optionalNumber(
  record: Record<string, unknown>,
  key:
    | "toolExecutions"
    | "cacheHits"
    | "reasoningTokens"
    | "complexityConfidence"
    | "estimatedSteps"
    | "softLimit"
    | "hardLimit"
    | "planSteps"
    | "executeSteps"
    | "repairSteps"
    | "reviewSteps"
    | "unusedSteps"
    | "budgetExtensions",
): Partial<Record<typeof key, number>> {
  const value = readNumber(record, key);
  return value === undefined ? {} : { [key]: value };
}

function normalizeComplexity(value: string | undefined): RunComplexity | undefined {
  const normalized = value?.toUpperCase();
  return normalized === "SIMPLE" || normalized === "MEDIUM" || normalized === "COMPLEX"
    ? normalized
    : undefined;
}

function parseAdaptiveBudgetMetrics(
  record: Record<string, unknown> | undefined,
): AdaptiveBudgetMetrics | undefined {
  if (record === undefined) return undefined;
  const complexity = normalizeComplexity(readString(record, "complexity"));
  const estimatedSteps = readNumber(record, "estimatedSteps");
  const confidence = readNumber(record, "confidence");
  const softLimit = readNumber(record, "softLimit");
  const activeLimit = readNumber(record, "activeLimit");
  const hardLimit = readNumber(record, "hardLimit");
  const planSteps = readNumber(record, "planSteps");
  const executeSteps = readNumber(record, "executeSteps");
  const repairSteps = readNumber(record, "repairSteps");
  const reviewSteps = readNumber(record, "reviewSteps");
  const unusedSteps = readNumber(record, "unusedSteps");
  const budgetExtensions = readNumber(record, "budgetExtensions");
  if (
    complexity === undefined ||
    estimatedSteps === undefined ||
    confidence === undefined ||
    softLimit === undefined ||
    activeLimit === undefined ||
    hardLimit === undefined ||
    planSteps === undefined ||
    executeSteps === undefined ||
    repairSteps === undefined ||
    reviewSteps === undefined ||
    unusedSteps === undefined ||
    budgetExtensions === undefined
  ) {
    return undefined;
  }

  const rawEstimatedSteps = readNumber(record, "rawEstimatedSteps");
  const adaptiveMargin = readNumber(record, "adaptiveMargin");
  const estimateClamped = readBoolean(record, "estimateClamped");
  return {
    complexity,
    estimatedSteps,
    confidence,
    softLimit,
    activeLimit,
    hardLimit,
    planSteps,
    executeSteps,
    repairSteps,
    reviewSteps,
    unusedSteps,
    budgetExtensions,
    ...(rawEstimatedSteps === undefined ? {} : { rawEstimatedSteps }),
    ...(adaptiveMargin === undefined ? {} : { adaptiveMargin }),
    ...(estimateClamped === undefined ? {} : { estimateClamped }),
  };
}

function parseRunStageMetrics(
  record: Record<string, unknown> | undefined,
): RunStageMetrics | undefined {
  if (record === undefined) return undefined;
  const stages: RunStageMetrics = {};
  for (const stage of ["PLAN", "EXECUTE", "TEST", "REPAIR", "REVIEW"] as const) {
    const parsed = parseStageMetrics(asObject(record[stage]));
    if (parsed !== undefined) stages[stage] = parsed;
  }
  return Object.keys(stages).length === 0 ? undefined : stages;
}

function parseStageMetrics(record: Record<string, unknown> | undefined): StageMetrics | undefined {
  if (record === undefined) return undefined;
  const tokenUsage = asObject(record.tokenUsage);
  if (tokenUsage === undefined) return undefined;
  const values = {
    steps: readNumber(record, "steps"),
    attempts: readNumber(record, "attempts"),
    modelCalls: readNumber(record, "modelCalls"),
    toolCalls: readNumber(record, "toolCalls"),
    toolExecutions: readNumber(record, "toolExecutions"),
    cacheHits: readNumber(record, "cacheHits"),
    modelLatencyMs: readNumber(record, "modelLatencyMs"),
    toolLatencyMs: readNumber(record, "toolLatencyMs"),
    wallLatencyMs: readNumber(record, "wallLatencyMs"),
    reasoningTokens: readNumber(record, "reasoningTokens"),
    formatRepairCalls: readNumber(record, "formatRepairCalls"),
    inputTokens: readNumber(tokenUsage, "inputTokens"),
    outputTokens: readNumber(tokenUsage, "outputTokens"),
    totalTokens: readNumber(tokenUsage, "totalTokens"),
  };
  if (Object.values(values).some((value) => value === undefined)) return undefined;
  const tokenReasoning = readNumber(tokenUsage, "reasoningTokens");
  const costUsd = readString(tokenUsage, "costUsd");
  return {
    steps: values.steps ?? 0,
    attempts: values.attempts ?? 0,
    modelCalls: values.modelCalls ?? 0,
    toolCalls: values.toolCalls ?? 0,
    toolExecutions: values.toolExecutions ?? 0,
    cacheHits: values.cacheHits ?? 0,
    modelLatencyMs: values.modelLatencyMs ?? 0,
    toolLatencyMs: values.toolLatencyMs ?? 0,
    wallLatencyMs: values.wallLatencyMs ?? 0,
    reasoningTokens: values.reasoningTokens ?? 0,
    formatRepairCalls: values.formatRepairCalls ?? 0,
    tokenUsage: {
      inputTokens: values.inputTokens ?? 0,
      outputTokens: values.outputTokens ?? 0,
      totalTokens: values.totalTokens ?? 0,
      ...(tokenReasoning === undefined ? {} : { reasoningTokens: tokenReasoning }),
      ...(costUsd === undefined ? {} : { costUsd }),
    },
  };
}

function parseRunControlMetrics(
  record: Record<string, unknown> | undefined,
): RunControlMetrics | undefined {
  if (record === undefined) return undefined;
  const values = {
    duplicateToolCalls: readNumber(record, "duplicateToolCalls"),
    contextCacheHits: readNumber(record, "contextCacheHits"),
    structuredOutputFailures: readNumber(record, "structuredOutputFailures"),
    structuredOutputRepairAttempts: readNumber(record, "structuredOutputRepairAttempts"),
    stalledDetections: readNumber(record, "stalledDetections"),
  };
  if (Object.values(values).some((value) => value === undefined)) return undefined;
  return {
    duplicateToolCalls: values.duplicateToolCalls ?? 0,
    contextCacheHits: values.contextCacheHits ?? 0,
    structuredOutputFailures: values.structuredOutputFailures ?? 0,
    structuredOutputRepairAttempts: values.structuredOutputRepairAttempts ?? 0,
    stalledDetections: values.stalledDetections ?? 0,
  };
}

function terminalStatus(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined,
): "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT" {
  const persisted = readString(payload, "status");
  if (
    persisted === "SUCCEEDED" ||
    persisted === "FAILED" ||
    persisted === "CANCELLED" ||
    persisted === "TIMED_OUT"
  ) {
    return persisted;
  }
  if (event.type === "RUN_COMPLETED") return "SUCCEEDED";
  if (event.type === "RUN_CANCELLED") return "CANCELLED";
  return "FAILED";
}

function emptyMetrics(): RunMetrics {
  return {
    durationMs: 0,
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    retries: 0,
    modelLatencyMs: 0,
    toolLatencyMs: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
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
