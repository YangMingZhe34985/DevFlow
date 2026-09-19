import { randomUUID } from "node:crypto";

import { DevflowError, toDevflowError, type JsonValue } from "@devflow/shared";

import type {
  ToolContext,
  ToolDefinition,
  ToolDescriptor,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "./contracts.js";
import type { ToolPolicy, ToolPolicyDecision } from "./policy.js";
import type { ToolRegistry } from "./registry.js";

export class UnimplementedToolExecutor implements ToolExecutor {
  async execute(
    _request: ToolExecutionRequest,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    throw new DevflowError({
      code: "NOT_IMPLEMENTED",
      message:
        "Tool execution is not implemented. The agent cannot bypass the ToolExecutor boundary.",
    });
  }
}

export class DefaultToolExecutor implements ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly policy: ToolPolicy,
  ) {}

  async execute(request: ToolExecutionRequest, context: ToolContext): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    const eventToolCallId = randomUUID();
    const tool = this.registry.get(request.name);
    if (tool === undefined) {
      await context.emit({
        runId: context.runId,
        stepId: context.stepId,
        toolCallId: eventToolCallId,
        type: "TOOL_CALL",
        occurredAt: new Date().toISOString(),
        payload: {
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          name: request.name,
          permission: null,
          input: asJson(request.input),
        },
      });
      const result = failure(
        new DevflowError({
          code: "NOT_FOUND",
          message: `Unknown tool '${request.name}'.`,
        }),
        startedAt,
      );
      await emitResult(context, eventToolCallId, request.name, result);
      return result;
    }

    const descriptor = describe(tool);
    await context.emit({
      runId: context.runId,
      stepId: context.stepId,
      toolCallId: eventToolCallId,
      type: "TOOL_CALL",
      occurredAt: new Date().toISOString(),
      payload: {
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        name: tool.name,
        permission: tool.permission,
        input: asJson(request.input),
      },
    });

    let decision: ToolPolicyDecision;
    try {
      decision = await this.policy.evaluate(descriptor, request, {
        runId: context.runId,
        stepId: context.stepId,
      });
    } catch (error) {
      const result = failure(
        toDevflowError(error, {
          code: "TOOL_FAILED",
          message: `Policy evaluation failed for tool '${tool.name}'.`,
        }),
        startedAt,
      );
      await emitResult(context, eventToolCallId, tool.name, result);
      return result;
    }
    if (decision.decision !== "ALLOW") {
      const error = new DevflowError({
        code: decision.decision === "REQUIRE_APPROVAL" ? "APPROVAL_REQUIRED" : "PERMISSION_DENIED",
        message: decision.reason,
      });
      if (decision.decision === "REQUIRE_APPROVAL") {
        await context.emit({
          runId: context.runId,
          stepId: context.stepId,
          toolCallId: eventToolCallId,
          type: "APPROVAL_REQUIRED",
          occurredAt: new Date().toISOString(),
          payload: { name: tool.name, reason: decision.reason },
        });
      }
      const result = failure(error, startedAt);
      await emitResult(context, eventToolCallId, tool.name, result);
      return result;
    }

    const parsedInput = tool.inputSchema.safeParse(request.input);
    if (!parsedInput.success) {
      const result = failure(
        new DevflowError({
          code: "VALIDATION_ERROR",
          message: `Invalid input for tool '${tool.name}'.`,
          details: parsedInput.error.flatten(),
        }),
        startedAt,
      );
      await emitResult(context, eventToolCallId, tool.name, result);
      return result;
    }

    const timeoutSignal = AbortSignal.timeout(tool.timeoutMs);
    const signal = AbortSignal.any([context.signal, timeoutSignal]);
    try {
      if (signal.aborted) throw signal.reason;
      const output = await raceWithAbort(
        tool.execute(parsedInput.data, { ...context, signal }),
        signal,
      );
      const parsedOutput = tool.outputSchema.safeParse(output);
      if (!parsedOutput.success) {
        throw new DevflowError({
          code: "TOOL_FAILED",
          message: `Tool '${tool.name}' returned an invalid result.`,
          details: parsedOutput.error.flatten(),
        });
      }
      const result: ToolExecutionResult = {
        ok: true,
        output: parsedOutput.data,
        durationMs: elapsed(startedAt),
      };
      await emitResult(context, eventToolCallId, tool.name, result);
      return result;
    } catch (error) {
      const normalized = context.signal.aborted
        ? new DevflowError({ code: "CANCELLED", message: `Tool '${tool.name}' was cancelled.` })
        : timeoutSignal.aborted
          ? new DevflowError({ code: "TIMEOUT", message: `Tool '${tool.name}' timed out.` })
          : toDevflowError(error, {
              code: "TOOL_FAILED",
              message: `Tool '${tool.name}' failed.`,
            });
      const result = failure(normalized, startedAt);
      await emitResult(context, eventToolCallId, tool.name, result);
      return result;
    }
  }
}

function describe(tool: ToolDefinition): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    permission: tool.permission,
    timeoutMs: tool.timeoutMs,
  };
}

async function emitResult(
  context: ToolContext,
  toolCallId: string,
  name: string,
  result: ToolExecutionResult,
): Promise<void> {
  await context.emit({
    runId: context.runId,
    stepId: context.stepId,
    toolCallId,
    type: "TOOL_RESULT",
    ...(result.ok ? {} : { level: "ERROR" as const }),
    occurredAt: new Date().toISOString(),
    payload: result.ok
      ? { name, ok: true, durationMs: result.durationMs, output: asJson(result.output) }
      : { name, ok: false, durationMs: result.durationMs, error: asJson(result.error) },
  });
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function failure(error: DevflowError, startedAt: number): ToolExecutionResult {
  return { ok: false, error: error.toJSON(), durationMs: elapsed(startedAt) };
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function asJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}
