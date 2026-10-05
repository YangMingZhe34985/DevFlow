import { createHash, randomUUID } from "node:crypto";
import type { ContextStage } from "./stage-context.js";
import {
  prepareCompressedStageContext,
  type ContextCompressionOptions,
  type ContextCompressionState,
} from "./context-compression.js";
import { deduplicateContext, invalidateHistoricalReads, type WorkingSet } from "./working-set.js";
import { CANDIDATE_SUMMARY, type PostPatchController } from "./post-patch.js";
import type { PrePatchController } from "./pre-patch.js";

import {
  DevflowError,
  toDevflowError,
  PhaseCompletionSchema,
  type AgentPlan,
  type JsonValue,
} from "@devflow/shared";

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
  patchReady?: boolean;
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
  evidenceDiscoveries: number;
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
  contextCompression?: ContextCompressionOptions;
  contextCompressionState?: ContextCompressionState;
  contextStage?: ContextStage;
  contextMaxBytes?: number;
  prePatch?: PrePatchController;
  postPatch?: PostPatchController;
  traceEfficiency?: boolean;
  workingSet?: WorkingSet;
  deduplicateContext?: boolean;
  approvedPlan?: AgentPlan;
  systemPrompt?: string;
  additionalContext?: string;
  /** Versioned localization evidence is valid only before the first workspace mutation. */
  invalidateAdditionalContextOnMutation?: boolean;
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
  postPatch?: PostPatchController;
  runId: RunId;
  task: TaskSpec;
  signal: AbortSignal;
  tools: readonly ModelToolDescriptor[];
  availableTools?(): readonly ModelToolDescriptor[];
  authorizeTool?(request: ToolExecutionRequest): string | undefined;
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
    const postPatch = request.postPatch;
    if (postPatch) context = { ...context, postPatch };
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
    if (restoredState === undefined && request.contextCompressionState)
      state = { ...state, contextCompression: structuredClone(request.contextCompressionState) };
    const messages: ModelMessage[] = [...state.messages];
    const execution = createExecutionState(context.tools);
    const initialRevision = request.workingSet?.workspaceRevision ?? 0;
    execution.workspaceRevision = initialRevision;
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
          const snapshot = {
            ...agentProgressSnapshot(state, execution, adaptiveStepBudget),
            ...(postPatch ? { patchReady: postPatch.ready } : {}),
          };
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
          const prePatch =
            request.prePatch?.active === true && !postPatch?.active ? request.prePatch : undefined;
          if (!prePatch) {
            postPatch?.modelStarted();
            state = await checkpoint(context, {
              ...state,
              metrics: {
                ...state.metrics,
                modelCalls: state.metrics.modelCalls + 1,
              },
            });
          }
          const validMessages = request.deduplicateContext
            ? invalidateHistoricalReads(messages)
            : messages;
          const currentMessages =
            request.invalidateAdditionalContextOnMutation === true &&
            execution.workspaceRevision !== initialRevision
              ? validMessages.filter(
                  (message) =>
                    !(
                      message.role === "USER" &&
                      typeof message.content === "string" &&
                      message.content.startsWith("Repository/stage evidence:\n")
                    ),
                )
              : validMessages;
          const priorCompressionReserve = state.contextCompression?.pendingTokenReserve ?? 0;
          const compressionStepId = randomUUID();
          let projectedMessages = request.contextStage
            ? (
                await prepareCompressedStageContext({
                  stage: request.contextStage,
                  history: currentMessages,
                  maxBytes: request.contextMaxBytes ?? 96000,
                  workspaceRevision: execution.workspaceRevision,
                  authoritative: {
                    stage: request.contextStage,
                    workspaceRevision: execution.workspaceRevision,
                    approvalScope: request.approvedPlan?.approvalScope ?? null,
                    executionBudget: request.executionBudget ?? null,
                  },
                  signal,
                  ...(state.contextCompression
                    ? { compressionState: state.contextCompression }
                    : {}),
                  budget: {
                    remainingCalls:
                      (request.executionBudget?.maxModelCalls ?? request.maxSteps) -
                      state.metrics.modelCalls,
                    remainingSteps:
                      (adaptiveStepBudget?.currentLimit ?? request.maxSteps) - state.stepCount,
                    remainingTokens:
                      (request.executionBudget?.maxTotalTokens ?? Number.MAX_SAFE_INTEGER) -
                      state.metrics.tokenUsage.totalTokens -
                      (state.contextCompression?.pendingTokenReserve ?? 0),
                    mainOutputReserve:
                      request.contextCompression?.mainOutputReserve ??
                      request.modelSettings?.maxOutputTokens ??
                      8192,
                  },
                  ...(!request.contextCompression || prePatch || postPatch?.active
                    ? {}
                    : {
                        compression: {
                          ...request.contextCompression,
                          onRequest: async (reservation) => {
                            state = await checkpoint(context, {
                              ...state,
                              stepCount: state.stepCount + 1,
                              contextCompression: reservation.state,
                              metrics: {
                                ...state.metrics,
                                modelCalls: state.metrics.modelCalls + 1,
                              },
                            });
                            await context.emit({
                              runId: context.runId,
                              stepId: compressionStepId,
                              type: "STEP_STARTED",
                              occurredAt: new Date().toISOString(),
                              payload: { step: state.stepCount, contextCompression: true },
                            });
                            await context.emit({
                              runId: context.runId,
                              stepId: compressionStepId,
                              type: "WORKFLOW_CHECKPOINT",
                              occurredAt: new Date().toISOString(),
                              payload: {
                                contextCompressionReservation: { delta: reservation.tokens },
                              },
                            });
                            await context.emit({
                              runId: context.runId,
                              stepId: compressionStepId,
                              type: "LLM_REQUEST",
                              occurredAt: new Date().toISOString(),
                              payload: {
                                contextCompression: true,
                                contextCompressionState: jsonValue(reservation.state),
                                outputReserveTokens:
                                  request.contextCompression!.maxOutputTokens ?? 2048,
                              },
                            });
                            await request.contextCompression?.onRequest?.(reservation);
                          },
                          onResponse: async (summary) => {
                            const reserve =
                              (state.contextCompression?.pendingTokenReserve ?? 0) -
                              priorCompressionReserve;
                            state = await checkpoint(context, {
                              ...state,
                              contextCompression: {
                                ...state.contextCompression!,
                                pendingTokenReserve: priorCompressionReserve,
                              },
                              metrics: {
                                ...state.metrics,
                                modelLatencyMs:
                                  state.metrics.modelLatencyMs +
                                  nonnegativeInteger(summary.latencyMs),
                                reasoningTokens:
                                  state.metrics.reasoningTokens +
                                  nonnegativeInteger(summary.reasoningTokens ?? 0),
                                tokenUsage: {
                                  inputTokens:
                                    state.metrics.tokenUsage.inputTokens +
                                    summary.usage.inputTokens,
                                  outputTokens:
                                    state.metrics.tokenUsage.outputTokens +
                                    summary.usage.outputTokens,
                                  totalTokens:
                                    state.metrics.tokenUsage.totalTokens +
                                    summary.usage.totalTokens,
                                },
                              },
                            });
                            await context.emit({
                              runId: context.runId,
                              stepId: compressionStepId,
                              type: "WORKFLOW_CHECKPOINT",
                              occurredAt: new Date().toISOString(),
                              payload: { contextCompressionReservation: { delta: -reserve } },
                            });
                            await context.emit({
                              runId: context.runId,
                              stepId: compressionStepId,
                              type: "LLM_RESPONSE",
                              occurredAt: new Date().toISOString(),
                              payload: {
                                ok: true,
                                contextCompression: true,
                                finishReason: summary.finishReason,
                                latencyMs: summary.latencyMs,
                                usage: jsonValue(summary.usage),
                                reasoningTokens: summary.reasoningTokens ?? 0,
                              },
                            });
                            assertExecutionBudget(
                              request,
                              "totalTokens",
                              state.metrics.tokenUsage.totalTokens +
                                (state.contextCompression?.pendingTokenReserve ?? 0),
                            );
                            await request.contextCompression?.onResponse?.(summary);
                          },
                          onError: async (latencyMs, error) => {
                            state = await checkpoint(context, {
                              ...state,
                              metrics: {
                                ...state.metrics,
                                modelLatencyMs:
                                  state.metrics.modelLatencyMs + nonnegativeInteger(latencyMs),
                              },
                            });
                            await context.emit({
                              runId: context.runId,
                              stepId: compressionStepId,
                              type: "LLM_RESPONSE",
                              level: "WARN",
                              occurredAt: new Date().toISOString(),
                              payload: {
                                ok: false,
                                contextCompression: true,
                                latencyMs,
                                unknownUsageReservedTokens:
                                  state.contextCompression?.pendingTokenReserve ?? 0,
                              },
                            });
                            await request.contextCompression?.onError?.(latencyMs, error);
                          },
                        },
                      }),
                }).then(async (artifact) => {
                  if (artifact.compression.requestIssued)
                    await context.emit({
                      runId: context.runId,
                      stepId: compressionStepId,
                      type: "STEP_COMPLETED",
                      occurredAt: new Date().toISOString(),
                      payload: {
                        contextCompression: true,
                        summaryStatus: artifact.compression.status,
                        toolObservationsPersisted: true,
                      },
                    });
                  state = await checkpoint(context, {
                    ...state,
                    contextCompression: artifact.compression.state,
                  });
                  assertExecutionBudget(
                    request,
                    "totalTokens",
                    state.metrics.tokenUsage.totalTokens +
                      artifact.compression.state.pendingTokenReserve,
                  );
                  return artifact;
                })
              ).view
            : projectModelMessages(currentMessages);
          if (request.deduplicateContext)
            projectedMessages = deduplicateContext(
              projectedMessages,
              request.workingSet,
              execution.workspaceRevision,
            );
          if (postPatch?.active)
            projectedMessages = projectModelMessages(postPatch.messages(request.approvedPlan));
          const availableTools = (context.availableTools?.() ?? context.tools).filter(
            (t) => postPatch?.allowed(t.name) !== false && (prePatch?.available(t) ?? true),
          );
          if (prePatch) {
            const preflight = prePatch.preflight(
              request.systemPrompt ?? (initialMessages[0]!.content as string),
              availableTools,
              (request.executionBudget?.maxTotalTokens ?? Number.MAX_SAFE_INTEGER) -
                state.metrics.tokenUsage.totalTokens,
              request.modelSettings,
            );
            projectedMessages = [...preflight.request.messages];
            await context.emit({
              runId: context.runId,
              stepId,
              type: "WORKFLOW_CHECKPOINT",
              occurredAt: new Date().toISOString(),
              payload: { prePatchPreflight: jsonValue(preflight.observation) },
            });
            state = await checkpoint(context, {
              ...state,
              metrics: {
                ...state.metrics,
                modelCalls: state.metrics.modelCalls + 1,
              },
            });
          }
          await context.emit({
            runId: context.runId,
            stepId,
            type: "LLM_REQUEST",
            occurredAt: new Date().toISOString(),
            payload: {
              messageCount: projectedMessages.length,
              originalMessageCount: messages.length,
              contextBytes: serializedBytes(projectedMessages),
              toolCount: availableTools.length,
              attempt: attempt + 1,
            },
          });

          const attemptStartedAt = Date.now();
          try {
            const modelRequest: ModelRequest = {
              messages: projectedMessages,
              tools: availableTools,
              ...(request.modelSettings === undefined ? {} : { settings: request.modelSettings }),
            };
            response = await this.model.generate(modelRequest, { signal });
            request.prePatch?.usage(response.usage.inputTokens, response.usage.outputTokens);
            postPatch?.modelUsage(response.usage.inputTokens, response.usage.outputTokens);
            state = {
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
            };
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
                toolCalls: response.toolCalls.map(({ id, name }) => ({
                  id,
                  name,
                })),
              },
            });
            state = await checkpoint(context, state);
            assertExecutionBudget(
              request,
              "totalTokens",
              state.metrics.tokenUsage.totalTokens +
                (state.contextCompression?.pendingTokenReserve ?? 0),
            );
            break;
          } catch (error) {
            // A successful provider call followed by a persistence/budget error
            // is not a second failed model call, and must not be retried.
            if (response !== undefined) throw error;
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
        if (response.finishReason === "LENGTH" && request.prePatch?.active) {
          const recovered = request.prePatch.recoverLength(response.toolCalls.length);
          await context.emit({
            runId: context.runId,
            stepId,
            type: "WORKFLOW_CHECKPOINT",
            occurredAt: new Date().toISOString(),
            payload: { prePatchLength: jsonValue(request.prePatch.metrics()) },
          });
          if (!recovered)
            throw request.prePatch.failure(
              "LLM_FAILED",
              "Model stopped with 'LENGTH'; no bounded correction remains or the response contains incomplete tool actions.",
            );
          await context.emit({
            runId: context.runId,
            stepId,
            type: "STEP_COMPLETED",
            occurredAt: new Date().toISOString(),
            payload: { step: state.stepCount, recovery: "MODEL_OUTPUT_LENGTH" },
          });
          request.prePatch.endDecision();
          continue;
        }
        if (response.toolCalls.length === 0 && response.finishReason !== "STOP") {
          throw new DevflowError({
            code: "LLM_FAILED",
            message: `Model stopped with '${response.finishReason}' before completing the task.`,
          });
        }

        if (response.toolCalls.length === 0) {
          if (request.prePatch?.active)
            throw request.prePatch.failure(
              "PRE_PATCH_EXPLORATION_STALLED",
              "Model stopped before a real APPLIED candidate mutation.",
            );
          if (postPatch && !postPatch.ready)
            throw new DevflowError({
              code: "AGENT_STALLED",
              message: "NO_VALID_PATCH: completion requires a current, stable candidate patch.",
            });
          const summary = postPatch
            ? CANDIDATE_SUMMARY
            : response.text?.trim() || "Agent completed without a text summary.";
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
            metrics: {
              ...runMetrics(state),
              ...(request.prePatch ? { prePatch: request.prePatch.metrics() } : {}),
            },
            ...(postPatch ? { executeCompletion: postPatch.result(true) } : {}),
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
        // A deterministic, budgeted probe follows mutations, including same-batch finishPhase.
        // Never trust a model-filtered/cached/base-relative diff as completion evidence.
        if (
          postPatch &&
          calls.some((c) => toolMetadata(c.name, execution.tools.get(c.name)).mutatesWorkspace) &&
          !calls
            .slice(
              calls.findLastIndex(
                (c) => toolMetadata(c.name, execution.tools.get(c.name)).mutatesWorkspace,
              ) + 1,
            )
            .some(
              (c) =>
                c.name === "gitDiff" &&
                !objectValue(c.input)?.base &&
                !objectValue(c.input)?.cached &&
                !objectValue(c.input)?.paths,
            )
        ) {
          const finishIndex = calls.findIndex((c) => c.name === "finishPhase");
          calls.splice(finishIndex < 0 ? calls.length : finishIndex, 0, {
            id: randomUUID(),
            name: "gitDiff",
            input: { maxBytes: 32768 },
          });
        }
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

        const batchStartedAt = Date.now();
        const revisionBeforeBatch = execution.workspaceRevision;
        const executedCalls = await executeToolBatch(
          calls,
          stepId,
          context,
          signal,
          execution,
          async (observed) => {
            const usage = {
              calls: 1,
              executions: observed.executed ? 1 : 0,
              cacheHits: observed.cached ? 1 : 0,
              latencyMs: observed.executed ? observed.result.durationMs : 0,
            };
            state = {
              ...state,
              metrics: {
                ...state.metrics,
                toolCalls: state.metrics.toolCalls + 1,
                toolExecutions: state.metrics.toolExecutions + usage.executions,
                cacheHits: state.metrics.cacheHits + usage.cacheHits,
                toolLatencyMs: state.metrics.toolLatencyMs + usage.latencyMs,
              },
            };
            await context.emit({
              runId: context.runId,
              stepId,
              type: "WORKFLOW_CHECKPOINT",
              occurredAt: new Date().toISOString(),
              payload: {
                toolObservation: { callId: observed.call.id, ...usage },
              },
            });
          },
        );
        if (request.traceEfficiency) {
          let revision = revisionBeforeBatch;
          for (const executed of executedCalls) {
            await context.emit({
              runId: context.runId,
              stepId,
              type: "WORKFLOW_CHECKPOINT",
              occurredAt: new Date().toISOString(),
              payload: {
                efficiencyTool: {
                  callId: executed.call.id,
                  toolName: executed.call.name,
                  inputFingerprint: createHash("sha256")
                    .update(stableStringify(executed.call.input))
                    .digest("hex"),
                  resultFingerprint: createHash("sha256")
                    .update(
                      stableStringify(
                        executed.result.ok ? executed.result.output : executed.result.error,
                      ),
                    )
                    .digest("hex"),
                  workspaceRevision: revision,
                  revisionAfter:
                    executed.result.mutation?.afterRevision ??
                    revision + (executed.metadata.mutatesWorkspace && executed.executed ? 1 : 0),
                  startedAt: executed.startedAt ?? batchStartedAt,
                  wallMs: executed.wallMs ?? 0,
                  sourceBytes:
                    executed.result.ok && !executed.cached
                      ? sourceContentBytes(executed.result.output)
                      : 0,
                  cached: executed.cached,
                  ok: executed.result.ok,
                  mutatesWorkspace: executed.metadata.mutatesWorkspace,
                  mutationApplied:
                    executed.result.mutation?.mutationApplied ??
                    (executed.metadata.mutatesWorkspace &&
                      executed.result.ok &&
                      objectValue(executed.result.output)?.applied !== false),
                  normalizedMutation: executed.result.mutation
                    ? jsonValue(executed.result.mutation)
                    : null,
                  patchApplied:
                    executed.call.name === "applyPatch" && executed.result.ok
                      ? objectValue(executed.result.output)?.applied === true
                      : null,
                  paths: jsonValue(toolPaths(executed.call, executed.result)),
                  errorCode: !executed.result.ok ? executed.result.error.code : null,
                },
              },
            });
            if (executed.metadata.mutatesWorkspace && executed.executed)
              revision = executed.result.mutation?.afterRevision ?? revision + 1;
          }
        }
        // Persist denied and cached calls before any controller can terminate the decision.
        for (const executed of executedCalls) {
          await context.emit({
            runId: context.runId,
            stepId,
            type: "WORKFLOW_CHECKPOINT",
            occurredAt: new Date().toISOString(),
            payload: {
              toolDecision: jsonValue({
                callId: executed.call.id,
                name: executed.call.name,
                input: executed.call.input,
                cached: executed.cached,
                executed: executed.executed,
                ok: executed.result.ok,
                error: executed.result.ok ? null : executed.result.error,
                mutation: executed.result.mutation ?? null,
              }),
            },
          });
        }
        for (const executed of executedCalls)
          await request.prePatch?.observe(executed.call, executed.result);
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
        let newEvidence = false;
        for (const { call, result, metadata } of normalCalls) {
          if (metadata.mutatesWorkspace) continue;
          const identity = `${execution.workspaceRevision}:${call.name}:${stableStringify(result.ok ? result.output : { input: call.input, error: result.error })}`;
          if (!execution.evidenceSeen.has(identity)) {
            execution.evidenceSeen.add(identity);
            if (result.ok) execution.evidenceDiscoveries++;
            newEvidence = true;
          }
        }
        const madeWorkspaceProgress = normalCalls.some(
          ({ metadata, result }) =>
            result.mutation?.mutationApplied ?? (metadata.mutatesWorkspace && result.ok),
        );
        const successfulMutations = normalCalls.filter(
          ({ metadata, result }) =>
            result.mutation?.mutationApplied ?? (metadata.mutatesWorkspace && result.ok),
        ).length;
        const observedDiff =
          (postPatch === undefined || postPatch.active) &&
          normalCalls.some(({ call, result }) =>
            !result.ok ? false : hasDiffEvidence(call.name, result.output),
          );
        const observedDiffFingerprint = postPatch
          ? (postPatch.diffFingerprint ?? undefined)
          : diffEvidenceFingerprint(normalCalls);
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
          normalCalls.length > 0 &&
          (normalCalls.every(({ cached }) => cached) ||
            (!madeWorkspaceProgress && !newEvidence) ||
            (!madeWorkspaceProgress &&
              normalCalls.some(({ result }) => result.mutation !== undefined)));
        state = await checkpoint(context, {
          ...state,
          phase: "CALLING_TOOL",
          messages,
          metrics: {
            ...state.metrics,
            duplicateToolCalls: state.metrics.duplicateToolCalls + cachedToolCalls,
            stalledDetections: state.metrics.stalledDetections + (repeatedWithoutProgress ? 1 : 0),
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
                "Convergence warning: the previous calls produced no new evidence or workspace change. Do not repeat unchanged reads, failed calls or no-op edits; change strategy or finish with the unresolved gap.",
            });
          } else {
            throw new DevflowError({
              code: "AGENT_STALLED",
              message: postPatch?.ready
                ? "PATCH_READY_BUT_NOT_FINISHED: repeated confirmation instead of phase handoff."
                : "Agent repeated the same unchanged tool calls without making progress.",
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
            toolObservationsPersisted: true,
            toolCalls: calls.length,
            toolExecutions,
            cachedToolCalls,
            toolLatencyMs: actualToolLatencyMs,
            workspaceRevision: execution.workspaceRevision,
          },
        });

        request.prePatch?.endDecision();
        const finishCall = executedCalls.find(({ control }) => control);
        if (finishCall?.result.ok === true || (postPatch?.ready && postPatch.autoFinish)) {
          throwIfAborted(signal, context.signal, deadlineSignal);
          const summary = postPatch ? CANDIDATE_SUMMARY : finishSummary(finishCall!.call);
          const result: RunResult = {
            runId: context.runId,
            status: "SUCCEEDED",
            summary,
            metrics: {
              ...runMetrics(state),
              ...(request.prePatch ? { prePatch: request.prePatch.metrics() } : {}),
            },
            ...(postPatch ? { executeCompletion: postPatch.result(true) } : {}),
            ...(finishCall && PhaseCompletionSchema.safeParse(finishCall.call.input).success
              ? { phaseCompletion: PhaseCompletionSchema.parse(finishCall.call.input) }
              : {}),
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
        state = await checkpoint(context, {
          ...state,
          phase: "THINKING",
          messages,
        });
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
        metrics: {
          ...runMetrics(state),
          ...(request.prePatch ? { prePatch: request.prePatch.metrics() } : {}),
        },
        error: normalized.toJSON(),
        ...(postPatch
          ? {
              executeCompletion: postPatch.result(
                false,
                normalized.message.startsWith("NO_VALID_PATCH:")
                  ? "NO_VALID_PATCH"
                  : normalized.code,
              ),
            }
          : {}),
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
          payload: {
            error: jsonValue(normalized.toJSON()),
            metrics: jsonValue(result.metrics),
          },
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
  evidenceSeen: Set<string>;
  evidenceDiscoveries: number;
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
  startedAt?: number;
  wallMs?: number;
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
    evidenceSeen: new Set(),
    evidenceDiscoveries: 0,
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
    evidenceDiscoveries: execution.evidenceDiscoveries,
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
  observe: (result: ExecutedToolCall) => Promise<void>,
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
      const batch: {
        call: ModelToolCall;
        index: number;
        metadata: ToolExecutionMetadata;
      }[] = [];
      while (cursor < calls.length) {
        const candidate = calls[cursor];
        if (candidate === undefined || candidate.name === "finishPhase") break;
        const candidateMetadata = toolMetadata(candidate.name, state.tools.get(candidate.name));
        if (!candidateMetadata.readOnly || !candidateMetadata.parallelSafe) break;
        batch.push({
          call: candidate,
          index: cursor,
          metadata: candidateMetadata,
        });
        cursor += 1;
      }
      const executed = await mapWithConcurrency(
        batch,
        MAX_PARALLEL_READS,
        async (entry) =>
          await executeOneTool(entry.call, entry.metadata, stepId, context, signal, state, observe),
      );
      for (let index = 0; index < batch.length; index += 1) {
        const entry = batch[index];
        const result = executed[index];
        if (entry !== undefined && result !== undefined) results[entry.index] = result;
      }
      continue;
    }
    results[cursor] = await executeOneTool(call, metadata, stepId, context, signal, state, observe);
    cursor += 1;
  }

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    if (call?.name !== "finishPhase") continue;
    const summary = finishSummary(call);
    const priorSucceeded = results.slice(0, index).every((result) => result?.result.ok === true);
    const isLast = index === calls.length - 1;
    const schemaError = finishSchemaError(call, state.tools.get("finishPhase"));
    context.postPatch?.toolStarted("finishPhase");
    const error =
      context.postPatch && !context.postPatch.ready
        ? "PATCH_NOT_READY: resolve observed mutation/diff/target blockers before finishing."
        : !isLast
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
          ? {
              ok: true,
              output: {
                finished: true,
                summary,
                ...PhaseCompletionSchema.safeParse(call.input).data,
              },
              durationMs: 0,
            }
          : controlFailure(error),
      metadata: {
        readOnly: true,
        parallelSafe: false,
        mutatesWorkspace: false,
      },
      cached: false,
      executed: false,
      control: true,
    };
    await observe(results[index]!);
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
  observe: (result: ExecutedToolCall) => Promise<void>,
): Promise<ExecutedToolCall> {
  const startedAt = Date.now();
  context.postPatch?.toolStarted(call.name);
  const result = await executeOneToolInner(call, metadata, stepId, context, signal, state);
  await observe(result);
  return { ...result, startedAt, wallMs: Date.now() - startedAt };
}

function sourceContentBytes(value: unknown): number {
  const record = objectValue(value);
  if (!record) return 0;
  return (
    (typeof record.content === "string" ? Buffer.byteLength(record.content) : 0) +
    (Array.isArray(record.files)
      ? record.files.reduce((n: number, f: unknown) => n + sourceContentBytes(f), 0)
      : 0)
  );
}

function toolPaths(call: ModelToolCall, result: ToolExecutionResult): string[] {
  const input = objectValue(call.input),
    output = result.ok ? objectValue(result.output) : undefined;
  return [
    ...new Set([
      ...(typeof input?.path === "string" ? [input.path] : []),
      ...(Array.isArray(input?.paths)
        ? input.paths.filter((p): p is string => typeof p === "string")
        : []),
      ...(Array.isArray(output?.changedFiles)
        ? output.changedFiles.filter((p): p is string => typeof p === "string")
        : []),
    ]),
  ].slice(0, 64);
}

async function executeOneToolInner(
  call: ModelToolCall,
  metadata: ToolExecutionMetadata,
  stepId: StepId,
  context: RunContext,
  signal: AbortSignal,
  state: RuntimeExecutionState,
): Promise<ExecutedToolCall> {
  const denied = context.authorizeTool?.({
    callId: call.id,
    name: call.name,
    input: call.input,
  });
  if (denied) {
    if (metadata.mutatesWorkspace && context.postPatch) {
      const revision = context.postPatch.revision;
      context.postPatch.observeMutation(
        {
          status: "REJECTED",
          executionSucceeded: false,
          mutationAttempted: false,
          mutationApplied: false,
          workspaceChanged: false,
          reason: denied,
          beforeRevision: revision,
          afterRevision: revision,
          changedFiles: [],
          currentHashes: {},
        },
        [],
      );
    }
    return {
      call,
      result: controlFailure(denied),
      metadata,
      cached: false,
      executed: false,
      control: false,
    };
  }
  const cacheKey = metadata.readOnly
    ? `${String(state.workspaceRevision)}:${call.name}:${stableStringify(call.input)}`
    : undefined;
  if (cacheKey !== undefined) {
    const cached = state.cache.get(cacheKey);
    if (cached !== undefined) {
      return {
        call,
        result: cached,
        metadata,
        cached: true,
        executed: false,
        control: false,
      };
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
  if (metadata.mutatesWorkspace) {
    state.workspaceRevision = result.mutation?.afterRevision ?? state.workspaceRevision + 1;
    state.cache.clear();
  }
  return {
    call,
    result,
    metadata,
    cached: false,
    executed: true,
    control: false,
  };
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
  const mutatesWorkspace = new Set(["writeFile", "replaceText", "applyPatch", "runCommand"]).has(
    name,
  );
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
        : [
            {
              ...latestFiles,
              content: truncateUtf8(latestFiles.content, 48 * 1_024),
            },
          ]),
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
        : [
            {
              role: "SYSTEM" as const,
              content: truncateUtf8(firstSystem.content, 4_096),
            },
          ]),
      ...fixedUsers.map((message) => ({
        role: "USER" as const,
        content: truncateUtf8(message.content, 8_192),
      })),
      ...(latestFiles === undefined
        ? []
        : [
            {
              ...latestFiles,
              content: truncateUtf8(latestFiles.content, 24 * 1_024),
            },
          ]),
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
    return {
      role: "SYSTEM",
      content: truncateUtf8(message.content, compact ? 8_192 : 24_576),
    };
  }
  if (message.role === "USER") {
    return {
      role: "USER",
      content: truncateUtf8(message.content, compact ? 24_576 : 57_344),
    };
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
      projected.push({
        ...message,
        content: boundModelValue(message.content, payloadBudget),
      });
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
    projected.push({
      ...message,
      content: truncateUtf8(message.content, 4_096),
    });
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

type FileSnapshot = {
  path: string;
  content: string;
  truncated?: boolean;
  startLine?: number;
  endLine?: number;
  fileSha256?: string;
  workspaceRevision?: number;
};
function latestFileSnapshotMessage(
  messages: readonly ModelMessage[],
): { role: "USER"; content: string } | undefined {
  const latest = new Map<string, FileSnapshot>();
  for (const message of messages) {
    if (message.role === "ASSISTANT") {
      if (
        message.toolCalls?.some(({ name }) =>
          new Set(["writeFile", "replaceText", "applyPatch", "runCommand"]).has(name),
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
  const files = [...latest.values()].slice(-8).map((file) => {
    const prefix = utf8Prefix(file.content, 1536);
    const partial = prefix !== file.content;
    const content = partial ? prefix.slice(0, prefix.lastIndexOf("\n") + 1) : prefix;
    const startLine = file.startLine ?? 1;
    const lines = content.match(/[^\n]*\n|[^\n]+$/gu)?.length ?? 0;
    return {
      ...file,
      content,
      startLine,
      endLine: lines ? startLine + lines - 1 : startLine - 1,
      truncated: file.truncated || partial,
      note: "Bounded historical snapshot. Use the tool result or current range read for exact source and identity.",
    };
  });
  while (serializedBytes(files) > 16 * 1024 && files.length > 1) files.shift();
  return {
    role: "USER",
    content: `Latest relevant file snapshots (newer reads replace older versions):\n${JSON.stringify(files)}`,
  };
}

function rememberFileSnapshot(latest: Map<string, FileSnapshot>, value: unknown): void {
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
    ...(typeof record.startLine === "number" ? { startLine: record.startLine } : {}),
    ...(typeof record.endLine === "number" ? { endLine: record.endLine } : {}),
    ...(typeof record.fileSha256 === "string" ? { fileSha256: record.fileSha256 } : {}),
    ...(typeof record.workspaceRevision === "number"
      ? { workspaceRevision: record.workspaceRevision }
      : {}),
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
    contextCompressionReservedTokens: state.contextCompression?.pendingTokenReserve ?? 0,
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
    throw new DevflowError({
      code: "CANCELLED",
      message: "Agent run was cancelled.",
    });
  }
  if (deadlineSignal.aborted) {
    throw new DevflowError({
      code: "TIMEOUT",
      message: "Agent run deadline exceeded.",
    });
  }
  signal.throwIfAborted();
}

function normalizeRunError(
  error: unknown,
  callerSignal: AbortSignal,
  deadlineSignal: AbortSignal,
): DevflowError {
  if (callerSignal.aborted) {
    return new DevflowError({
      code: "CANCELLED",
      message: "Agent run was cancelled.",
    });
  }
  if (deadlineSignal.aborted) {
    return new DevflowError({
      code: "TIMEOUT",
      message: "Agent run deadline exceeded.",
    });
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
