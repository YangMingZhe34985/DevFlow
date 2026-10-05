import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareCompressedStageContext } from "../src/context-compression.js";
import { FakeLanguageModel, fakeModelResponse } from "../src/fake-model.js";
import type { ModelMessage, ModelRequest } from "../src/model.js";
import { recoverContextMessage } from "../src/stage-context.js";
import { DefaultAgentRuntime } from "../src/runtime.js";
import {
  InMemoryAgentStateStore,
  createInitialAgentState,
  AgentStateSerializer,
} from "../src/state.js";
import type { NewAgentEvent } from "@devflow/shared";
const signal = new AbortController().signal;
function history(): ModelMessage[] {
  const h: ModelMessage[] = [
    { role: "SYSTEM", content: "Allowed files are a.ts; budget/approval owned by host" },
    { role: "USER", content: "Issue: preserve zero defaults" },
  ];
  for (let i = 0; i < 8; i++)
    h.push(
      {
        role: "ASSISTANT",
        content: "",
        toolCalls: [{ id: String(i), name: "readFile", input: { path: `file${i}.ts` } }],
      },
      {
        role: "TOOL",
        toolCallId: String(i),
        toolName: "readFile",
        isError: i === 6,
        content: {
          path: `file${i}.ts`,
          content: i === 6 ? "latest real error" : "Observed falsy guard " + "x".repeat(1000),
        },
      },
    );
  return h;
}
const summarize = async (request: ModelRequest) => {
  const row = JSON.parse(String(request.messages[1]!.content)).observations[0];
  return fakeModelResponse({
    toolCalls: [],
    output: {
      facts: [
        {
          index: row.index,
          sha256: row.sha256,
          quote: "Observed falsy guard",
          interpretation: "Possible falsy-value loss; verify current code",
        },
      ],
    },
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  });
};
function input(model: FakeLanguageModel) {
  return {
    stage: "EXECUTE" as const,
    history: history(),
    maxBytes: 4000,
    workspaceRevision: 0,
    authoritative: { approvalScope: ["a.ts"], remainingTokens: 12000 },
    signal,
    compression: { model, maxOutputTokens: 512 },
    budget: {
      remainingCalls: 2,
      remainingSteps: 2,
      remainingTokens: 12000,
      mainOutputReserve: 512,
    },
  };
}
describe("conditional context compression", () => {
  it("allocates space from actual summary size without removing the latest error or authority", async () => {
    const model = new FakeLanguageModel([
      async (request) => {
        const rows = JSON.parse(String(request.messages[1]!.content)).observations;
        return fakeModelResponse({
          toolCalls: [],
          output: {
            facts: rows.slice(0, 3).map((row: { index: number; sha256: string }) => ({
              index: row.index,
              sha256: row.sha256,
              quote: "Observed falsy guard",
              interpretation: "Verify this observation against the current file. ".repeat(5),
            })),
          },
        });
      },
    ]);
    const result = await prepareCompressedStageContext(input(model));
    expect(result.compression.status).toBe("SUMMARIZED");
    expect(result.viewBytes).toBeLessThanOrEqual(4000);
    expect(JSON.stringify(result.view)).toContain("latest real error");
    expect(JSON.stringify(result.view)).toContain("Allowed files are a.ts");
  });
  it("does not call a model when static context is sufficient or pinned authority cannot fit", async () => {
    const model = new FakeLanguageModel([]);
    const result = await prepareCompressedStageContext({ ...input(model), maxBytes: 96000 });
    expect(result.compression.status).toBe("STATIC_SUFFICIENT");
    expect(model.requests).toHaveLength(0);
    await expect(
      prepareCompressedStageContext({ ...input(model), maxBytes: 40 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(model.requests).toHaveLength(0);
  });
  it("preserves authority/errors and verified quotes while retaining recoverable full history", async () => {
    const model = new FakeLanguageModel([summarize]);
    const result = await prepareCompressedStageContext(input(model));
    expect(result.compression.status).toBe("SUMMARIZED");
    expect(result.compression.state.calls).toBe(1);
    expect(result.viewBytes).toBeLessThanOrEqual(4000);
    expect(JSON.stringify(result.view)).toContain("latest real error");
    expect(JSON.stringify(result.view)).toContain("Allowed files are a.ts");
    expect(JSON.stringify(result.view)).toContain("context-summary-v1");
    expect(result.history).toEqual(history());
    expect(recoverContextMessage(result, 3)).toEqual(history()[3]);
    expect(model.requests[0]?.tools).toEqual([]);
    const again = await prepareCompressedStageContext({
      ...input(model),
      compressionState: result.compression.state,
    });
    expect(again.compression.status).toBe("REUSED");
    expect(model.requests).toHaveLength(1);
  });
  it.each(["invented index", "changed hash", "invented quote"])(
    "rejects %s and falls back with usage still accounted",
    async (kind) => {
      let used = 0;
      const model = new FakeLanguageModel([
        async (r) => {
          const res = await summarize(r);
          const value = res.output as { facts: { index: number; sha256: string; quote: string }[] };
          if (kind === "invented index") value.facts[0]!.index = 999;
          else if (kind === "changed hash") value.facts[0]!.sha256 = "0".repeat(64);
          else value.facts[0]!.quote = "fictional test passed";
          return res;
        },
      ]);
      const data = input(model);
      data.compression = {
        ...data.compression,
        onResponse: async (r) => {
          used += r.usage.totalTokens;
        },
      } as typeof data.compression;
      const result = await prepareCompressedStageContext(data);
      expect(result.compression.status).toBe("SUMMARY_UNVERIFIED_REFERENCE");
      expect(used).toBe(150);
      expect(JSON.stringify(result.view)).not.toContain("context-summary-v1");
      expect(result.compression.state.pendingTokenReserve).toBe(0);
    },
  );
  it("reserves the next real decision and refuses exhausted budgets", async () => {
    const model = new FakeLanguageModel([]);
    const result = await prepareCompressedStageContext({
      ...input(model),
      budget: {
        remainingCalls: 0,
        remainingSteps: 2,
        remainingTokens: 12000,
        mainOutputReserve: 512,
      },
    });
    expect(result.compression.status).toBe("SUMMARY_BUDGET_RESERVED_FOR_MAIN");
    expect(model.requests).toHaveLength(0);
  });
  it("does not compress stale source after a mutation or promote it to current evidence", async () => {
    const data = input(new FakeLanguageModel([]));
    data.history.push(
      {
        role: "ASSISTANT",
        content: "",
        toolCalls: [{ id: "edit", name: "replaceText", input: {} }],
      },
      {
        role: "TOOL",
        toolCallId: "edit",
        toolName: "replaceText",
        isError: false,
        content: { status: "APPLIED" },
      },
    );
    const result = await prepareCompressedStageContext(data);
    expect(result.compression.status).toBe("STATIC_SUFFICIENT");
    expect(data.compression.model.requests).toHaveLength(0);
    expect(JSON.stringify(result.view)).toContain('"stale":true');
  });
  it("keeps unknown usage reserved on transport failure and prevents repeated summaries", async () => {
    const model = new FakeLanguageModel([
      () => {
        throw new Error("network timeout");
      },
    ]);
    const result = await prepareCompressedStageContext(input(model));
    expect(result.compression.status).toBe("SUMMARY_FAILED_STATIC_FALLBACK");
    expect(result.compression.state.pendingTokenReserve).toBeGreaterThan(512);
    const again = await prepareCompressedStageContext({
      ...input(model),
      compressionState: result.compression.state,
    });
    expect(again.compression.status).toBe("SUMMARY_LIMIT");
    expect(model.requests).toHaveLength(1);
  });
});

it.each([false, true])(
  "Runtime charges summary calls/steps and preserves unknown reservations (failure=%s)",
  async (failure) => {
    const runId = randomUUID(),
      store = new InMemoryAgentStateStore(),
      events: NewAgentEvent[] = [];
    await store.save(createInitialAgentState(runId, history(), new Date().toISOString()));
    const summary = new FakeLanguageModel([
      failure
        ? async () => {
            throw new Error("timeout");
          }
        : summarize,
    ]);
    const main = new FakeLanguageModel([
      async (request) => {
        expect(JSON.stringify(request.messages)).toContain("latest real error");
        expect(JSON.stringify(request.messages).includes("context-summary-v1")).toBe(!failure);
        return fakeModelResponse({
          toolCalls: [],
          text: "Stopped with uncertainty",
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        });
      },
    ]);
    const result = await new DefaultAgentRuntime(main).run(
      {
        contextStage: "EXECUTE",
        contextMaxBytes: 4000,
        contextCompression: { model: summary, maxOutputTokens: 512 },
        modelSettings: { maxOutputTokens: 512 },
        maxSteps: 3,
        timeoutMs: 5000,
        maxRetries: 0,
        executionBudget: {
          stage: "EXECUTE",
          maxModelCalls: 3,
          maxToolCalls: 3,
          maxTotalTokens: 12000,
        },
      },
      {
        runId,
        stateStore: store,
        task: {
          taskId: randomUUID(),
          repositoryId: randomUUID(),
          title: "Fix",
          description: "Fix zero",
        },
        signal,
        tools: [],
        emit: async (event) => {
          events.push(event);
        },
        executeTool: async () => ({ ok: true, durationMs: 0, output: {} }),
      },
    );
    expect(result.status).toBe("SUCCEEDED");
    expect(result.metrics.modelCalls).toBe(2);
    expect(result.metrics.steps).toBe(2);
    expect(result.metrics.tokenUsage.totalTokens).toBe(failure ? 25 : 175);
    expect(result.metrics.contextCompressionReservedTokens).toEqual(
      failure ? expect.any(Number) : 0,
    );
    if (failure) expect(result.metrics.contextCompressionReservedTokens).toBeGreaterThan(512);
    expect(events.filter((e) => e.type === "LLM_REQUEST")).toHaveLength(2);
    expect(new Set(events.filter((e) => e.type === "STEP_STARTED").map((e) => e.stepId)).size).toBe(
      2,
    );
    const restored = new AgentStateSerializer().deserialize(
      new AgentStateSerializer().serialize((await store.load(runId))!),
    );
    expect(restored.contextCompression?.calls).toBe(1);
    expect(restored.messages).toEqual(
      history().concat({ role: "ASSISTANT", content: "Stopped with uncertainty" }),
    );
  },
);
