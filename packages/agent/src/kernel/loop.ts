import type { AciTool } from "@devflow/tools";

import type {
  LanguageModelPort,
  ModelGenerationSettings,
  ModelMessage,
  ModelResponse,
  ModelToolCall,
} from "../model.js";

export interface KernelPrice {
  /** Same currency micros per million tokens as the rest of DevFlow. */
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  cachedInputMicrosPerMillionTokens?: number;
}

export interface KernelLimits {
  maxTurns: number;
  /** Hard cost ceiling; the next call is skipped when its worst case would exceed it. */
  maxCostMicros?: number;
  /** Absolute epoch milliseconds. */
  deadlineAt?: number;
  /** Older tool output is elided once the estimated prompt passes this many tokens. */
  maxInputTokens?: number;
}

export type KernelStopReason =
  "SUBMITTED" | "TURN_LIMIT" | "COST_LIMIT" | "DEADLINE" | "NO_ACTION" | "MODEL_ERROR";

export interface KernelUsage {
  modelCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costMicros: number;
  /** Worst-case cost of failed calls that may still have been billed; never counted as zero. */
  unconfirmedCostMicros: number;
}

export type KernelEvent =
  | { type: "model_request"; turn: number; worstCaseMicros: number }
  | { type: "model"; turn: number; response: ModelResponse; costMicros: number }
  | {
      type: "model_error";
      turn: number;
      message: string;
      willRetry: boolean;
      /** Worst case added to unconfirmed cost because the request may have been billed. */
      unconfirmedMicros: number;
    }
  | {
      type: "tool";
      turn: number;
      call: ModelToolCall;
      isError: boolean;
      durationMs: number;
      content: string;
    }
  | { type: "elided"; turn: number; messages: number };

export interface KernelResult {
  stopReason: KernelStopReason;
  summary?: string;
  turns: number;
  usage: KernelUsage;
  messages: ModelMessage[];
  error?: string;
}

/** A transcript and its metered usage, from a checkpoint or an earlier loop (may be empty). */
export interface KernelResume {
  messages: readonly ModelMessage[];
  usage: KernelUsage;
  turns: number;
}

export interface KernelOptions {
  model: LanguageModelPort;
  system: string;
  task: string;
  tools: readonly AciTool[];
  limits: KernelLimits;
  settings?: ModelGenerationSettings;
  price?: KernelPrice;
  signal: AbortSignal;
  onEvent?(event: KernelEvent): void | Promise<void>;
  /** Backoff before retrying a failed model call (default 2s, growing per attempt). */
  retryDelayMs?: number;
  /** Per-call timeout (default 4 minutes); a timed-out call is retried. */
  callTimeoutMs?: number;
  /**
   * Continue an earlier transcript instead of starting from system + task. Usage and turns
   * carry over, so limits apply to the whole conversation, not to each continuation.
   */
  resume?: KernelResume;
  /** Called after every turn's tool results are appended; used for durable checkpoints. */
  onTurnEnd?(state: KernelResume): void | Promise<void>;
}

const KEEP_RECENT_TOOL_RESULTS = 12;
const MAX_MODEL_RETRIES = 2;
const MAX_IDLE_REPLIES = 2;

/**
 * The v4 agent loop: the model chooses every action from general tools; the loop only
 * executes calls, meters cost and enforces hard limits. History is append-only so
 * provider prefix caches stay valid; old tool output is elided only near the window.
 */
export async function runAgentLoop(options: KernelOptions): Promise<KernelResult> {
  const { model, tools, limits, signal } = options;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const descriptors = tools.map(({ name, description, inputSchema, readOnly }) => ({
    name,
    description,
    inputSchema,
    readOnly,
  }));
  // An empty resumed transcript restarts the conversation but keeps usage and turns.
  const messages: ModelMessage[] = options.resume?.messages.length
    ? structuredClone([...options.resume.messages])
    : [
        { role: "SYSTEM", content: options.system },
        { role: "USER", content: options.task },
      ];
  const usage: KernelUsage = options.resume
    ? { ...options.resume.usage }
    : {
        modelCalls: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        costMicros: 0,
        unconfirmedCostMicros: 0,
      };
  const maxOutput = options.settings?.maxOutputTokens ?? 8192;
  let lastPromptTokens = 0;
  let lastPromptBytes = 0;
  let idleReplies = 0;
  let turn = options.resume?.turns ?? 0;
  const finish = (stopReason: KernelStopReason, extra: Partial<KernelResult> = {}) => ({
    stopReason,
    turns: turn,
    usage,
    messages,
    ...extra,
  });

  while (turn < limits.maxTurns) {
    signal.throwIfAborted();
    if (limits.deadlineAt !== undefined && Date.now() >= limits.deadlineAt)
      return finish("DEADLINE");
    // Estimate from the provider's last count plus the bytes appended since then.
    let promptTokens = estimatePrompt(messages, lastPromptTokens, lastPromptBytes);
    if (limits.maxInputTokens !== undefined && promptTokens > limits.maxInputTokens * 0.8) {
      const elided = elideOldToolResults(messages);
      if (elided > 0) {
        await options.onEvent?.({ type: "elided", turn, messages: elided });
        lastPromptTokens = 0;
        promptTokens = estimatePrompt(messages, 0, 0);
      }
    }
    const worstCase = options.price ? kernelCost(options.price, promptTokens, 0, maxOutput) : 0;
    const spent = () => usage.costMicros + usage.unconfirmedCostMicros;
    if (limits.maxCostMicros !== undefined && spent() + worstCase > limits.maxCostMicros)
      return finish("COST_LIMIT");
    turn += 1;
    await options.onEvent?.({ type: "model_request", turn, worstCaseMicros: worstCase });

    let response: ModelResponse | undefined;
    for (let attempt = 0; response === undefined; attempt++) {
      try {
        response = await model.generate(
          {
            messages: [...messages],
            tools: descriptors,
            ...(options.settings ? { settings: options.settings } : {}),
          },
          {
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(options.callTimeoutMs ?? 240_000),
            ]),
          },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        const unconfirmedMicros = notIssued(error) ? 0 : worstCase;
        usage.unconfirmedCostMicros += unconfirmedMicros;
        const message = error instanceof Error ? error.message : String(error);
        const willRetry =
          attempt < MAX_MODEL_RETRIES &&
          (limits.maxCostMicros === undefined || spent() + worstCase <= limits.maxCostMicros);
        await options.onEvent?.({
          type: "model_error",
          turn,
          message,
          willRetry,
          unconfirmedMicros,
        });
        if (!willRetry) return finish("MODEL_ERROR", { error: message });
        await new Promise((resolve) =>
          setTimeout(resolve, (options.retryDelayMs ?? 2000) * (attempt + 1)),
        );
      }
    }
    const callCost = options.price
      ? kernelCost(
          options.price,
          response.usage.inputTokens,
          response.usage.cachedInputTokens ?? 0,
          response.usage.outputTokens,
        )
      : 0;
    usage.modelCalls += 1;
    usage.inputTokens += response.usage.inputTokens;
    usage.cachedInputTokens += response.usage.cachedInputTokens ?? 0;
    usage.outputTokens += response.usage.outputTokens;
    usage.reasoningTokens += response.reasoningTokens ?? 0;
    usage.costMicros += callCost;
    lastPromptTokens = response.usage.inputTokens;
    lastPromptBytes = byteSize(messages);
    await options.onEvent?.({ type: "model", turn, response, costMicros: callCost });

    messages.push({
      role: "ASSISTANT",
      content: response.text ?? "",
      ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
    });

    if (response.toolCalls.length === 0) {
      idleReplies += 1;
      if (idleReplies > MAX_IDLE_REPLIES) return finish("NO_ACTION");
      messages.push({
        role: "USER",
        content:
          response.finishReason === "LENGTH"
            ? "Your reply hit the output limit before any tool call. Be brief and call a tool."
            : "Continue by calling a tool. When the fix is complete and verified, call submit.",
      });
      await options.onTurnEnd?.({ messages, usage: { ...usage }, turns: turn });
      continue;
    }
    idleReplies = 0;

    for (const [index, call] of response.toolCalls.entries()) {
      const started = Date.now();
      const tool = byName.get(call.name);
      const result = tool
        ? await tool.execute(call.input, signal)
        : {
            isError: true,
            content: `Unknown tool "${call.name}". Available tools: ${[...byName.keys()].join(", ")}.`,
          };
      const content = withBudgetNote(result.content, usage, limits, turn);
      messages.push({
        role: "TOOL",
        toolCallId: call.id,
        toolName: call.name,
        content,
        isError: result.isError ?? false,
      });
      await options.onEvent?.({
        type: "tool",
        turn,
        call,
        isError: result.isError ?? false,
        durationMs: Date.now() - started,
        content,
      });
      if ("submitted" in result && result.submitted) {
        // Calls after submit in the same reply are answered but not executed.
        for (const skipped of response.toolCalls.slice(index + 1))
          messages.push({
            role: "TOOL",
            toolCallId: skipped.id,
            toolName: skipped.name,
            content: "Not executed: the task was already submitted.",
            isError: true,
          });
        return finish("SUBMITTED", { summary: result.submitted.summary });
      }
    }
    await options.onTurnEnd?.({ messages, usage: { ...usage }, turns: turn });
  }
  return finish("TURN_LIMIT");
}

export function kernelCost(
  price: KernelPrice,
  input: number,
  cached: number,
  output: number,
): number {
  const hit = Math.min(Math.max(0, cached), input);
  const cachedRate = price.cachedInputMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens;
  return Math.ceil(
    ((input - hit) * price.inputMicrosPerMillionTokens +
      hit * cachedRate +
      output * price.outputMicrosPerMillionTokens) /
      1_000_000,
  );
}

/** Adapters mark validation failures that never reached the provider with requestIssued: false. */
function notIssued(error: unknown): boolean {
  const details = (error as { details?: { requestIssued?: unknown } } | undefined)?.details;
  return details?.requestIssued === false;
}

function byteSize(messages: readonly ModelMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages));
}

function estimatePrompt(
  messages: readonly ModelMessage[],
  lastPromptTokens: number,
  lastPromptBytes: number,
): number {
  const bytes = byteSize(messages);
  if (lastPromptTokens === 0) return Math.ceil(bytes / 3);
  return lastPromptTokens + Math.ceil(Math.max(0, bytes - lastPromptBytes) / 3);
}

/** Replaces all but the most recent tool outputs with a stub; returns how many changed. */
function elideOldToolResults(messages: ModelMessage[]): number {
  const toolIndexes = messages.flatMap((message, index) =>
    message.role === "TOOL" ? [index] : [],
  );
  let changed = 0;
  for (const index of toolIndexes.slice(0, -KEEP_RECENT_TOOL_RESULTS)) {
    const message = messages[index]!;
    if (message.role !== "TOOL" || typeof message.content !== "string") continue;
    if (message.content.length <= 400) continue;
    messages[index] = {
      ...message,
      content: `${message.content.slice(0, 300)}\n[older output elided to save context; rerun the tool if you need it]`,
    };
    changed += 1;
  }
  return changed;
}

function withBudgetNote(content: string, usage: KernelUsage, limits: KernelLimits, turn: number) {
  const notes: string[] = [];
  const turnsLeft = limits.maxTurns - turn;
  if (turnsLeft <= 5) notes.push(`${turnsLeft} turns left`);
  if (limits.maxCostMicros !== undefined && usage.costMicros > limits.maxCostMicros * 0.75)
    notes.push(
      `${Math.round((usage.costMicros / limits.maxCostMicros) * 100)}% of the cost budget used`,
    );
  if (limits.deadlineAt !== undefined) {
    const minutes = Math.floor((limits.deadlineAt - Date.now()) / 60_000);
    if (minutes <= 5) notes.push(`about ${Math.max(0, minutes)} minutes left`);
  }
  return notes.length
    ? `${content}\n\n[budget: ${notes.join(", ")} — finish your fix and submit soon]`
    : content;
}
