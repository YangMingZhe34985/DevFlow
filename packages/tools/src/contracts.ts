import type { SandboxSession } from "@devflow/sandbox";
import type { DevflowErrorShape, NewAgentEvent, RunId, StepId, ToolCallId } from "@devflow/shared";
import type { z } from "zod";

export type ToolPermission = "READ" | "WRITE" | "EXECUTE" | "GIT";

export interface ToolContext {
  runId: RunId;
  stepId: StepId;
  sandbox: SandboxSession;
  signal: AbortSignal;
  emit(event: NewAgentEvent): Promise<void>;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly permission: ToolPermission;
  readonly timeoutMs: number;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  permission: ToolPermission;
  timeoutMs: number;
}

export interface ToolExecutionRequest {
  callId?: ToolCallId;
  name: string;
  input: unknown;
}

export type ToolExecutionResult =
  | { ok: true; output: unknown; durationMs: number }
  | {
      ok: false;
      error: DevflowErrorShape;
      durationMs: number;
    };

export interface ToolExecutor {
  execute(request: ToolExecutionRequest, context: ToolContext): Promise<ToolExecutionResult>;
}
