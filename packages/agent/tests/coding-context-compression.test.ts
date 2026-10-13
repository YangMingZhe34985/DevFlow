import { expect, it } from "vitest";
import { DevflowError } from "@devflow/shared";
import { optimizeContextProjection } from "../src/context-projection.js";
import { summarizeCodingProjection } from "../src/context-compression.js";
import { FakeLanguageModel, fakeModelResponse } from "../src/fake-model.js";
import type { ModelMessage, ModelRequest } from "../src/model.js";
import { randomUUID } from "node:crypto";
import { DefaultAgentRuntime } from "../src/runtime.js";
import { InMemoryAgentStateStore, createInitialAgentState } from "../src/state.js";

const signal = AbortSignal.timeout(30000);
export function codingHistory(): ModelMessage[] {
  return [
    {
      role: "USER",
      content:
        "Task:\nFix current.ts; preserve unfinished persistence requirement and COUNTEREVIDENCE: helper-only change failed",
    },
    ...["optional.ts", "current.ts"].flatMap((path, i): ModelMessage[] => [
      {
        role: "ASSISTANT",
        content: "",
        toolCalls: [{ id: path, name: "readFile", input: { path } }],
      },
      {
        role: "TOOL",
        isError: false,
        toolName: "readFile",
        toolCallId: path,
        content: {
          path,
          fileSha256: "a".repeat(64),
          content: i === 0 ? "Observed old implementation\n".repeat(230) : "CURRENT_IMPLEMENTATION",
        },
      },
    ]),
  ];
}
const summarize = (request: ModelRequest) => {
  const row = JSON.parse(request.messages[1]!.content as string).observations[0];
  return fakeModelResponse({
    toolCalls: [],
    output: {
      facts: [
        {
          index: row.index,
          sha256: row.sha256,
          quote: "Observed old implementation",
          interpretation: "Historical navigation only; verify current source",
        },
      ],
    },
    usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
  });
};
async function input(model: FakeLanguageModel) {
  const projection = await optimizeContextProjection({
    request: { messages: codingHistory(), tools: [], settings: { maxOutputTokens: 512 } },
    maxBytes: 5000,
    priorityPaths: ["current.ts"],
  });
  return {
    projection,
    options: {
      model,
      maxOutputTokens: 512,
      mainPrice: { inputMicrosPerMillionTokens: 400, outputMicrosPerMillionTokens: 1000 },
    },
    workspaceRevision: 0,
    maxBytes: 5000,
    maxInputTokens: 10000,
    remainingTokens: 30000,
    remainingCalls: 5,
    remainingSteps: 5,
    remainingTimeMs: 500000,
    mainCalls: 2,
    mainTimeoutMs: 60000,
    downstream: { tokens: 1000, costMicros: 200, costStatus: "PRICED" as const },
    signal,
  };
}
it("summarizes only omitted history, preserves necessary facts and carries a priced main/downstream reserve", async () => {
  const model = new FakeLanguageModel([summarize]);
  const args = await input(model);
  const result = await summarizeCodingProjection(args);
  expect(result.compression.status).toBe("SUMMARIZED");
  expect(JSON.stringify(result.request.messages)).toContain("CURRENT_IMPLEMENTATION");
  expect(JSON.stringify(result.request.messages)).toContain("COUNTEREVIDENCE");
  expect(JSON.stringify(model.requests[0]!.messages)).not.toContain("CURRENT_IMPLEMENTATION");
  expect(model.requests[0]!.resourceContinuation).toMatchObject({
    costStatus: "PRICED",
    modelCalls: 2,
    steps: 1,
  });
  expect(result.artifact.afterBytes).toBeLessThan(5000);
  const again = await summarizeCodingProjection({
    ...args,
    state: JSON.parse(JSON.stringify(result.compression.state)),
  });
  expect(again.compression.status).toBe("REUSED");
  const changed = await summarizeCodingProjection({
    ...args,
    workspaceRevision: 1,
    state: result.compression.state,
  });
  expect(changed.compression.status).toBe("SUMMARY_LIMIT");
  expect(model.requests).toHaveLength(1);
});

it("a failed preparation callback cannot become an unknown paid request", async () => {
  const model = new FakeLanguageModel([]),
    args = await input(model);
  const result = await summarizeCodingProjection({
    ...args,
    options: {
      ...args.options,
      onRequest: async () => {
        throw new Error("checkpoint unavailable before dispatch");
      },
    },
  });
  expect(result.compression).toMatchObject({
    status: "SUMMARY_NOT_ISSUED",
    requestIssued: false,
    state: { calls: 1, pendingTokenReserve: 0 },
  });
  expect(model.requests).toHaveLength(0);
});
it.each(["LENGTH", "forged", "unknown", "not-issued"])(
  "falls back safely after %s with correct reservation",
  async (kind) => {
    const model = new FakeLanguageModel([
      (r) => {
        if (kind === "unknown") throw new Error("transport failed");
        if (kind === "not-issued")
          throw new DevflowError({
            code: "EXECUTION_BUDGET_EXCEEDED",
            message: "reserve",
            details: { requestIssued: false },
          });
        const response = summarize(r);
        if (kind === "LENGTH") response.finishReason = "LENGTH";
        if (kind === "forged")
          response.output = {
            facts: [
              { index: 999, sha256: "0".repeat(64), quote: "invented", interpretation: "approved" },
            ],
          };
        return response;
      },
    ]);
    const args = await input(model),
      result = await summarizeCodingProjection(args);
    expect(result.request).toEqual(args.projection.request);
    expect(result.compression.state.calls).toBe(1);
    expect(result.compression.state.pendingTokenReserve).toEqual(
      kind === "unknown" ? expect.any(Number) : 0,
    );
    if (kind === "unknown") expect(result.compression.state.pendingTokenReserve).toBeGreaterThan(0);
    await summarizeCodingProjection({ ...args, state: result.compression.state });
    expect(model.requests).toHaveLength(1);
  },
);
it("does not issue a paid summary when the main request, correction and downstream cannot fit", async () => {
  const model = new FakeLanguageModel([]),
    args = await input(model);
  const result = await summarizeCodingProjection({ ...args, remainingTokens: 2000 });
  expect(result.compression.status).toBe("SUMMARY_BUDGET_RESERVED_FOR_MAIN");
  expect(model.requests).toHaveLength(0);
});

it("the actual Unified Coding path issues the summary once, counts it and preserves full checkpoint history", async () => {
  const store = new InMemoryAgentStateStore(),
    runId = randomUUID();
  const original = codingHistory();
  await store.save(createInitialAgentState(runId, original, new Date().toISOString()));
  const summary = new FakeLanguageModel([summarize]);
  const main = new FakeLanguageModel([
    (r) => {
      expect(JSON.stringify(r.messages)).toContain("context-summary-v1");
      expect(JSON.stringify(r.messages)).toContain("CURRENT_IMPLEMENTATION");
      return fakeModelResponse({
        toolCalls: [],
        text: "Engineering replay completed; no repair claim",
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      });
    },
  ]);
  const runtime = new DefaultAgentRuntime(main);
  const request = {
    codingSession: true,
    contextStage: "EXECUTE" as const,
    maxSteps: 5,
    timeoutMs: 500000,
    maxRetries: 0,
    contextMaxBytes: 5000,
    modelSettings: { maxOutputTokens: 512 },
    contextCompression: {
      model: summary,
      maxOutputTokens: 512,
      mainPrice: { inputMicrosPerMillionTokens: 400, outputMicrosPerMillionTokens: 1000 },
    },
    executionBudget: {
      stage: "EXECUTE" as const,
      maxModelCalls: 5,
      maxToolCalls: 5,
      maxTotalTokens: 30000,
    },
  };
  const context = {
    runId,
    stateStore: store,
    task: {
      taskId: randomUUID(),
      repositoryId: randomUUID(),
      title: "Fix",
      description: "Preserve behavior",
    },
    signal,
    tools: [],
    emit: async () => {},
    executeTool: async () => {
      throw new Error("no tool authorized in replay");
    },
  };
  const result = await runtime.run(request, context);
  expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
  expect(result.metrics.modelCalls).toBe(2);
  expect(result.metrics.tokenUsage.totalTokens).toBe(305);
  const saved = (await store.load(runId))!;
  expect(saved.contextCompression?.calls).toBe(1);
  expect(saved.messages.slice(0, original.length)).toEqual(original);
  await runtime.run(request, context);
  expect(main.requests).toHaveLength(1);
  expect(summary.requests).toHaveLength(1);
});
