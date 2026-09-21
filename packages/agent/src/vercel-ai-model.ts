import { createHash } from "node:crypto";

import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  dynamicTool,
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  type AssistantContent,
  type JSONValue,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage as AiModelMessage,
  type ToolSet,
} from "ai";

import type {
  LanguageModelPort,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStructuredOutputErrorCode,
  ModelStructuredOutputIssue,
} from "./model.js";

export type SupportedLlmProvider = "openai" | "openai-compatible";
export type StructuredOutputMode = "auto" | "json-schema" | "json-object";

export interface VercelAiModelConfig {
  provider: SupportedLlmProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  providerName?: string;
  parameters?: VercelAiModelParameters;
  structuredOutputMode?: StructuredOutputMode;
}

/**
 * Provider-independent generation parameters that a benchmark may pin for a
 * fair, repeatable comparison. They map directly to AI SDK call settings.
 */
export interface VercelAiModelParameters {
  temperature?: number;
  topP?: number;
  seed?: number;
  maxOutputTokens?: number;
}

export interface VercelAiModelAdapterOptions {
  /** Namespace used by AI SDK for provider-specific request settings. */
  providerOptionsName?: string;
  /** Only send reasoningEffort when the configured provider is known to accept it. */
  supportsReasoningEffort?: boolean;
}

export class VercelAiLanguageModel implements LanguageModelPort {
  constructor(
    private readonly model: LanguageModel,
    private readonly parameters: VercelAiModelParameters = {},
    private readonly adapterOptions: VercelAiModelAdapterOptions = {},
  ) {}

  async generate(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelResponse> {
    const startedAt = Date.now();
    const commonRequest = {
      model: this.model,
      messages: request.messages.map(toAiMessage),
      allowSystemInMessages: true,
      tools: toAiTools(request),
      ...this.parameters,
      ...toProviderOptions(
        request,
        this.adapterOptions.providerOptionsName,
        this.adapterOptions.supportsReasoningEffort !== false,
      ),
      maxRetries: 0,
      abortSignal: options.signal,
    };

    if (request.output === undefined) {
      const result = await generateText(commonRequest);
      return toModelResponse(result, startedAt);
    }

    try {
      const result = await generateText({
        ...commonRequest,
        output: Output.object({
          schema: request.output.schema,
          name: request.output.name ?? "devflow_output",
          ...(request.output.description === undefined
            ? {}
            : { description: request.output.description }),
        }),
      });

      try {
        const output: unknown = result.output;
        return toModelResponse(result, startedAt, {
          output,
          structuredOutput: {
            status: "SUCCESS",
            rawTextHash: hashText(result.text),
            rawTextLength: result.text.length,
          },
        });
      } catch (error) {
        if (!NoOutputGeneratedError.isInstance(error)) throw error;
        return toEmptyStructuredOutputResponse(result, startedAt);
      }
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        return toInvalidStructuredOutputResponse(error, startedAt);
      }
      if (NoOutputGeneratedError.isInstance(error)) {
        return emptyStructuredOutputResponse(startedAt);
      }
      throw error;
    }
  }
}

export function createConfiguredLanguageModel(config: VercelAiModelConfig): LanguageModelPort {
  if (config.provider === "openai") {
    const provider = createOpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl === undefined ? {} : { baseURL: config.baseUrl }),
    });
    return new VercelAiLanguageModel(provider(config.model), config.parameters, {
      providerOptionsName: "openai",
      supportsReasoningEffort: /^(?:o\d|gpt-[56])(?:[.-]|$)/iu.test(config.model.trim()),
    });
  }

  if (config.baseUrl === undefined || config.baseUrl.trim().length === 0) {
    throw new Error("LLM_BASE_URL is required when LLM_PROVIDER=openai-compatible.");
  }
  const providerName = config.providerName ?? "openai-compatible";
  const isBailian = isBailianCompatibleProvider(config);
  const structuredOutputMode = resolveStructuredOutputMode(config);
  const provider = createOpenAICompatible({
    name: providerName,
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    supportsStructuredOutputs: structuredOutputMode === "json-schema",
    ...(isBailian ? { transformRequestBody: transformBailianRequestBody } : {}),
  });
  return new VercelAiLanguageModel(provider.chatModel(config.model), config.parameters, {
    providerOptionsName: providerName,
    supportsReasoningEffort: isBailian && /^qwen3(?:[.-]|$)/iu.test(config.model.trim()),
  });
}

/**
 * Resolves the wire format conservatively. Unknown OpenAI-compatible providers
 * keep JSON-object mode and are still validated locally by Output.object().
 */
export function resolveStructuredOutputMode(
  config: Pick<
    VercelAiModelConfig,
    "provider" | "model" | "baseUrl" | "providerName" | "structuredOutputMode"
  >,
): Exclude<StructuredOutputMode, "auto"> {
  const configured = config.structuredOutputMode ?? "auto";
  if (configured !== "auto") return configured;
  if (config.provider === "openai") return "json-schema";
  return isBailianCompatibleProvider(config) && supportsBailianNativeStructuredOutput(config.model)
    ? "json-schema"
    : "json-object";
}

function toAiTools(request: ModelRequest): ToolSet {
  return Object.fromEntries(
    request.tools.map((descriptor) => [
      descriptor.name,
      dynamicTool({
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
      }),
    ]),
  );
}

function toProviderOptions(
  request: ModelRequest,
  providerOptionsName: string | undefined,
  supportsReasoningEffort: boolean,
): { providerOptions?: Record<string, Record<string, string>> } {
  const reasoningEffort = request.settings?.reasoningEffort;
  if (
    providerOptionsName === undefined ||
    reasoningEffort === undefined ||
    !supportsReasoningEffort
  ) {
    return {};
  }
  return {
    providerOptions: {
      [providerOptionsName]: { reasoningEffort },
    },
  };
}

function toAiMessage(message: ModelMessage): AiModelMessage {
  switch (message.role) {
    case "SYSTEM":
      return { role: "system", content: message.content };
    case "USER":
      return { role: "user", content: message.content };
    case "ASSISTANT": {
      const content: AssistantContent = [];
      if (message.content.length > 0) {
        content.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
        });
      }
      return { role: "assistant", content };
    }
    case "TOOL":
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: message.isError
              ? { type: "error-json", value: toJsonValue(message.content) }
              : { type: "json", value: toJsonValue(message.content) },
          },
        ],
      };
  }
}

function toJsonValue(value: unknown): JSONValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JSONValue;
  } catch {
    return String(value);
  }
}

interface GeneratedTextLike {
  readonly text: string;
  readonly toolCalls: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: unknown;
  }[];
  readonly finishReason: string;
  readonly usage: LanguageModelUsage;
}

function toModelResponse(
  result: GeneratedTextLike,
  startedAt: number,
  extra: Pick<ModelResponse, "output" | "structuredOutput"> = {},
): ModelResponse {
  const usage = toTokenUsage(result.usage);
  const reasoningTokens = result.usage.outputTokenDetails.reasoningTokens;
  return {
    ...(result.text.length > 0 ? { text: result.text } : {}),
    ...(extra.output === undefined ? {} : { output: extra.output }),
    ...(extra.structuredOutput === undefined ? {} : { structuredOutput: extra.structuredOutput }),
    toolCalls: result.toolCalls.map((call) => ({
      id: call.toolCallId,
      name: call.toolName,
      input: call.input,
    })),
    finishReason: mapFinishReason(result.finishReason),
    usage,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    latencyMs: Date.now() - startedAt,
  };
}

function toEmptyStructuredOutputResponse(
  result: GeneratedTextLike,
  startedAt: number,
): ModelResponse {
  return toModelResponse(result, startedAt, {
    structuredOutput: {
      status: "ERROR",
      code: "EMPTY_OUTPUT",
      message: "Model produced no structured output.",
      ...(result.text.length === 0
        ? {}
        : { rawText: result.text, rawTextHash: hashText(result.text) }),
      rawTextLength: result.text.length,
    },
  });
}

function emptyStructuredOutputResponse(startedAt: number): ModelResponse {
  return {
    toolCalls: [],
    finishReason: "ERROR",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    latencyMs: Date.now() - startedAt,
    structuredOutput: {
      status: "ERROR",
      code: "EMPTY_OUTPUT",
      message: "Model produced no structured output.",
      rawTextLength: 0,
    },
  };
}

function toInvalidStructuredOutputResponse(
  error: NoObjectGeneratedError,
  startedAt: number,
): ModelResponse {
  const rawText = error.text;
  const code = classifyStructuredOutputError(error);
  const issues = code === "SCHEMA_MISMATCH" ? extractValidationIssues(error.cause) : [];
  const usage = toTokenUsage(error.usage);
  const reasoningTokens = error.usage?.outputTokenDetails.reasoningTokens;
  return {
    ...(rawText === undefined || rawText.length === 0 ? {} : { text: rawText }),
    toolCalls: [],
    finishReason: mapFinishReason(error.finishReason ?? "error"),
    usage,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    latencyMs: Date.now() - startedAt,
    structuredOutput: {
      status: "ERROR",
      code,
      message: structuredOutputErrorMessage(code),
      ...(rawText === undefined || rawText.length === 0
        ? {}
        : { rawText, rawTextHash: hashText(rawText) }),
      rawTextLength: rawText?.length ?? 0,
      ...(issues.length === 0 ? {} : { issues }),
    },
  };
}

function toTokenUsage(usage: LanguageModelUsage | undefined): ModelResponse["usage"] {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const reasoningTokens = usage?.outputTokenDetails.reasoningTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function classifyStructuredOutputError(
  error: NoObjectGeneratedError,
): ModelStructuredOutputErrorCode {
  if (error.text === undefined || error.text.trim().length === 0) return "EMPTY_OUTPUT";
  const errorNames = collectCauseNames(error.cause);
  if (errorNames.has("AI_TypeValidationError") || error.message.includes("did not match schema")) {
    return "SCHEMA_MISMATCH";
  }
  return "INVALID_JSON";
}

function collectCauseNames(value: unknown): Set<string> {
  const names = new Set<string>();
  const seen = new Set<unknown>();
  let current: unknown = value;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.name === "string") names.add(record.name);
    current = record.cause;
  }
  return names;
}

function extractValidationIssues(value: unknown): ModelStructuredOutputIssue[] {
  const seen = new Set<unknown>();
  let current: unknown = value;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (Array.isArray(record.issues)) {
      return record.issues.flatMap((issue): ModelStructuredOutputIssue[] => {
        if (issue === null || typeof issue !== "object") return [];
        const issueRecord = issue as Record<string, unknown>;
        if (typeof issueRecord.message !== "string") return [];
        const path = Array.isArray(issueRecord.path) ? issueRecord.path.map(String).join(".") : "";
        return [
          {
            path,
            message: issueRecord.message.slice(0, 1_000),
            code: typeof issueRecord.code === "string" ? issueRecord.code : "custom",
          },
        ];
      });
    }
    current = record.cause;
  }
  return [];
}

function structuredOutputErrorMessage(code: ModelStructuredOutputErrorCode): string {
  switch (code) {
    case "EMPTY_OUTPUT":
      return "Model produced no structured output.";
    case "INVALID_JSON":
      return "Structured output was not valid JSON.";
    case "SCHEMA_MISMATCH":
      return "Structured output did not match the requested schema.";
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isBailianCompatibleProvider(
  config: Pick<VercelAiModelConfig, "baseUrl" | "providerName">,
): boolean {
  const providerName = config.providerName?.toLowerCase() ?? "";
  if (["bailian", "dashscope", "aliyun", "alibaba"].some((name) => providerName.includes(name))) {
    return true;
  }
  if (config.baseUrl === undefined) return false;
  try {
    const hostname = new URL(config.baseUrl).hostname.toLowerCase();
    return (
      /^dashscope(?:-[a-z0-9]+)?\.aliyuncs\.com$/.test(hostname) ||
      hostname.endsWith(".dashscope.aliyuncs.com")
    );
  } catch {
    return config.baseUrl.toLowerCase().includes("dashscope.aliyuncs.com");
  }
}

function supportsBailianNativeStructuredOutput(model: string): boolean {
  return /^qwen3[.-](?:8|7)(?:[.-]|$)/i.test(model.trim());
}

function transformBailianRequestBody(args: Record<string, unknown>): Record<string, unknown> {
  if (args.response_format === undefined) return args;
  const { reasoning_effort: _reasoningEffort, ...withoutReasoningEffort } = args;
  return { ...withoutReasoningEffort, enable_thinking: false };
}

function mapFinishReason(reason: string): ModelResponse["finishReason"] {
  switch (reason) {
    case "stop":
      return "STOP";
    case "tool-calls":
      return "TOOL_CALLS";
    case "length":
      return "LENGTH";
    case "content-filter":
      return "CONTENT_FILTER";
    default:
      return "ERROR";
  }
}
