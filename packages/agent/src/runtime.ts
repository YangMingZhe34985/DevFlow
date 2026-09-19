import { randomUUID } from "node:crypto";

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
  ModelMessage,
  ModelResponse,
  ModelToolCall,
  ModelToolDescriptor,
} from "./model.js";
import {
  createInitialAgentState,
  type AgentPhase,
  type AgentState,
  type AgentStateStore,
} from "./state.js";

export type { AgentPhase, AgentState } from "./state.js";

export interface AgentRunRequest {
  approvedPlan?: AgentPlan;
  systemPrompt?: string;
  additionalContext?: string;
  emitRunLifecycle?: boolean;
  maxSteps: number;
  timeoutMs: number;
  maxRetries: number;
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
      {
        role: "USER",
        content: buildUserMessage(request, context.task.title, context.task.description),
      },
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
        },
      });
    }

    try {
      while (state.stepCount < request.maxSteps) {
        throwIfAborted(signal, context.signal, deadlineSignal);
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
          state = await checkpoint(context, {
            ...state,
            metrics: {
              ...state.metrics,
              modelCalls: state.metrics.modelCalls + 1,
            },
          });
          await context.emit({
            runId: context.runId,
            stepId,
            type: "LLM_REQUEST",
            occurredAt: new Date().toISOString(),
            payload: {
              messageCount: messages.length,
              toolCount: context.tools.length,
              attempt: attempt + 1,
            },
          });

          const attemptStartedAt = Date.now();
          try {
            response = await this.model.generate(
              { messages: [...messages], tools: context.tools },
              { signal },
            );
            state = await checkpoint(context, {
              ...state,
              metrics: {
                ...state.metrics,
                modelLatencyMs:
                  state.metrics.modelLatencyMs + nonnegativeInteger(response.latencyMs),
                tokenUsage: {
                  inputTokens: state.metrics.tokenUsage.inputTokens + response.usage.inputTokens,
                  outputTokens: state.metrics.tokenUsage.outputTokens + response.usage.outputTokens,
                  totalTokens: state.metrics.tokenUsage.totalTokens + response.usage.totalTokens,
                },
              },
            });
            await context.emit({
              runId: context.runId,
              stepId,
              type: "LLM_RESPONSE",
              occurredAt: new Date().toISOString(),
              payload: {
                ok: true,
                finishReason: response.finishReason,
                latencyMs: response.latencyMs,
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

        for (const call of calls) {
          throwIfAborted(signal, context.signal, deadlineSignal);
          const result = await context.executeTool(
            stepId,
            { callId: call.id, name: call.name, input: call.input },
            signal,
          );
          messages.push(toolResultMessage(call, result));
          state = await checkpoint(context, {
            ...state,
            phase: "CALLING_TOOL",
            messages,
            metrics: {
              ...state.metrics,
              toolCalls: state.metrics.toolCalls + 1,
              toolLatencyMs: state.metrics.toolLatencyMs + result.durationMs,
            },
          });
        }

        await context.emit({
          runId: context.runId,
          stepId,
          type: "STEP_COMPLETED",
          occurredAt: new Date().toISOString(),
          payload: { step: state.stepCount, toolCalls: calls.length },
        });
        state = await checkpoint(context, { ...state, phase: "THINKING", messages });
      }

      throw new DevflowError({
        code: "MAX_STEPS_EXCEEDED",
        message: `Agent exceeded the maximum of ${request.maxSteps} model steps.`,
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

function buildUserMessage(request: AgentRunRequest, title: string, description: string): string {
  const sections = [`${title}\n\n${description}`];
  if (request.approvedPlan !== undefined) {
    sections.push(
      `Approved plan (follow this plan):\n${JSON.stringify(request.approvedPlan, null, 2)}`,
    );
  }
  if (request.additionalContext !== undefined) sections.push(request.additionalContext);
  return sections.join("\n\n");
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
    retries: state.metrics.retries,
    modelLatencyMs: state.metrics.modelLatencyMs,
    toolLatencyMs: state.metrics.toolLatencyMs,
    tokenUsage: state.metrics.tokenUsage,
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
