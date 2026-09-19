import { randomUUID } from "node:crypto";

import { DevflowError, type NewAgentEvent } from "@devflow/shared";
import { describe, expect, it } from "vitest";

import {
  DefaultAgentRuntime,
  createInitialAgentState,
  FakeLanguageModel,
  fakeModelResponse,
  InMemoryAgentStateStore,
  type AgentStateStore,
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
});
