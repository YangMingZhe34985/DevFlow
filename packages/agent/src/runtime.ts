import { createHash, randomUUID } from "node:crypto";

import { DevflowError, toDevflowError, type AgentPlan, type JsonValue } from "@devflow/shared";

import type {
  NewAgentEvent,
  RunId,
  RunMetrics,
  RunResult,
  StepId,
  TaskSpec,
} from "@devflow/shared";
import type { ToolExecutionRequest, ToolExecutionResult } from "@devflow/tools";

import type {
  LanguageModelPort,
  ModelGenerationSettings,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ModelToolDescriptor,
} from "./model.js";
import {
  createInitialAgentState,
  type AgentPhase,
  type AgentState,
  type AgentStateStore,
  type AdaptiveStepBudgetState,
} from "./state.js";

export type { AgentPhase, AgentState } from "./state.js";

export interface AgentProgressSnapshot {
  stepCount: number;
  currentLimit: number;
  hardLimit: number;
  remainingHardSteps: number;
  extensions: number;
  workspaceRevision: number;
  noProgressStreak: number;
  cacheEntries: number;
  cacheHits: number;
  duplicateToolCalls: number;
  modelCalls: number;
  toolCalls: number;
  successfulMutations: number;
  hasMutationEvidence: boolean;
  hasDiffEvidence: boolean;
  progressFingerprint?: string;
  lastProgressStep?: number;
}

export type ExtensionDecision =
  | {
      action: "EXTEND";
      /** Added to the exhausted lease and clamped to the effective hard limit. */
      additionalSteps: number;
      reason?: string;
    }
  | {
      action: "STOP";
      reason: "NO_PROGRESS" | "ESTIMATED_BUDGET_EXCEEDED";
      message?: string;
    };

export interface AdaptiveStepBudgetController {
  /** Initial phase-local lease. It is clamped to both hardLimit and maxSteps. */
  initialLimit: number;
  /** Absolute phase hard limit. request.maxSteps remains an additional hard ceiling. */
  hardLimit: number;
  onLimitReached(
    snapshot: Readonly<AgentProgressSnapshot>,
  ): ExtensionDecision | Promise<ExtensionDecision>;
}

export interface AgentRunRequest {
  approvedPlan?: AgentPlan;
  systemPrompt?: string;
  additionalContext?: string;
  emitRunLifecycle?: boolean;
  maxSteps: number;
  timeoutMs: number;
  maxRetries: number;
  modelSettings?: ModelGenerationSettings;
  adaptiveStepBudget?: AdaptiveStepBudgetController;
  executionBudget?: {
    stage: string;
    maxModelCalls: number;
    maxToolCalls: number;
    maxTotalTokens: number;
  };
}

export interface RunContext {
  runId: RunId;
  task: TaskSpec;
  signal: AbortSignal;
  tools: readonly ModelToolDescriptor[];
  stateStore?: AgentStateStore;
  emit(event: NewAgentEvent): Promise<void>;
  executeTool(
    stepId: StepId,
    request: ToolExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult>;
}

export interface AgentRuntime {
  run(request: AgentRunRequest, context: RunContext): Promise<RunResult>;
}

export class DefaultAgentRuntime implements AgentRuntime {
  constructor(private readonly model: LanguageModelPort) {}

  async run(request: AgentRunRequest, context: RunContext): Promise<RunResult> {
    validateRunRequest(request);
    const deadlineSignal = AbortSignal.timeout(request.timeoutMs);
    const signal = AbortSignal.any([context.signal, deadlineSignal]);
    const initialMessages: ModelMessage[] = [
      {
        role: "SYSTEM",
        content:
          request.systemPrompt ??
          "You are a software engineering agent. Inspect the repository before editing, use only the provided tools, run the relevant tests after changes, inspect gitDiff, then give a concise final summary. Never invent tool results.",
      },
      ...buildUserMessages(request, context.task.title, context.task.description),
    ];
    const restoredState = await context.stateStore?.load(context.runId);
    if (restoredState?.finalResult !== undefined) return restoredState.finalResult;

    let state =
      restoredState ??
      createInitialAgentState(context.runId, initialMessages, new Date().toISOString());
    if (restoredState === undefined && request.approvedPlan !== undefined) {
      state = { ...state, plan: request.approvedPlan };
    }
    const messages: ModelMessage[] = [...state.messages];
    const execution = createExecutionState(context.tools);
    let adaptiveStepBudget = initializeAdaptiveStepBudget(request, state);
    if (adaptiveStepBudget !== undefined) {
      state = { ...state, adaptiveStepBudget };
    }
    state = await checkpoint(context, { ...state, phase: "THINKING" });

    if (request.emitRunLifecycle !== false) {
      await context.emit({
        runId: context.runId,
        type: "RUN_STARTED",
        occurredAt: new Date().toISOString(),
        payload: {
          maxSteps: request.maxSteps,
          timeoutMs: request.timeoutMs,
          resumed: restoredState !== undefined,
          ...(adaptiveStepBudget === undefined
            ? {}
            : {
                adaptiveStepBudget: {
                  currentLimit: adaptiveStepBudget.currentLimit,
                  hardLimit: adaptiveStepBudget.hardLimit,
                  extensions: adaptiveStepBudget.extensions,
                },
              }),
        },
      });
    }

    try {
      while (true) {
        throwIfAborted(signal, context.signal, deadlineSignal);
        if (adaptiveStepBudget === undefined) {
          if (state.stepCount >= request.maxSteps) break;
        } else if (state.stepCount >= adaptiveStepBudget.currentLimit) {
          if (state.stepCount >= adaptiveStepBudget.hardLimit) break;
          const snapshot = agentProgressSnapshot(state, execution, adaptiveStepBudget);
          const decision = await awaitWithSignal(
            Promise.resolve(request.adaptiveStepBudget?.onLimitReached(snapshot)),
            signal,
          );
          throwIfAborted(signal, context.signal, deadlineSignal);
          if (decision === undefined) {
            throw new DevflowError({
              code: "VALIDATION_ERROR",
              message: "adaptiveStepBudget.onLimitReached must return an extension decision.",
            });
          }
          if (decision.action === "STOP") {
            throw adaptiveBudgetStop(decision, snapshot);
          }
          if (!Number.isSafeInteger(decision.additionalSteps) || decision.additionalSteps < 1) {
            throw new DevflowError({
              code: "VALIDATION_ERROR",
              message: "Adaptive step budget extensions must add at least one integer step.",
            });
          }
          const extensionBase = Math.max(adaptiveStepBudget.currentLimit, state.stepCount);
          adaptiveStepBudget = {
            ...adaptiveStepBudget,
            currentLimit: Math.min(
              adaptiveStepBudget.hardLimit,
              extensionBase + decision.additionalSteps,
            ),
            extensions: adaptiveStepBudget.extensions + 1,
          };
          state = await checkpoint(context, { ...state, adaptiveStepBudget });
          continue;
        }
        const stepId = randomUUID();
        state = await checkpoint(context, {
          ...state,
          phase: "THINKING",
          stepCount: state.stepCount + 1,
          messages,
        });

        await context.emit({
          runId: context.runId,
          stepId,
          type: "STEP_STARTED",
          occurredAt: new Date().toISOString(),
          payload: { step: state.stepCount },
        });

        let response: ModelResponse | undefined;
        for (let attempt = 0; attempt <= request.maxRetries; attempt += 1) {
          throwIfAborted(signal, context.signal, deadlineSignal);
          assertExecutionBudget(request, "modelCalls", state.metrics.modelCalls + 1);
          state = await checkpoint(context, {
            ...state,
            metrics: {
              ...state.metrics,
              modelCalls: state.metrics.modelCalls + 1,
            },
          });
          const projectedMessages = projectModelMessages(messages);
          await context.emit({
            runId: context.runId,
            stepId,
            type: "LLM_REQUEST",
            occurredAt: new Date().toISOString(),
            payload: {
              messageCount: projectedMessages.length,
              originalMessageCount: messages.length,
              contextBytes: serializedBytes(projectedMessages),
              toolCount: context.tools.length,
              attempt: attempt + 1,
            },
          });

          const attemptStartedAt = Date.now();
          try {
            const modelRequest: ModelRequest = {
              messages: projectedMessages,
              tools: context.tools,
              ...(request.modelSettings === undefined ? {} : { settings: request.modelSettings }),
            };
            response = await this.model.generate(modelRequest, { signal });
            state = await checkpoint(context, {
              ...state,
              metrics: {
                ...state.metrics,
                modelLatencyMs:
                  state.metrics.modelLatencyMs + nonnegativeInteger(response.latencyMs),
                reasoningTokens:
                  state.metrics.reasoningTokens + nonnegativeInteger(response.reasoningTokens ?? 0),
                tokenUsage: {
                  inputTokens: state.metrics.tokenUsage.inputTokens + response.usage.inputTokens,
                  outputTokens: state.metrics.tokenUsage.outputTokens + response.usage.outputTokens,
                  totalTokens: state.metrics.tokenUsage.totalTokens + response.usage.totalTokens,
                },
              },
            });
            assertExecutionBudget(request, "totalTokens", state.metrics.tokenUsage.totalTokens);
            await context.emit({
              runId: context.runId,
              stepId,
              type: "LLM_RESPONSE",
              occurredAt: new Date().toISOString(),
              payload: {
                ok: true,
                finishReason: response.finishReason,
                latencyMs: response.latencyMs,
                usage: jsonValue(response.usage),
                reasoningTokens: response.reasoningTokens ?? 0,
                attempt: attempt + 1,
                toolCalls: response.toolCalls.map(({ id, name }) => ({ id, name })),
              },
            });
            break;
          } catch (error) {
            const attemptLatencyMs = Date.now() - attemptStartedAt;
            state = await checkpoint(context, {
              ...state,
              metrics: {
                ...state.metrics,
                modelLatencyMs: state.metrics.modelLatencyMs + nonnegativeInteger(attemptLatencyMs),
              },
            });
            throwIfAborted(signal, context.signal, deadlineSignal);
            const retry = attempt < request.maxRetries && isRetryableModelError(error);
            await context.emit({
              runId: context.runId,
              stepId,
              type: "LLM_RESPONSE",
              level: retry ? "WARN" : "ERROR",
              occurredAt: new Date().toISOString(),
              payload: {
                ok: false,
                attempt: attempt + 1,
                retry,
                latencyMs: attemptLatencyMs,
                error: jsonValue(errorSummary(error)),
              },
            });
            if (!retry) throw error;
            state = await checkpoint(context, {
              ...state,
              metrics: { ...state.metrics, retries: state.metrics.retries + 1 },
            });
          }
        }

        if (response === undefined) {
          throw new DevflowError({
            code: "LLM_FAILED",
            message: "Model did not produce a response.",
          });
        }
        if (response.toolCalls.length === 0 && response.finishReason !== "STOP") {
          throw new DevflowError({
            code: "LLM_FAILED",
            message: `Model stopped with '${response.finishReason}' before completing the task.`,
          });
        }

        if (response.toolCalls.length === 0) {
          const summary = response.text?.trim() || "Agent completed without a text summary.";
          messages.push({ role: "ASSISTANT", content: response.text ?? "" });
          await context.emit({
            runId: context.runId,
            stepId,
            type: "STEP_COMPLETED",
            occurredAt: new Date().toISOString(),
            payload: { step: state.stepCount },
          });
          const result: RunResult = {
            runId: context.runId,
            status: "SUCCEEDED",
            summary,
            metrics: runMetrics(state),
          };
          state = await checkpoint(context, {
            ...state,
            phase: "COMPLETED",
            messages,
            finalResult: result,
          });
          if (request.emitRunLifecycle !== false) {
            await context.emit({
              runId: context.runId,
              type: "RUN_COMPLETED",
              occurredAt: new Date().toISOString(),
              payload: { summary, metrics: jsonValue(result.metrics) },
            });
          }
          return result;
        }

        const calls = response.toolCalls.map(normalizeToolCall);
        assertExecutionBudget(request, "toolCalls", state.metrics.toolCalls + calls.length);
        messages.push({
          role: "ASSISTANT",
          content: response.text ?? "",
          toolCalls: calls,
        });
        state = await checkpoint(context, {
          ...state,
          phase: "CALLING_TOOL",
          messages,
        });

        const executedCalls = await executeToolBatch(calls, stepId, context, signal, execution);
        for (const executed of executedCalls) {
          messages.push(toolResultMessage(executed.call, executed.result));
        }
        const cachedToolCalls = executedCalls.filter(({ cached }) => cached).length;
        const toolExecutions = executedCalls.filter(({ executed }) => executed).length;
        const actualToolLatencyMs = executedCalls.reduce(
          (total, { executed, result }) => total + (executed ? result.durationMs : 0),
          0,
        );
        const normalCalls = executedCalls.filter(({ control }) => !control);
        const madeWorkspaceProgress = normalCalls.some(
          ({ metadata, result }) => metadata.mutatesWorkspace && result.ok,
        );
        const successfulMutations = normalCalls.filter(
          ({ metadata, result }) => metadata.mutatesWorkspace && result.ok,
        ).length;
        const observedDiff = normalCalls.some(({ call, result }) =>
          !result.ok ? false : hasDiffEvidence(call.name, result.output),
        );
        const observedDiffFingerprint = diffEvidenceFingerprint(normalCalls);
        execution.successfulMutations += successfulMutations;
        if (
          observedDiffFingerprint !== undefined &&
          observedDiffFingerprint !== execution.progressFingerprint
        ) {
          execution.lastProgressStep = state.stepCount;
        }
        execution.hasDiffEvidence ||= observedDiff;
        if (observedDiffFingerprint !== undefined) {
          execution.progressFingerprint = observedDiffFingerprint;
        }
        const repeatedWithoutProgress =
          normalCalls.length > 0 && normalCalls.every(({ cached }) => cached);
        state = await checkpoint(context, {
          ...state,
          phase: "CALLING_TOOL",
          messages,
          metrics: {
            ...state.metrics,
            toolCalls: state.metrics.toolCalls + calls.length,
            toolExecutions: state.metrics.toolExecutions + toolExecutions,
            cacheHits: state.metrics.cacheHits + cachedToolCalls,
            duplicateToolCalls: state.metrics.duplicateToolCalls + cachedToolCalls,
            stalledDetections: state.metrics.stalledDetections + (repeatedWithoutProgress ? 1 : 0),
            toolLatencyMs: state.metrics.toolLatencyMs + actualToolLatencyMs,
          },
        });

        if (madeWorkspaceProgress || !repeatedWithoutProgress) {
          execution.noProgressStreak = 0;
        } else {
          execution.noProgressStreak += 1;
          if (execution.noProgressStreak === 1) {
            messages.push({
              role: "USER",
              content:
                "Convergence warning: every tool call in the previous step repeated an unchanged read and was served from cache. Do not repeat it again; change strategy, make a targeted edit, or finish the phase.",
            });
          } else {
            throw new DevflowError({
              code: "AGENT_STALLED",
              message: "Agent repeated the same unchanged tool calls without making progress.",
              details: {
                noProgressStreak: execution.noProgressStreak,
                tools: normalCalls.map(({ call }) => call.name),
              },
            });
          }
        }

        await context.emit({
          runId: context.runId,
          stepId,
          type: "STEP_COMPLETED",
          occurredAt: new Date().toISOString(),
          payload: {
            step: state.stepCount,
            toolCalls: calls.length,
            toolExecutions,
            cachedToolCalls,
            toolLatencyMs: actualToolLatencyMs,
            workspaceRevision: execution.workspaceRevision,
          },
        });

        const finishCall = executedCalls.find(({ control }) => control);
        if (finishCall?.result.ok === true) {
          const summary = finishSummary(finishCall.call);
          const result: RunResult = {
            runId: context.runId,
            status: "SUCCEEDED",
            summary,
            metrics: runMetrics(state),
          };
          state = await checkpoint(context, {
            ...state,
            phase: "COMPLETED",
            messages,
            finalResult: result,
          });
          if (request.emitRunLifecycle !== false) {
            await context.emit({
              runId: context.runId,
              type: "RUN_COMPLETED",
              occurredAt: new Date().toISOString(),
              payload: { summary, metrics: jsonValue(result.metrics) },
            });
          }
          return result;
        }
        state = await checkpoint(context, { ...state, phase: "THINKING", messages });
      }

      const exhaustedLimit = adaptiveStepBudget?.hardLimit ?? request.maxSteps;
      throw new DevflowError({
        code: "MAX_STEPS_EXCEEDED",
        message: `Agent exceeded the maximum of ${exhaustedLimit} model steps.`,
      });
    } catch (error) {
      const normalized = normalizeRunError(error, context.signal, deadlineSignal);
      const status =
        normalized.code === "CANCELLED"
          ? "CANCELLED"
          : normalized.code === "TIMEOUT"
            ? "TIMED_OUT"
            : "FAILED";
      const phase: AgentPhase =
        status === "CANCELLED" ? "CANCELLED" : status === "TIMED_OUT" ? "TIMED_OUT" : "FAILED";
      const result: RunResult = {
        runId: context.runId,
        status,
        metrics: runMetrics(state),
        error: normalized.toJSON(),
      };
      state = await checkpoint(context, {
        ...state,
        phase,
        messages,
        lastError: normalized.toJSON(),
        finalResult: result,
      });
      if (request.emitRunLifecycle !== false) {
        await context.emit({
          runId: context.runId,
          type: status === "CANCELLED" ? "RUN_CANCELLED" : "RUN_FAILED",
          level: "ERROR",
          occurredAt: new Date().toISOString(),
          payload: { error: jsonValue(normalized.toJSON()), metrics: jsonValue(result.metrics) },
        });
      }
      return result;
    }
  }
}

const MODEL_CONTEXT_MAX_BYTES = 192 * 1_024;
const MODEL_TOOL_RESULT_MAX_BYTES = 32 * 1_024;
const MODEL_INTERACTION_GROUP_MAX_BYTES = 48 * 1_024;
const MAX_PARALLEL_READS = 4;

interface ToolExecutionMetadata {
  readOnly: boolean;
  parallelSafe: boolean;
  mutatesWorkspace: boolean;
}

interface RuntimeExecutionState {
  readonly tools: ReadonlyMap<string, ModelToolDescriptor>;
  readonly cache: Map<string, ToolExecutionResult>;
  readonly inFlight: Map<string, Promise<ToolExecutionResult>>;
  workspaceRevision: number;
  noProgressStreak: number;
  successfulMutations: number;
  hasDiffEvidence: boolean;
  progressFingerprint?: string;
  lastProgressStep?: number;
}

interface ExecutedToolCall {
  call: ModelToolCall;
  result: ToolExecutionResult;
  metadata: ToolExecutionMetadata;
  cached: boolean;
  executed: boolean;
  control: boolean;
}

function createExecutionState(tools: readonly ModelToolDescriptor[]): RuntimeExecutionState {
  return {
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    cache: new Map(),
    inFlight: new Map(),
    workspaceRevision: 0,
    noProgressStreak: 0,
    successfulMutations: 0,
    hasDiffEvidence: false,
  };
}

function initializeAdaptiveStepBudget(
  request: AgentRunRequest,
  state: AgentState,
): AdaptiveStepBudgetState | undefined {
  const controller = request.adaptiveStepBudget;
  if (controller === undefined) return undefined;
  const hardLimit = Math.min(request.maxSteps, controller.hardLimit);
  const restored = state.adaptiveStepBudget;
  return {
    currentLimit: Math.min(hardLimit, restored?.currentLimit ?? controller.initialLimit),
    hardLimit,
    extensions: restored?.extensions ?? 0,
  };
}

function agentProgressSnapshot(
  state: AgentState,
  execution: RuntimeExecutionState,
  budget: AdaptiveStepBudgetState,
): AgentProgressSnapshot {
  return {
    stepCount: state.stepCount,
    currentLimit: budget.currentLimit,
    hardLimit: budget.hardLimit,
    remainingHardSteps: Math.max(0, budget.hardLimit - state.stepCount),
    extensions: budget.extensions,
    workspaceRevision: execution.workspaceRevision,
    noProgressStreak: execution.noProgressStreak,
    cacheEntries: execution.cache.size,
    cacheHits: state.metrics.cacheHits,
    duplicateToolCalls: state.metrics.duplicateToolCalls,
    modelCalls: state.metrics.modelCalls,
    toolCalls: state.metrics.toolCalls,
    successfulMutations: execution.successfulMutations,
    hasMutationEvidence: execution.successfulMutations > 0,
    hasDiffEvidence: execution.hasDiffEvidence,
    ...(execution.progressFingerprint === undefined
      ? {}
      : { progressFingerprint: execution.progressFingerprint }),
    ...(execution.lastProgressStep === undefined
      ? {}
      : { lastProgressStep: execution.lastProgressStep }),
  };
}

function adaptiveBudgetStop(
  decision: Extract<ExtensionDecision, { action: "STOP" }>,
  snapshot: AgentProgressSnapshot,
): DevflowError {
  return new DevflowError({
    code: decision.reason,
    message:
      decision.message ??
      (decision.reason === "NO_PROGRESS"
        ? "Adaptive step budget extension was denied because the agent made no progress."
        : "Agent exhausted its estimated step budget before completing the phase."),
    details: { ...snapshot },
  });
}

async function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}

function hasDiffEvidence(toolName: string, output: unknown): boolean {
  if (!new Set(["gitDiff", "gitDiffSummary", "gitStatus"]).has(toolName)) return false;
  const record = objectValue(output);
  if (record === undefined) return false;
  if (typeof record.filesChanged === "number" && record.filesChanged > 0) return true;
  if (Array.isArray(record.files) && record.files.length > 0) return true;
  if (record.clean === false) return true;
  return typeof record.patch === "string" && record.patch.trim().length > 0;
}

function diffEvidenceFingerprint(calls: readonly ExecutedToolCall[]): string | undefined {
  const evidence: { name: string; output: unknown }[] = [];
  for (const { call, result } of calls) {
    if (result.ok && hasDiffEvidence(call.name, result.output)) {
      evidence.push({ name: call.name, output: result.output });
    }
  }
  if (evidence.length === 0) return undefined;
  return createHash("sha256").update(stableStringify(evidence)).digest("hex");
}

async function executeToolBatch(
  calls: readonly ModelToolCall[],
  stepId: StepId,
  context: RunContext,
  signal: AbortSignal,
  state: RuntimeExecutionState,
): Promise<ExecutedToolCall[]> {
  const results = new Array<ExecutedToolCall | undefined>(calls.length);
  let cursor = 0;
  while (cursor < calls.length) {
    signal.throwIfAborted();
    const call = calls[cursor];
    if (call === undefined) break;
    if (call.name === "finishPhase") {
      cursor += 1;
      continue;
    }
    const metadata = toolMetadata(call.name, state.tools.get(call.name));
    if (metadata.readOnly && metadata.parallelSafe) {
      const batch: { call: ModelToolCall; index: number; metadata: ToolExecutionMetadata }[] = [];
      while (cursor < calls.length) {
        const candidate = calls[cursor];
        if (candidate === undefined || candidate.name === "finishPhase") break;
        const candidateMetadata = toolMetadata(candidate.name, state.tools.get(candidate.name));
        if (!candidateMetadata.readOnly || !candidateMetadata.parallelSafe) break;
        batch.push({ call: candidate, index: cursor, metadata: candidateMetadata });
        cursor += 1;
      }
      const executed = await mapWithConcurrency(
        batch,
        MAX_PARALLEL_READS,
        async (entry) =>
          await executeOneTool(entry.call, entry.metadata, stepId, context, signal, state),
      );
      for (let index = 0; index < batch.length; index += 1) {
        const entry = batch[index];
        const result = executed[index];
        if (entry !== undefined && result !== undefined) results[entry.index] = result;
      }
      continue;
    }
    results[cursor] = await executeOneTool(call, metadata, stepId, context, signal, state);
    cursor += 1;
  }

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    if (call?.name !== "finishPhase") continue;
    const summary = finishSummary(call);
    const priorSucceeded = results.slice(0, index).every((result) => result?.result.ok === true);
    const isLast = index === calls.length - 1;
    const schemaError = finishSchemaError(call, state.tools.get("finishPhase"));
    const error = !isLast
      ? "finishPhase must be the last call in a tool-call batch."
      : schemaError !== undefined
        ? schemaError
        : summary.length === 0
          ? "finishPhase requires a non-empty string input.summary."
          : !priorSucceeded
            ? "finishPhase was ignored because an earlier tool call failed."
            : undefined;
    results[index] = {
      call,
      result:
        error === undefined
          ? { ok: true, output: { finished: true, summary }, durationMs: 0 }
          : controlFailure(error),
      metadata: { readOnly: true, parallelSafe: false, mutatesWorkspace: false },
      cached: false,
      executed: false,
      control: true,
    };
  }

  return results.filter((result): result is ExecutedToolCall => result !== undefined);
}

async function executeOneTool(
  call: ModelToolCall,
  metadata: ToolExecutionMetadata,
  stepId: StepId,
  context: RunContext,
  signal: AbortSignal,
  state: RuntimeExecutionState,
): Promise<ExecutedToolCall> {
  const cacheKey = metadata.readOnly
    ? `${String(state.workspaceRevision)}:${call.name}:${stableStringify(call.input)}`
    : undefined;
  if (cacheKey !== undefined) {
    const cached = state.cache.get(cacheKey);
    if (cached !== undefined) {
      return { call, result: cached, metadata, cached: true, executed: false, control: false };
    }
    const pending = state.inFlight.get(cacheKey);
    if (pending !== undefined) {
      return {
        call,
        result: await pending,
        metadata,
        cached: true,
        executed: false,
        control: false,
      };
    }
  }

  const operation = context.executeTool(
    stepId,
    { callId: call.id, name: call.name, input: call.input },
    signal,
  );
  if (cacheKey !== undefined) state.inFlight.set(cacheKey, operation);
  let result: ToolExecutionResult;
  try {
    result = await operation;
  } finally {
    if (cacheKey !== undefined) state.inFlight.delete(cacheKey);
  }
  if (cacheKey !== undefined && result.ok) state.cache.set(cacheKey, result);
  if (metadata.mutatesWorkspace && result.ok) {
    state.workspaceRevision += 1;
    state.cache.clear();
  }
  return { call, result, metadata, cached: false, executed: true, control: false };
}

function toolMetadata(
  name: string,
  descriptor: ModelToolDescriptor | undefined,
): ToolExecutionMetadata {
  const enriched = descriptor as (ModelToolDescriptor & Partial<ToolExecutionMetadata>) | undefined;
  if (
    enriched?.readOnly !== undefined &&
    enriched.parallelSafe !== undefined &&
    enriched.mutatesWorkspace !== undefined
  ) {
    return {
      readOnly: enriched.readOnly,
      parallelSafe: enriched.parallelSafe,
      mutatesWorkspace: enriched.mutatesWorkspace,
    };
  }
  const readOnly = new Set([
    "listFiles",
    "readFile",
    "batchReadFiles",
    "searchCode",
    "batchSearchCode",
    "gitStatus",
    "gitDiff",
    "gitDiffSummary",
  ]).has(name);
  const mutatesWorkspace = new Set(["writeFile", "applyPatch", "runCommand"]).has(name);
  return { readOnly, parallelSafe: readOnly, mutatesWorkspace };
}

function controlFailure(message: string): ToolExecutionResult {
  return {
    ok: false,
    durationMs: 0,
    error: new DevflowError({ code: "VALIDATION_ERROR", message }).toJSON(),
  };
}

function finishSummary(call: ModelToolCall): string {
  if (typeof call.input !== "object" || call.input === null || !("summary" in call.input)) {
    return "";
  }
  const summary = (call.input as { summary?: unknown }).summary;
  return typeof summary === "string" ? summary.trim() : "";
}

function finishSchemaError(
  call: ModelToolCall,
  descriptor: ModelToolDescriptor | undefined,
): string | undefined {
  if (descriptor === undefined) return undefined;
  const parsed = descriptor.inputSchema.safeParse(call.input);
  return parsed.success ? undefined : "finishPhase input did not match its declared schema.";
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

/**
 * Builds the bounded, stage-local view sent to the model. AgentState retains the
 * complete messages for recovery/audit; only this request projection is compacted.
 */
export function projectModelMessages(
  messages: readonly ModelMessage[],
  maxBytes = MODEL_CONTEXT_MAX_BYTES,
): ModelMessage[] {
  let baseEnd = 0;
  while (
    baseEnd < messages.length &&
    (messages[baseEnd]?.role === "SYSTEM" || messages[baseEnd]?.role === "USER")
  ) {
    baseEnd += 1;
  }
  const base = messages.slice(0, baseEnd).map((message) => projectBaseMessage(message, false));
  const latestFiles = latestFileSnapshotMessage(messages);
  const groups = interactionGroups(messages.slice(baseEnd));
  let selectedGroups = groups.slice(-2);
  let projected = [
    ...base,
    ...(latestFiles === undefined ? [] : [latestFiles]),
    ...selectedGroups.flatMap((group) =>
      projectInteractionGroup(group, MODEL_INTERACTION_GROUP_MAX_BYTES),
    ),
  ];

  if (serializedBytes(projected) > maxBytes && selectedGroups.length > 1) {
    selectedGroups = selectedGroups.slice(-1);
    projected = [
      ...base,
      ...(latestFiles === undefined ? [] : [latestFiles]),
      ...selectedGroups.flatMap((group) =>
        projectInteractionGroup(group, MODEL_INTERACTION_GROUP_MAX_BYTES),
      ),
    ];
  }
  if (serializedBytes(projected) > maxBytes) {
    const compactBase = messages
      .slice(0, baseEnd)
      .map((message) => projectBaseMessage(message, true));
    projected = [
      ...compactBase,
      ...(latestFiles === undefined
        ? []
        : [{ ...latestFiles, content: truncateUtf8(latestFiles.content, 48 * 1_024) }]),
      ...selectedGroups.slice(-1).flatMap((group) => projectInteractionGroup(group, 40 * 1_024)),
    ];
  }
  if (serializedBytes(projected) > maxBytes) {
    projected = projected.map((message) => emergencyCompactMessage(message));
  }
  if (serializedBytes(projected) > maxBytes) {
    const firstSystem = messages.find(({ role }) => role === "SYSTEM");
    const fixedUsers = messages
      .slice(0, baseEnd)
      .filter((message): message is { role: "USER"; content: string } => message.role === "USER")
      .slice(0, 3);
    projected = [
      ...(firstSystem?.role !== "SYSTEM"
        ? []
        : [{ role: "SYSTEM" as const, content: truncateUtf8(firstSystem.content, 4_096) }]),
      ...fixedUsers.map((message) => ({
        role: "USER" as const,
        content: truncateUtf8(message.content, 8_192),
      })),
      ...(latestFiles === undefined
        ? []
        : [{ ...latestFiles, content: truncateUtf8(latestFiles.content, 24 * 1_024) }]),
      ...groups.slice(-1).flatMap((group) => projectInteractionGroup(group, 16 * 1_024)),
    ];
  }
  return projected;
}

function interactionGroups(messages: readonly ModelMessage[]): ModelMessage[][] {
  const groups: ModelMessage[][] = [];
  let current: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "ASSISTANT" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function projectBaseMessage(message: ModelMessage, compact: boolean): ModelMessage {
  if (message.role === "SYSTEM") {
    return { role: "SYSTEM", content: truncateUtf8(message.content, compact ? 8_192 : 24_576) };
  }
  if (message.role === "USER") {
    return { role: "USER", content: truncateUtf8(message.content, compact ? 24_576 : 57_344) };
  }
  return message;
}

function projectInteractionGroup(
  group: readonly ModelMessage[],
  budgetBytes: number,
): ModelMessage[] {
  const toolMessages = group.filter(
    (message): message is Extract<ModelMessage, { role: "TOOL" }> => message.role === "TOOL",
  );
  const retainedToolMessages = toolMessages.slice(-24);
  const retainedIds = new Set(retainedToolMessages.map(({ toolCallId }) => toolCallId));
  const payloadBudget = Math.min(
    MODEL_TOOL_RESULT_MAX_BYTES,
    Math.max(512, Math.floor((budgetBytes - 8_192) / (retainedToolMessages.length * 2 + 1))),
  );
  const projected: ModelMessage[] = [];
  for (const message of group) {
    if (message.role === "TOOL") {
      if (!retainedIds.has(message.toolCallId)) continue;
      projected.push({ ...message, content: boundModelValue(message.content, payloadBudget) });
      continue;
    }
    if (message.role === "ASSISTANT") {
      const candidateCalls =
        retainedIds.size === 0
          ? message.toolCalls?.slice(-12)
          : message.toolCalls?.filter(({ id }) => retainedIds.has(id));
      const toolCalls = candidateCalls?.map((call) => ({
        ...call,
        input: boundModelValue(call.input, payloadBudget),
      }));
      projected.push({
        role: "ASSISTANT",
        content: truncateUtf8(message.content, 8_192),
        ...(toolCalls === undefined ? {} : { toolCalls }),
      });
      continue;
    }
    projected.push({ ...message, content: truncateUtf8(message.content, 4_096) });
  }
  return projected;
}

function emergencyCompactMessage(message: ModelMessage): ModelMessage {
  if (message.role === "TOOL") {
    return { ...message, content: boundModelValue(message.content, 1_024) };
  }
  if (message.role === "ASSISTANT") {
    return {
      role: "ASSISTANT",
      content: truncateUtf8(message.content, 2_048),
      ...(message.toolCalls === undefined
        ? {}
        : {
            toolCalls: message.toolCalls.slice(-12).map((call) => ({
              ...call,
              input: boundModelValue(call.input, 768),
            })),
          }),
    };
  }
  return { ...message, content: truncateUtf8(message.content, 8_192) };
}

function boundModelValue(value: unknown, maxBytes: number): JsonValue {
  const normalized = jsonValue(value);
  const serialized = JSON.stringify(normalized);
  const originalBytes = Buffer.byteLength(serialized);
  if (originalBytes <= maxBytes) return normalized;
  return {
    _devflow: {
      truncated: true,
      originalBytes,
      preview: truncateUtf8(serialized, Math.max(0, maxBytes - 128)),
    },
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  const suffix = "\n…[truncated]";
  const suffixBytes = Buffer.byteLength(suffix);
  if (suffixBytes >= maxBytes) return utf8Prefix(suffix, maxBytes);
  return `${utf8Prefix(value, maxBytes - suffixBytes)}${suffix}`;
}

function utf8Prefix(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function latestFileSnapshotMessage(
  messages: readonly ModelMessage[],
): { role: "USER"; content: string } | undefined {
  const latest = new Map<string, { path: string; content: string; truncated?: boolean }>();
  for (const message of messages) {
    if (message.role === "ASSISTANT") {
      if (
        message.toolCalls?.some(({ name }) =>
          new Set(["writeFile", "applyPatch", "runCommand"]).has(name),
        ) === true
      ) {
        latest.clear();
      }
      continue;
    }
    if (message.role !== "TOOL" || message.isError === true) continue;
    if (message.toolName === "readFile") {
      rememberFileSnapshot(latest, message.content);
      continue;
    }
    if (message.toolName === "batchReadFiles") {
      const output = objectValue(message.content);
      const files = output?.files;
      if (!Array.isArray(files)) continue;
      for (const file of files) rememberFileSnapshot(latest, file);
    }
  }
  if (latest.size === 0) return undefined;
  const files = [...latest.values()].slice(-8).map((file) => ({
    ...file,
    content: truncateUtf8(file.content, 24 * 1_024),
  }));
  return {
    role: "USER",
    content: `Latest relevant file snapshots (newer reads replace older versions):\n${truncateUtf8(
      JSON.stringify(files),
      160 * 1_024,
    )}`,
  };
}

function rememberFileSnapshot(
  latest: Map<string, { path: string; content: string; truncated?: boolean }>,
  value: unknown,
): void {
  const record = objectValue(value);
  if (
    record?.ok === false ||
    typeof record?.path !== "string" ||
    typeof record.content !== "string"
  ) {
    return;
  }
  latest.delete(record.path);
  latest.set(record.path, {
    path: record.path,
    content: record.content,
    ...(typeof record.truncated === "boolean" ? { truncated: record.truncated } : {}),
  });
  while (latest.size > 8) {
    const oldest = latest.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    latest.delete(oldest);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function buildUserMessages(
  request: AgentRunRequest,
  title: string,
  description: string,
): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "USER", content: `Task:\n${title}\n\n${description}` }];
  if (request.approvedPlan !== undefined) {
    messages.push({
      role: "USER",
      content: `Approved plan (follow this plan):\n${JSON.stringify(request.approvedPlan, null, 2)}`,
    });
  }
  if (request.additionalContext !== undefined) {
    messages.push({
      role: "USER",
      content: `Repository/stage evidence:\n${request.additionalContext}`,
    });
  }
  return messages;
}

function validateRunRequest(request: AgentRunRequest): void {
  if (!Number.isInteger(request.maxSteps) || request.maxSteps < 1) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "maxSteps must be a positive integer.",
    });
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "timeoutMs must be a positive integer.",
    });
  }
  if (!Number.isInteger(request.maxRetries) || request.maxRetries < 0) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "maxRetries must be a non-negative integer.",
    });
  }
  if (request.adaptiveStepBudget !== undefined) {
    for (const [name, value] of Object.entries({
      initialLimit: request.adaptiveStepBudget.initialLimit,
      hardLimit: request.adaptiveStepBudget.hardLimit,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new DevflowError({
          code: "VALIDATION_ERROR",
          message: `adaptiveStepBudget.${name} must be a positive integer.`,
        });
      }
    }
    if (typeof request.adaptiveStepBudget.onLimitReached !== "function") {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "adaptiveStepBudget.onLimitReached must be a function.",
      });
    }
  }
  if (request.executionBudget !== undefined) {
    for (const [name, value] of Object.entries({
      maxModelCalls: request.executionBudget.maxModelCalls,
      maxToolCalls: request.executionBudget.maxToolCalls,
      maxTotalTokens: request.executionBudget.maxTotalTokens,
    })) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new DevflowError({
          code: "VALIDATION_ERROR",
          message: `executionBudget.${name} must be a non-negative integer.`,
        });
      }
    }
  }
}

function assertExecutionBudget(
  request: AgentRunRequest,
  budgetType: "modelCalls" | "toolCalls" | "totalTokens",
  observed: number,
): void {
  const budget = request.executionBudget;
  if (budget === undefined) return;
  const limit =
    budgetType === "modelCalls"
      ? budget.maxModelCalls
      : budgetType === "toolCalls"
        ? budget.maxToolCalls
        : budget.maxTotalTokens;
  if (observed <= limit) return;
  throw new DevflowError({
    code: "EXECUTION_BUDGET_EXCEEDED",
    message: `${budget.stage} exceeded the ${budgetType} execution budget.`,
    details: { stage: budget.stage, budgetType, limit, observed },
  });
}

async function checkpoint(context: RunContext, state: AgentState): Promise<AgentState> {
  const updated = { ...state, updatedAt: new Date().toISOString() };
  await context.stateStore?.save(updated);
  return updated;
}

function toolResultMessage(call: ModelToolCall, result: ToolExecutionResult): ModelMessage {
  return result.ok
    ? {
        role: "TOOL",
        toolCallId: call.id,
        toolName: call.name,
        content: jsonValue(result.output),
        isError: false,
      }
    : {
        role: "TOOL",
        toolCallId: call.id,
        toolName: call.name,
        content: jsonValue(result.error),
        isError: true,
      };
}

function normalizeToolCall(call: ModelToolCall): ModelToolCall {
  return { ...call, input: jsonValue(call.input) };
}

function runMetrics(state: AgentState): RunMetrics {
  return {
    durationMs: Math.max(0, Date.now() - Date.parse(state.startedAt)),
    steps: state.stepCount,
    modelCalls: state.metrics.modelCalls,
    toolCalls: state.metrics.toolCalls,
    toolExecutions: state.metrics.toolExecutions,
    cacheHits: state.metrics.cacheHits,
    reasoningTokens: state.metrics.reasoningTokens,
    retries: state.metrics.retries,
    modelLatencyMs: state.metrics.modelLatencyMs,
    toolLatencyMs: state.metrics.toolLatencyMs,
    tokenUsage: state.metrics.tokenUsage,
    control: {
      duplicateToolCalls: state.metrics.duplicateToolCalls,
      contextCacheHits: state.metrics.cacheHits,
      structuredOutputFailures: 0,
      structuredOutputRepairAttempts: 0,
      stalledDetections: state.metrics.stalledDetections,
    },
  };
}

function throwIfAborted(
  signal: AbortSignal,
  callerSignal: AbortSignal,
  deadlineSignal: AbortSignal,
): void {
  if (!signal.aborted) return;
  if (callerSignal.aborted) {
    throw new DevflowError({ code: "CANCELLED", message: "Agent run was cancelled." });
  }
  if (deadlineSignal.aborted) {
    throw new DevflowError({ code: "TIMEOUT", message: "Agent run deadline exceeded." });
  }
  signal.throwIfAborted();
}

function normalizeRunError(
  error: unknown,
  callerSignal: AbortSignal,
  deadlineSignal: AbortSignal,
): DevflowError {
  if (callerSignal.aborted) {
    return new DevflowError({ code: "CANCELLED", message: "Agent run was cancelled." });
  }
  if (deadlineSignal.aborted) {
    return new DevflowError({ code: "TIMEOUT", message: "Agent run deadline exceeded." });
  }
  return toDevflowError(error, {
    code: "LLM_FAILED",
    message: "Agent execution failed.",
  });
}

function isRetryableModelError(error: unknown): boolean {
  if (error instanceof DevflowError) return error.retryable;
  return !(
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { retryable?: unknown }).retryable === false
  );
}

function errorSummary(error: unknown): unknown {
  if (error instanceof DevflowError) return error.toJSON();
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: String(error) };
}

function nonnegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}
