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
  /** The tool has no externally visible side effects. */
  readOnly?: boolean;
  /** Multiple calls to this tool may be executed concurrently. */
  parallelSafe?: boolean;
  /** A successful call changes the checked-out workspace. */
  mutatesWorkspace?: boolean;
}

export interface ModelStructuredOutputRequest {
  schema: z.ZodType;
  /** Defaults to `devflow_output` when omitted. */
  name?: string;
  description?: string;
}

export type ModelReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelGenerationSettings {
  reasoningEffort?: ModelReasoningEffort;
}

export interface ModelRequest {
  messages: readonly ModelMessage[];
  tools: readonly ModelToolDescriptor[];
  output?: ModelStructuredOutputRequest;
  settings?: ModelGenerationSettings;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type ModelStructuredOutputErrorCode = "EMPTY_OUTPUT" | "INVALID_JSON" | "SCHEMA_MISMATCH";

export interface ModelStructuredOutputIssue {
  path: string;
  message: string;
  code: string;
}

export type ModelStructuredOutputResult =
  | {
      status: "SUCCESS";
      rawTextHash: string;
      rawTextLength: number;
    }
  | {
      status: "ERROR";
      code: ModelStructuredOutputErrorCode;
      message: string;
      /** Kept in memory so the workflow can make one bounded format-repair call. */
      rawText?: string;
      rawTextHash?: string;
      rawTextLength: number;
      issues?: readonly ModelStructuredOutputIssue[];
    };

export interface ModelResponse {
  text?: string;
  output?: unknown;
  structuredOutput?: ModelStructuredOutputResult;
  toolCalls: readonly ModelToolCall[];
  finishReason: "STOP" | "TOOL_CALLS" | "LENGTH" | "CONTENT_FILTER" | "ERROR";
  usage: TokenUsage;
  reasoningTokens?: number;
  latencyMs: number;
}

export interface LanguageModelPort {
  generate(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelResponse>;
}
