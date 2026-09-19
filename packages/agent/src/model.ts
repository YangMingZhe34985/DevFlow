import type { TokenUsage } from "@devflow/shared";
import type { z } from "zod";

export type ModelMessageRole = "SYSTEM" | "USER" | "ASSISTANT" | "TOOL";

export type ModelMessage =
  | { role: "SYSTEM" | "USER"; content: string }
  | {
      role: "ASSISTANT";
      content: string;
      toolCalls?: readonly ModelToolCall[];
    }
  | {
      role: "TOOL";
      content: unknown;
      toolCallId: string;
      toolName: string;
      isError: boolean;
    };

export interface ModelToolDescriptor {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export interface ModelRequest {
  messages: readonly ModelMessage[];
  tools: readonly ModelToolDescriptor[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelResponse {
  text?: string;
  toolCalls: readonly ModelToolCall[];
  finishReason: "STOP" | "TOOL_CALLS" | "LENGTH" | "CONTENT_FILTER" | "ERROR";
  usage: TokenUsage;
  latencyMs: number;
}

export interface LanguageModelPort {
  generate(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelResponse>;
}
