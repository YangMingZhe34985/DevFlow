import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSubmitTool, defineAciTool, type AciTool } from "@devflow/tools";

import { FakeLanguageModel, fakeModelResponse } from "../src/fake-model.js";
import { runAgentLoop, type KernelEvent } from "../src/kernel/loop.js";
import type { ModelMessage } from "../src/model.js";

const signal = () => new AbortController().signal;
const usage = (inputTokens: number, outputTokens = 10, cachedInputTokens?: number) => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
});

function echoTool(log: string[] = []): AciTool {
  return defineAciTool({
    name: "echo",
    description: "Echo text.",
    inputSchema: z.object({ text: z.string() }),
    readOnly: true,
    async run({ text }) {
      log.push(text);
      return { content: `echo: ${text}` };
    },
  });
}

const call = (id: string, name: string, input: unknown) => ({ id, name, input });
const toolMessages = (messages: readonly ModelMessage[]) =>
  messages.filter((m): m is Extract<ModelMessage, { role: "TOOL" }> => m.role === "TOOL");

describe("runAgentLoop", () => {
  it("cancels a tool at the Run deadline and does not execute later calls", async () => {
    const log: string[] = [];
    const slow = defineAciTool({
      name: "slow",
      description: "Wait for cancellation.",
      inputSchema: z.object({}),
      readOnly: true,
      async run(_input, signal) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        signal.throwIfAborted();
        return { content: "unreachable" };
      },
    });
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [call("1", "slow", {}), call("2", "echo", { text: "late action" })],
      }),
    ]);
    const result = await runAgentLoop({
      model,
      system: "s",
      task: "t",
      tools: [slow, echoTool(log)],
      limits: { maxTurns: 3, deadlineAt: Date.now() + 50 },
      signal: signal(),
    });
    expect(result.stopReason).toBe("DEADLINE");
    expect(model.requests).toHaveLength(1);
    expect(log).toEqual([]);
    expect(toolMessages(result.messages)[0]?.content).toContain("Run deadline");
  });
  it("bounds an in-flight model call by the Run deadline without dispatching a retry", async () => {
    const model = new FakeLanguageModel([
      async (_request, options) => {
        await new Promise((resolve) =>
          options.signal.addEventListener("abort", resolve, { once: true }),
        );
        throw new Error("deadline timeout");
      },
    ]);
    const events: KernelEvent[] = [];
    const result = await runAgentLoop({
      model,
      system: "s",
      task: "t",
      tools: [createSubmitTool()],
      limits: { maxTurns: 3, deadlineAt: Date.now() + 50 },
      signal: signal(),
      price: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 0 },
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result.stopReason).toBe("DEADLINE");
    expect(model.requests).toHaveLength(1);
    expect(events.find((event) => event.type === "model_error")).toMatchObject({
      willRetry: false,
    });
    expect(result.usage.unconfirmedCostMicros).toBeGreaterThan(0);
  });
  it("runs model-chosen tools in order and stops on submit with metered usage", async () => {
    const log: string[] = [];
    const model = new FakeLanguageModel([
      fakeModelResponse({ toolCalls: [call("1", "echo", { text: "a" })], usage: usage(1000) }),
      fakeModelResponse({
        toolCalls: [call("2", "echo", { text: "b" }), call("3", "submit", { summary: "done" })],
        usage: usage(2000, 20, 1500),
      }),
    ]);
    const result = await runAgentLoop({
      model,
      system: "sys",
      task: "task",
      tools: [echoTool(log), createSubmitTool()],
      limits: { maxTurns: 10 },
      price: {
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 4_000_000,
        cachedInputMicrosPerMillionTokens: 100_000,
      },
      signal: signal(),
    });
    expect(result).toMatchObject({ stopReason: "SUBMITTED", summary: "done", turns: 2 });
    expect(log).toEqual(["a", "b"]);
    expect(result.usage).toMatchObject({
      modelCalls: 2,
      inputTokens: 3000,
      cachedInputTokens: 1500,
      outputTokens: 30,
    });
    // (1000 + 40) + (500 + 150 + 80) micros
    expect(result.usage.costMicros).toBe(1770);
    // The second request carried the first tool result; history is append-only.
    expect(model.requests[1]!.messages.slice(0, model.requests[0]!.messages.length)).toEqual(
      model.requests[0]!.messages,
    );
  });

  it("returns unknown tools and invalid arguments to the model instead of stopping", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [call("1", "grep", { q: "x" }), call("2", "echo", { text: 3 })],
      }),
      fakeModelResponse({ toolCalls: [call("3", "submit", { summary: "ok" })] }),
    ]);
    const result = await runAgentLoop({
      model,
      system: "s",
      task: "t",
      tools: [echoTool(), createSubmitTool()],
      limits: { maxTurns: 5 },
      signal: signal(),
    });
    expect(result.stopReason).toBe("SUBMITTED");
    const [unknown, invalid] = toolMessages(result.messages);
    expect(unknown).toMatchObject({ isError: true });
    expect(String(unknown!.content)).toContain('Unknown tool "grep"');
    expect(String(invalid!.content)).toContain("Invalid arguments for echo");
  });

  it("nudges text-only replies and stops after repeated inaction", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({ toolCalls: [], text: "thinking" }),
      fakeModelResponse({ toolCalls: [], text: "still thinking" }),
      fakeModelResponse({ toolCalls: [], text: "done?" }),
    ]);
    const result = await runAgentLoop({
      model,
      system: "s",
      task: "t",
      tools: [createSubmitTool()],
      limits: { maxTurns: 10 },
      signal: signal(),
    });
    expect(result.stopReason).toBe("NO_ACTION");
    expect(result.messages.filter((m) => m.role === "USER")).toHaveLength(3);
  });

  it("refuses a call whose worst-case cost would exceed the ceiling", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({ toolCalls: [call("1", "echo", { text: "a" })], usage: usage(900) }),
    ]);
    const result = await runAgentLoop({
      model,
      system: "s",
      task: "t",
      tools: [echoTool(), createSubmitTool()],
      settings: { maxOutputTokens: 100 },
      limits: { maxTurns: 10, maxCostMicros: 1000 },
      price: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000 },
      signal: signal(),
    });
    expect(result.stopReason).toBe("COST_LIMIT");
    expect(model.requests).toHaveLength(1);
  });

  it("retries transient model failures and then reports MODEL_ERROR", async () => {
    const events: KernelEvent[] = [];
    const fail = async () => {
      throw new Error("503 upstream");
    };
    const model = new FakeLanguageModel([fail, fail, fail]);
    const result = await runAgentLoop({
      model,
      system: "s",
      task: "t",
      tools: [createSubmitTool()],
      limits: { maxTurns: 3 },
      signal: signal(),
      retryDelayMs: 0,
      onEvent: (event) => void events.push(event),
    });
    expect(result).toMatchObject({ stopReason: "MODEL_ERROR", error: "503 upstream" });
    expect(events.filter((e) => e.type === "model_error").map((e) => e.willRetry)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("charges failed calls at their worst case unless the adapter proves nothing was sent", async () => {
    const issued = async () => {
      throw new Error("socket hang up");
    };
    const rejected = async () => {
      throw Object.assign(new Error("too large"), { details: { requestIssued: false } });
    };
    const model = new FakeLanguageModel([
      rejected,
      issued,
      fakeModelResponse({ toolCalls: [call("1", "submit", { summary: "s" })] }),
    ]);
    const result = await runAgentLoop({
      model,
      system: "s",
      task: "t",
      tools: [createSubmitTool()],
      settings: { maxOutputTokens: 1000 },
      limits: { maxTurns: 3 },
      price: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000 },
      signal: signal(),
      retryDelayMs: 0,
    });
    expect(result.stopReason).toBe("SUBMITTED");
    // Exactly one worst case (prompt estimate + 1000 output tokens) for the issued failure.
    expect(result.usage.unconfirmedCostMicros).toBeGreaterThan(1000);
    expect(result.usage.unconfirmedCostMicros).toBeLessThan(1100);
  });

  it("elides older tool output near the context limit and keeps recent results intact", async () => {
    const big = "x".repeat(3000);
    const bigTool = defineAciTool({
      name: "big",
      description: "Large output.",
      inputSchema: z.object({}),
      readOnly: true,
      async run() {
        return { content: big };
      },
    });
    const steps = Array.from({ length: 15 }, (_, i) =>
      fakeModelResponse({ toolCalls: [call(String(i), "big", {})] }),
    );
    steps.push(fakeModelResponse({ toolCalls: [call("end", "submit", { summary: "s" })] }));
    const model = new FakeLanguageModel(steps);
    const result = await runAgentLoop({
      model,
      system: "s",
      task: "t",
      tools: [bigTool, createSubmitTool()],
      limits: { maxTurns: 40, maxInputTokens: 10_000 },
      signal: signal(),
    });
    expect(result.stopReason).toBe("SUBMITTED");
    const outputs = toolMessages(result.messages).map((m) => String(m.content));
    expect(outputs[0]).toContain("older output elided");
    expect(outputs.slice(-13, -1).every((content) => content === big)).toBe(true);
  });

  it("resumes a transcript with carried usage, turns and limits, checkpointing each turn", async () => {
    const first = await runAgentLoop({
      model: new FakeLanguageModel([
        fakeModelResponse({ toolCalls: [call("1", "echo", { text: "a" })], usage: usage(100) }),
        fakeModelResponse({
          toolCalls: [call("2", "submit", { summary: "v1" })],
          usage: usage(200),
        }),
      ]),
      system: "s",
      task: "t",
      tools: [echoTool(), createSubmitTool()],
      limits: { maxTurns: 4 },
      signal: signal(),
    });
    const checkpoints: number[] = [];
    const resumedModel = new FakeLanguageModel([
      fakeModelResponse({ toolCalls: [call("3", "echo", { text: "b" })], usage: usage(300) }),
      fakeModelResponse({ toolCalls: [call("4", "echo", { text: "c" })], usage: usage(400) }),
    ]);
    const second = await runAgentLoop({
      model: resumedModel,
      system: "ignored",
      task: "ignored",
      tools: [echoTool(), createSubmitTool()],
      limits: { maxTurns: 4 },
      signal: signal(),
      resume: {
        messages: [...first.messages, { role: "USER", content: "Verification failed: fix it." }],
        usage: first.usage,
        turns: first.turns,
      },
      onTurnEnd: (state) => void checkpoints.push(state.turns),
    });
    // The turn limit covers the whole conversation: 2 earlier + 2 resumed turns.
    expect(second).toMatchObject({ stopReason: "TURN_LIMIT", turns: 4 });
    expect(second.usage).toMatchObject({ modelCalls: 4, inputTokens: 1000 });
    expect(checkpoints).toEqual([3, 4]);
    expect(resumedModel.requests[0]!.messages.at(-1)).toMatchObject({
      role: "USER",
      content: "Verification failed: fix it.",
    });
    expect(first.messages).toHaveLength(6);
  });

  it("stops at the turn limit and warns the model as it approaches", async () => {
    const steps = Array.from({ length: 6 }, (_, i) =>
      fakeModelResponse({ toolCalls: [call(String(i), "echo", { text: String(i) })] }),
    );
    const result = await runAgentLoop({
      model: new FakeLanguageModel(steps),
      system: "s",
      task: "t",
      tools: [echoTool(), createSubmitTool()],
      limits: { maxTurns: 6 },
      signal: signal(),
    });
    expect(result.stopReason).toBe("TURN_LIMIT");
    expect(String(toolMessages(result.messages).at(-1)!.content)).toContain("0 turns left");
    expect(String(toolMessages(result.messages).at(-1)!.content)).toContain(
      "wrap up and submit your result soon",
    );
  });
});
