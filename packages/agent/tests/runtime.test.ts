import { randomUUID } from "node:crypto";

import { DevflowError, type NewAgentEvent } from "@devflow/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DefaultAgentRuntime,
  createInitialAgentState,
  FakeLanguageModel,
  fakeModelResponse,
  InMemoryAgentStateStore,
  projectModelMessages,
  type AgentStateStore,
  type ModelMessage,
  type RunContext,
} from "../src/index.js";

function createContext(
  signal: AbortSignal,
  stateStore?: AgentStateStore,
): {
  context: RunContext;
  events: NewAgentEvent[];
} {
  const events: NewAgentEvent[] = [];
  const runId = randomUUID();
  return {
    events,
    context: {
      runId,
      task: {
        taskId: randomUUID(),
        repositoryId: randomUUID(),
        title: "Fix the calculator",
        description: "Inspect the failure, fix it and run tests.",
      },
      signal,
      tools: [],
      ...(stateStore === undefined ? {} : { stateStore }),
      async emit(event) {
        events.push(event);
      },
      async executeTool(_stepId, request) {
        return { ok: true, output: { echoed: request.input }, durationMs: 1 };
      },
    },
  };
}

describe("DefaultAgentRuntime", () => {
  it("feeds a tool result back to the model and completes", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: "call-1", name: "readFile", input: { path: "src/a.js" } }],
      }),
      async (request) => {
        expect(request.messages.at(-1)).toMatchObject({
          role: "TOOL",
          toolCallId: "call-1",
          toolName: "readFile",
          isError: false,
        });
        return fakeModelResponse({ toolCalls: [], text: "Tests pass." });
      },
    ]);
    const { context, events } = createContext(new AbortController().signal);

    const result = await new DefaultAgentRuntime(model).run(
      { maxSteps: 5, timeoutMs: 1_000, maxRetries: 0 },
      context,
    );

    expect(result).toMatchObject({ status: "SUCCEEDED", summary: "Tests pass." });
    expect(result.metrics).toMatchObject({ steps: 2, toolCalls: 1 });
    expect(model.requests).toHaveLength(2);
    expect(events.some(({ type }) => type === "RUN_COMPLETED")).toBe(true);
  });

  it("fails gracefully when maxSteps is reached", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: "call-1", name: "readFile", input: { path: "a" } }],
      }),
    ]);
    const { context } = createContext(new AbortController().signal);

    const result = await new DefaultAgentRuntime(model).run(
      { maxSteps: 1, timeoutMs: 1_000, maxRetries: 0 },
      context,
    );

    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("MAX_STEPS_EXCEEDED");
  });

  it("enforces the total deadline", async () => {
    const model = new FakeLanguageModel([
      async (_request, { signal }) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    ]);
    const { context } = createContext(new AbortController().signal);

    const result = await new DefaultAgentRuntime(model).run(
      { maxSteps: 2, timeoutMs: 20, maxRetries: 0 },
      context,
    );

    expect(result.status).toBe("TIMED_OUT");
    expect(result.error?.code).toBe("TIMEOUT");
  });

  it("propagates caller cancellation", async () => {
    const cancellation = new AbortController();
    cancellation.abort();
    const model = new FakeLanguageModel([]);
    const store = new InMemoryAgentStateStore();
    const { context } = createContext(cancellation.signal, store);

    const result = await new DefaultAgentRuntime(model).run(
      { maxSteps: 2, timeoutMs: 1_000, maxRetries: 0 },
      context,
    );

    expect(result.status).toBe("CANCELLED");
    expect(result.error?.code).toBe("CANCELLED");
    expect(await store.load(context.runId)).toMatchObject({ phase: "CANCELLED" });
  });

  it("records retries, tokens, model latency and tool latency", async () => {
    const store = new InMemoryAgentStateStore();
    const model = new FakeLanguageModel([
      async () => {
        throw new DevflowError({
          code: "LLM_FAILED",
          message: "temporary provider failure",
          retryable: true,
        });
      },
      fakeModelResponse({
        toolCalls: [{ id: "call-1", name: "readFile", input: { path: "a" } }],
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        latencyMs: 11,
      }),
      fakeModelResponse({
        toolCalls: [],
        text: "done",
        usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
        latencyMs: 7,
      }),
    ]);
    const { context } = createContext(new AbortController().signal, store);
    context.executeTool = async () => ({ ok: true, output: { content: "a" }, durationMs: 5 });

    const result = await new DefaultAgentRuntime(model).run(
      { maxSteps: 3, timeoutMs: 1_000, maxRetries: 1 },
      context,
    );
    const state = await store.load(context.runId);

    expect(result.metrics).toMatchObject({
      steps: 2,
      modelCalls: 3,
      toolCalls: 1,
      retries: 1,
      toolLatencyMs: 5,
      tokenUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
    expect(result.metrics.modelLatencyMs).toBeGreaterThanOrEqual(18);
    expect(state).toMatchObject({
      phase: "COMPLETED",
      stepCount: 2,
      finalResult: { status: "SUCCEEDED" },
    });
  });

  it("restores a terminal result without calling the model again", async () => {
    const store = new InMemoryAgentStateStore();
    const firstModel = new FakeLanguageModel([
      fakeModelResponse({ toolCalls: [], text: "persisted result" }),
    ]);
    const first = createContext(new AbortController().signal, store);
    const firstResult = await new DefaultAgentRuntime(firstModel).run(
      { maxSteps: 2, timeoutMs: 1_000, maxRetries: 0 },
      first.context,
    );
    const secondModel = new FakeLanguageModel([]);
    const secondContext = { ...first.context, signal: new AbortController().signal };

    const restored = await new DefaultAgentRuntime(secondModel).run(
      { maxSteps: 2, timeoutMs: 1_000, maxRetries: 0 },
      secondContext,
    );

    expect(restored).toEqual(firstResult);
    expect(secondModel.requests).toHaveLength(0);
  });

  it("continues from a non-terminal serialized checkpoint", async () => {
    const store = new InMemoryAgentStateStore();
    const { context } = createContext(new AbortController().signal, store);
    const checkpoint = createInitialAgentState(context.runId, [
      { role: "SYSTEM", content: "system" },
      { role: "USER", content: "task" },
      {
        role: "TOOL",
        toolCallId: "previous-call",
        toolName: "readFile",
        content: { content: "previous result" },
        isError: false,
      },
    ]);
    await store.save({ ...checkpoint, phase: "THINKING", stepCount: 1 });
    const model = new FakeLanguageModel([
      fakeModelResponse({ toolCalls: [], text: "resumed successfully" }),
    ]);

    const result = await new DefaultAgentRuntime(model).run(
      { maxSteps: 3, timeoutMs: 1_000, maxRetries: 0 },
      context,
    );

    expect(result).toMatchObject({
      status: "SUCCEEDED",
      summary: "resumed successfully",
      metrics: { steps: 2, modelCalls: 1 },
    });
    expect(model.requests[0]?.messages.at(-1)).toMatchObject({
      role: "TOOL",
      toolCallId: "previous-call",
    });
  });

  it("caches unchanged reads, warns once, then fails a repeated no-progress loop", async () => {
    const calls = ["call-1", "call-2", "call-3"].map((id) =>
      fakeModelResponse({ toolCalls: [{ id, name: "readFile", input: { path: "src/a.ts" } }] }),
    );
    const model = new FakeLanguageModel([
      calls[0]!,
      calls[1]!,
      async (request) => {
        expect(request.messages.at(-1)).toMatchObject({
          role: "USER",
          content: expect.stringContaining("Convergence warning"),
        });
        return calls[2]!;
      },
    ]);
    const { context } = createContext(new AbortController().signal);
    let executions = 0;
    context.executeTool = async () => {
      executions += 1;
      return { ok: true, output: { content: "same" }, durationMs: 3 };
    };

    const result = await new DefaultAgentRuntime(model).run(
      { maxSteps: 4, timeoutMs: 1_000, maxRetries: 0 },
      context,
    );

    expect(result).toMatchObject({
      status: "FAILED",
      error: { code: "AGENT_STALLED" },
      metrics: { steps: 3, modelCalls: 3, toolCalls: 3, toolLatencyMs: 3 },
    });
    expect(executions).toBe(1);
  });

  it("invalidates the read cache after a successful workspace mutation", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: "read-1", name: "readFile", input: { path: "src/a.ts" } }],
      }),
      fakeModelResponse({
        toolCalls: [
          { id: "write", name: "writeFile", input: { path: "src/a.ts", content: "changed" } },
        ],
      }),
      fakeModelResponse({
        toolCalls: [{ id: "read-2", name: "readFile", input: { path: "src/a.ts" } }],
      }),
      fakeModelResponse({ toolCalls: [], text: "done" }),
    ]);
    const { context } = createContext(new AbortController().signal);
    const executedNames: string[] = [];
    context.executeTool = async (_stepId, request) => {
      executedNames.push(request.name);
      return { ok: true, output: { name: request.name }, durationMs: 1 };
    };

    const result = await new DefaultAgentRuntime(model).run(
      { maxSteps: 5, timeoutMs: 1_000, maxRetries: 0 },
      context,
    );

    expect(result.status).toBe("SUCCEEDED");
    expect(executedNames).toEqual(["readFile", "writeFile", "readFile"]);
  });

  it("executes parallel-safe reads with concurrency four and preserves result order", async () => {
    const toolCalls = Array.from({ length: 6 }, (_, index) => ({
      id: `read-${String(index)}`,
      name: "readFile",
      input: { path: `src/${String(index)}.ts` },
    }));
    const model = new FakeLanguageModel([
      fakeModelResponse({ toolCalls }),
      async (request) => {
        expect(
          request.messages
            .filter((message) => message.role === "TOOL")
            .map((message) => (message.role === "TOOL" ? message.toolCallId : "")),
        ).toEqual(toolCalls.map(({ id }) => id));
        return fakeModelResponse({ toolCalls: [], text: "parallel reads complete" });
      },
    ]);
    const { context } = createContext(new AbortController().signal);
    let active = 0;
    let peak = 0;
    context.executeTool = async (_stepId, request) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { ok: true, output: { input: request.input }, durationMs: 10 };
    };

    const result = await new DefaultAgentRuntime(model).run(
      { maxSteps: 3, timeoutMs: 2_000, maxRetries: 0 },
      context,
    );

    expect(result.status).toBe("SUCCEEDED");
    expect(peak).toBe(4);
  });

  it("completes in the same model step when finishPhase is last and earlier tools succeed", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [
          { id: "write", name: "writeFile", input: { path: "src/a.ts", content: "fixed" } },
          { id: "finish", name: "finishPhase", input: { summary: "Implemented the fix." } },
        ],
      }),
    ]);
    const { context } = createContext(new AbortController().signal);
    let executions = 0;
    context.executeTool = async () => {
      executions += 1;
      return { ok: true, output: { written: true }, durationMs: 2 };
    };

    const result = await new DefaultAgentRuntime(model).run(
      { maxSteps: 2, timeoutMs: 1_000, maxRetries: 0 },
      context,
    );

    expect(result).toMatchObject({
      status: "SUCCEEDED",
      summary: "Implemented the fix.",
      metrics: { steps: 1, modelCalls: 1, toolCalls: 2, toolLatencyMs: 2 },
    });
    expect(executions).toBe(1);
  });

  it("ignores finishPhase after a failed tool and continues to the next model step", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [
          { id: "write", name: "writeFile", input: { path: "src/a.ts", content: "fixed" } },
          { id: "finish", name: "finishPhase", input: { summary: "not yet" } },
        ],
      }),
      fakeModelResponse({ toolCalls: [], text: "recovered" }),
    ]);
    const { context } = createContext(new AbortController().signal);
    context.executeTool = async () => ({
      ok: false,
      error: { code: "TOOL_FAILED", message: "write failed", retryable: false },
      durationMs: 1,
    });

    const result = await new DefaultAgentRuntime(model).run(
      { maxSteps: 3, timeoutMs: 1_000, maxRetries: 0 },
      context,
    );

    expect(result).toMatchObject({ status: "SUCCEEDED", summary: "recovered" });
    expect(model.requests).toHaveLength(2);
  });

  it("validates finishPhase against its descriptor without invoking the tool executor", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: "finish", name: "finishPhase", input: { summary: "missing outcome" } }],
      }),
      async (request) => {
        expect(request.messages.at(-1)).toMatchObject({
          role: "TOOL",
          toolName: "finishPhase",
          isError: true,
        });
        return fakeModelResponse({ toolCalls: [], text: "corrected" });
      },
    ]);
    const { context } = createContext(new AbortController().signal);
    context.tools = [
      {
        name: "finishPhase",
        description: "finish",
        inputSchema: z.object({
          summary: z.string().min(1),
          outcome: z.enum(["CHANGED", "ALREADY_SATISFIED"]),
        }),
        readOnly: true,
        parallelSafe: false,
        mutatesWorkspace: false,
      },
    ];
    let executions = 0;
    context.executeTool = async () => {
      executions += 1;
      return { ok: true, output: {}, durationMs: 1 };
    };

    const result = await new DefaultAgentRuntime(model).run(
      { maxSteps: 2, timeoutMs: 1_000, maxRetries: 0 },
      context,
    );

    expect(result).toMatchObject({ status: "SUCCEEDED", summary: "corrected" });
    expect(executions).toBe(0);
  });

  it("projects only the latest interactions into a bounded model context", () => {
    const huge = "x".repeat(100 * 1_024);
    const messages: ModelMessage[] = [
      { role: "SYSTEM", content: huge },
      { role: "USER", content: huge },
      ...["old", "middle", "latest"].flatMap((id): ModelMessage[] => [
        {
          role: "ASSISTANT",
          content: huge,
          toolCalls: [{ id, name: "readFile", input: { path: id, padding: huge } }],
        },
        {
          role: "TOOL",
          toolCallId: id,
          toolName: "readFile",
          content: { content: huge },
          isError: false,
        },
      ]),
    ];

    const projected = projectModelMessages(messages);
    const serialized = JSON.stringify(projected);

    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(192 * 1_024);
    expect(serialized).not.toContain('"id":"old"');
    expect(serialized).toContain('"id":"middle"');
    expect(serialized).toContain('"id":"latest"');
    expect(serialized).toContain('"truncated":true');
  });

  it("passes per-phase model settings through on every request", async () => {
    const model = new FakeLanguageModel([
      async (request) => {
        expect(request).toMatchObject({ settings: { reasoningEffort: "low" } });
        return fakeModelResponse({ toolCalls: [], text: "done" });
      },
    ]);
    const { context } = createContext(new AbortController().signal);

    const result = await new DefaultAgentRuntime(model).run(
      {
        maxSteps: 1,
        timeoutMs: 1_000,
        maxRetries: 0,
        modelSettings: { reasoningEffort: "low" },
      },
      context,
    );

    expect(result.status).toBe("SUCCEEDED");
  });
});
