import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  dynamicTool,
  generateText,
  type AssistantContent,
  type JSONValue,
  type LanguageModel,
  type ModelMessage as AiModelMessage,
  type ToolSet,
} from "ai";

import type { LanguageModelPort, ModelMessage, ModelRequest, ModelResponse } from "./model.js";

export type SupportedLlmProvider = "openai" | "openai-compatible";

export interface VercelAiModelConfig {
  provider: SupportedLlmProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  providerName?: string;
}

export class VercelAiLanguageModel implements LanguageModelPort {
  constructor(private readonly model: LanguageModel) {}

  async generate(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelResponse> {
    const startedAt = Date.now();
    const result = await generateText({
      model: this.model,
      messages: request.messages.map(toAiMessage),
      allowSystemInMessages: true,
      tools: toAiTools(request),
      maxRetries: 0,
      abortSignal: options.signal,
    });
    const inputTokens = result.usage.inputTokens ?? 0;
    const outputTokens = result.usage.outputTokens ?? 0;

    return {
      ...(result.text.length > 0 ? { text: result.text } : {}),
      toolCalls: result.toolCalls.map((call) => ({
        id: call.toolCallId,
        name: call.toolName,
        input: call.input,
      })),
      finishReason: mapFinishReason(result.finishReason),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: result.usage.totalTokens ?? inputTokens + outputTokens,
      },
      latencyMs: Date.now() - startedAt,
    };
  }
}

export function createConfiguredLanguageModel(config: VercelAiModelConfig): LanguageModelPort {
  if (config.provider === "openai") {
    const provider = createOpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl === undefined ? {} : { baseURL: config.baseUrl }),
    });
    return new VercelAiLanguageModel(provider(config.model));
  }

  if (config.baseUrl === undefined || config.baseUrl.trim().length === 0) {
    throw new Error("LLM_BASE_URL is required when LLM_PROVIDER=openai-compatible.");
  }
  const provider = createOpenAICompatible({
    name: config.providerName ?? "openai-compatible",
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });
  return new VercelAiLanguageModel(provider.chatModel(config.model));
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
