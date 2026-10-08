import {
  AgentStateSchema,
  DefaultAgentRuntime,
  type AgentState,
  type AgentStateStore,
  type LanguageModelPort,
} from "@devflow/agent";
import { DevflowError, type RunMetrics } from "@devflow/shared";
import type { RepositoryRelationGraph } from "../localization/relation-graph.js";

/** One logical coding lifecycle. Workflow validation yields feedback into this store. */
export class CodingSession implements AgentStateStore {
  readonly runtime: DefaultAgentRuntime;
  state: AgentState | undefined;
  /** One live graph per sandbox; host commands conservatively invalidate its source cache. */
  relationGraph: RepositoryRelationGraph | undefined;

  constructor(
    model: LanguageModelPort,
    private readonly persist: (state: AgentState) => Promise<void>,
    restored?: AgentState,
  ) {
    this.runtime = new DefaultAgentRuntime(model);
    this.state = restored ? (AgentStateSchema.parse(restored) as AgentState) : undefined;
  }

  async load() {
    return this.state ? structuredClone(this.state) : undefined;
  }

  async save(state: AgentState) {
    const next = AgentStateSchema.parse(state) as AgentState;
    if (
      this.state &&
      (next.stepCount < this.state.stepCount ||
        next.metrics.tokenUsage.totalTokens < this.state.metrics.tokenUsage.totalTokens)
    )
      throw new DevflowError({ code: "CONFLICT", message: "CODING_SESSION_CONSUMPTION_REWIND" });
    await this.persist(next);
    this.state = next;
  }
}

/** Runtime checkpoints are cumulative; the workflow ledger charges each segment once. */
export function codingMetricDelta(current: RunMetrics, previous?: RunMetrics): RunMetrics {
  if (!previous) return structuredClone(current);
  const result = structuredClone(current);
  for (const key of [
    "steps",
    "modelCalls",
    "modelRequestAttempts",
    "modelRequestsDispatched",
    "toolCalls",
    "toolExecutions",
    "cacheHits",
    "reasoningTokens",
    "retries",
    "modelLatencyMs",
    "toolLatencyMs",
    "contextCompressionReservedTokens",
  ] as const) {
    if (typeof current[key] === "number")
      result[key] = Math.max(0, current[key]! - (previous[key] ?? 0));
  }
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens"] as const)
    if (typeof result.tokenUsage[key] === "number")
      result.tokenUsage[key] = Math.max(
        0,
        result.tokenUsage[key]! - (previous.tokenUsage[key] ?? 0),
      );
  if (result.control)
    for (const key of Object.keys(result.control) as (keyof NonNullable<RunMetrics["control"]>)[])
      result.control[key] = Math.max(0, result.control[key] - (previous.control?.[key] ?? 0));
  delete result.stages;
  delete result.budget;
  return result;
}
