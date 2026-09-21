import type { ModelResponse } from "@devflow/agent";
import type {
  RunControlMetrics,
  RunMetricStage,
  RunMetrics,
  StageMetrics,
  TokenUsage,
} from "@devflow/shared";

export function createWorkflowMetrics(retries = 0): RunMetrics {
  return {
    durationMs: 0,
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    toolExecutions: 0,
    cacheHits: 0,
    reasoningTokens: 0,
    retries,
    modelLatencyMs: 0,
    toolLatencyMs: 0,
    tokenUsage: emptyTokenUsage(),
    control: emptyControlMetrics(),
    stages: {},
  };
}

export function recordStageAttempt(metrics: RunMetrics, stage: RunMetricStage): void {
  stageMetrics(metrics, stage).attempts += 1;
}

/** Records one logical model decision against the run-wide step budget. */
export function recordStageStep(metrics: RunMetrics, stage: RunMetricStage, count = 1): void {
  const steps = nonnegativeInteger(count);
  metrics.steps += steps;
  stageMetrics(metrics, stage).steps += steps;
  syncBudgetStageSteps(metrics);
}

export function recordModelResponse(
  metrics: RunMetrics,
  stage: RunMetricStage,
  response: ModelResponse,
): void {
  const target = stageMetrics(metrics, stage);
  metrics.modelCalls += 1;
  target.modelCalls += 1;
  metrics.modelLatencyMs += nonnegativeInteger(response.latencyMs);
  target.modelLatencyMs += nonnegativeInteger(response.latencyMs);
  addUsage(metrics.tokenUsage, response.usage);
  addUsage(target.tokenUsage, response.usage);
  const reasoning = nonnegativeInteger(
    response.reasoningTokens ?? response.usage.reasoningTokens ?? 0,
  );
  metrics.reasoningTokens = nonnegativeInteger(metrics.reasoningTokens ?? 0) + reasoning;
  target.reasoningTokens += reasoning;
}

export function recordModelFailure(
  metrics: RunMetrics,
  stage: RunMetricStage,
  latencyMs: number,
): void {
  const latency = nonnegativeInteger(latencyMs);
  const target = stageMetrics(metrics, stage);
  metrics.modelCalls += 1;
  target.modelCalls += 1;
  metrics.modelLatencyMs += latency;
  target.modelLatencyMs += latency;
}

export function recordStructuredFailure(metrics: RunMetrics, stage: RunMetricStage): void {
  metrics.control = controlMetrics(metrics);
  metrics.control.structuredOutputFailures += 1;
  stageMetrics(metrics, stage);
}

export function recordFormatRepair(metrics: RunMetrics, stage: RunMetricStage): void {
  metrics.control = controlMetrics(metrics);
  metrics.control.structuredOutputRepairAttempts += 1;
  stageMetrics(metrics, stage).formatRepairCalls += 1;
}

export function recordToolWork(
  metrics: RunMetrics,
  stage: RunMetricStage,
  input: { calls?: number; executions?: number; cacheHits?: number; latencyMs?: number },
): void {
  const calls = nonnegativeInteger(input.calls ?? 0);
  const executions = nonnegativeInteger(input.executions ?? calls);
  const cacheHits = nonnegativeInteger(input.cacheHits ?? 0);
  const latencyMs = nonnegativeInteger(input.latencyMs ?? 0);
  const target = stageMetrics(metrics, stage);
  metrics.toolCalls += calls;
  metrics.toolExecutions = nonnegativeInteger(metrics.toolExecutions ?? 0) + executions;
  metrics.cacheHits = nonnegativeInteger(metrics.cacheHits ?? 0) + cacheHits;
  metrics.toolLatencyMs += latencyMs;
  target.toolCalls += calls;
  target.toolExecutions += executions;
  target.cacheHits += cacheHits;
  target.toolLatencyMs += latencyMs;
}

export function mergeAgentPhaseMetrics(
  target: RunMetrics,
  source: RunMetrics,
  stage: "EXECUTE" | "REPAIR",
  wallLatencyMs: number,
): void {
  const phase = stageMetrics(target, stage);
  target.steps += source.steps;
  phase.steps += source.steps;
  target.modelCalls += source.modelCalls;
  phase.modelCalls += source.modelCalls;
  target.toolCalls += source.toolCalls;
  phase.toolCalls += source.toolCalls;
  const executions = source.toolExecutions ?? source.toolCalls;
  target.toolExecutions = nonnegativeInteger(target.toolExecutions ?? 0) + executions;
  phase.toolExecutions += executions;
  const cacheHits = source.cacheHits ?? 0;
  target.cacheHits = nonnegativeInteger(target.cacheHits ?? 0) + cacheHits;
  phase.cacheHits += cacheHits;
  target.retries += source.retries;
  target.modelLatencyMs += source.modelLatencyMs;
  phase.modelLatencyMs += source.modelLatencyMs;
  target.toolLatencyMs += source.toolLatencyMs;
  phase.toolLatencyMs += source.toolLatencyMs;
  phase.wallLatencyMs += nonnegativeInteger(wallLatencyMs);
  addUsage(target.tokenUsage, source.tokenUsage);
  addUsage(phase.tokenUsage, source.tokenUsage);
  const reasoning = nonnegativeInteger(
    source.reasoningTokens ?? source.tokenUsage.reasoningTokens ?? 0,
  );
  target.reasoningTokens = nonnegativeInteger(target.reasoningTokens ?? 0) + reasoning;
  phase.reasoningTokens += reasoning;
  mergeControl(target, source.control);
  syncBudgetStageSteps(target);
}

export function addStageWallLatency(
  metrics: RunMetrics,
  stage: RunMetricStage,
  latencyMs: number,
): void {
  stageMetrics(metrics, stage).wallLatencyMs += nonnegativeInteger(latencyMs);
}

export function stageMetrics(metrics: RunMetrics, stage: RunMetricStage): StageMetrics {
  const stages = (metrics.stages ??= {});
  const current = stages[stage];
  if (current !== undefined) return current;
  const created: StageMetrics = {
    steps: 0,
    attempts: 0,
    modelCalls: 0,
    toolCalls: 0,
    toolExecutions: 0,
    cacheHits: 0,
    modelLatencyMs: 0,
    toolLatencyMs: 0,
    wallLatencyMs: 0,
    reasoningTokens: 0,
    formatRepairCalls: 0,
    tokenUsage: emptyTokenUsage(),
  };
  stages[stage] = created;
  return created;
}

/** Keeps compatibility totals and adaptive counters derived from one ledger. */
export function syncBudgetStageSteps(metrics: RunMetrics): void {
  if (metrics.budget === undefined) return;
  metrics.budget.planSteps = metrics.stages?.PLAN?.steps ?? 0;
  metrics.budget.executeSteps = metrics.stages?.EXECUTE?.steps ?? 0;
  metrics.budget.repairSteps = metrics.stages?.REPAIR?.steps ?? 0;
  metrics.budget.reviewSteps = metrics.stages?.REVIEW?.steps ?? 0;
  metrics.budget.unusedSteps = Math.max(0, metrics.budget.activeLimit - metrics.steps);
}

export function stageStepTotal(metrics: RunMetrics): number {
  return Object.values(metrics.stages ?? {}).reduce(
    (total, stage) => total + (stage?.steps ?? 0),
    0,
  );
}

function controlMetrics(metrics: RunMetrics): RunControlMetrics {
  return (metrics.control ??= emptyControlMetrics());
}

function mergeControl(target: RunMetrics, source: RunControlMetrics | undefined): void {
  if (source === undefined) return;
  const control = controlMetrics(target);
  control.duplicateToolCalls += source.duplicateToolCalls;
  control.contextCacheHits += source.contextCacheHits;
  control.structuredOutputFailures += source.structuredOutputFailures;
  control.structuredOutputRepairAttempts += source.structuredOutputRepairAttempts;
  control.stalledDetections += source.stalledDetections;
}

function emptyControlMetrics(): RunControlMetrics {
  return {
    duplicateToolCalls: 0,
    contextCacheHits: 0,
    structuredOutputFailures: 0,
    structuredOutputRepairAttempts: 0,
    stalledDetections: 0,
  };
}

function emptyTokenUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0 };
}

function addUsage(target: TokenUsage, source: TokenUsage): void {
  target.inputTokens += nonnegativeInteger(source.inputTokens);
  target.outputTokens += nonnegativeInteger(source.outputTokens);
  target.totalTokens += nonnegativeInteger(source.totalTokens);
  target.reasoningTokens =
    nonnegativeInteger(target.reasoningTokens ?? 0) +
    nonnegativeInteger(source.reasoningTokens ?? 0);
}

function nonnegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
