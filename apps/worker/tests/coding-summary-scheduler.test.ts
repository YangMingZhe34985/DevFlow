import { expect, it, vi } from "vitest";
import { InMemoryBudgetLedgerStore } from "@devflow/database";
import {
  createConfiguredLanguageModel,
  optimizeContextProjection,
  preparedInput,
  summarizeCodingProjection,
  type ModelMessage,
} from "@devflow/agent";
import { ResourceBudgetScheduler } from "../src/runs/resource-budget-scheduler.js";
import { ResourceBudgetRuntime } from "../src/runs/resource-budget-runtime.js";

it("quotes and settles summary plus Coding through one ledger and dispatches the exact final projection", async () => {
  const wire: string[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
    wire.push(init.body);
    const body = JSON.parse(init.body);
    const user = body.messages.find((m: { role: string; content: string }) => m.role === "user");
    let text = "done";
    if (user.content.startsWith('{"observations":')) {
      const row = JSON.parse(user.content).observations[0];
      text = JSON.stringify({
        facts: [
          {
            index: row.index,
            sha256: row.sha256,
            quote: "historical navigation",
            interpretation: "Verify current implementation before editing",
          },
        ],
      });
    }
    return new Response(
      JSON.stringify({
        id: `mock-${wire.length}`,
        model: "glm-5.3",
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  try {
    const scheduler = await ResourceBudgetScheduler.open({
      runId: "summary-ledger",
      store: new InMemoryBudgetLedgerStore(),
      limits: { tokens: 100000, modelCalls: 10, steps: 10, timeMs: 500000, costMicros: 100000 },
      startedAt: Date.now(),
      deadlineAt: Date.now() + 500000,
    });
    const events: unknown[] = [];
    const runtime = new ResourceBudgetRuntime(scheduler, async (event) => {
      events.push(event);
    });
    const raw = createConfiguredLanguageModel({
      provider: "openai-compatible",
      providerName: "bailian",
      model: "glm-5.3",
      apiKey: "offline-only",
      baseUrl: "https://provider.invalid/v1",
      contextMaxBytes: 20000,
      structuredOutputMode: "json-object",
      enableThinking: true,
    });
    const price = { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 };
    const model = runtime.model(raw, {
      stage: "EXECUTE",
      timeoutMs: 60000,
      outputTokens: 512,
      price,
    });
    const messages: ModelMessage[] = [
      { role: "USER", content: "Task: preserve current implementation and counterevidence" },
      ...["old.ts", "current.ts"].flatMap((path, i): ModelMessage[] => [
        {
          role: "ASSISTANT",
          content: "",
          toolCalls: [{ id: path, name: "readFile", input: { path } }],
        },
        {
          role: "TOOL",
          toolCallId: path,
          toolName: "readFile",
          isError: false,
          content: {
            path,
            fileSha256: "a".repeat(64),
            content: i ? "CURRENT_REQUIRED" : "historical navigation\n".repeat(280),
          },
        },
      ]),
    ];
    const signal = AbortSignal.timeout(10000);
    const projection = await optimizeContextProjection({
      request: { messages, tools: [], settings: { maxOutputTokens: 512 } },
      maxBytes: 5000,
      priorityPaths: ["current.ts"],
      prepare: (r) => model.prepareRequest!(r, { signal }),
    });
    const summarized = await summarizeCodingProjection({
      projection,
      options: { model, mainPrice: price, maxOutputTokens: 512 },
      workspaceRevision: 0,
      maxBytes: 5000,
      maxInputTokens: 12000,
      remainingTokens: 100000,
      remainingSteps: 10,
      remainingCalls: 10,
      remainingTimeMs: 500000,
      mainCalls: 2,
      mainTimeoutMs: 60000,
      downstream: { tokens: 1000, costMicros: 2000, costStatus: "PRICED" },
      prepare: (r) => model.prepareRequest!(r, { signal }),
      signal,
    });
    expect(summarized.compression.status).toBe("SUMMARIZED");
    await model.generate(summarized.request, { signal });
    expect(wire).toHaveLength(2);
    expect(wire[1]).toBe(preparedInput(summarized.request)!.serialized);
    expect(JSON.stringify(events)).toContain(summarized.artifact.inputFingerprint);
    expect((await scheduler.snapshot()).consumed).toMatchObject({ tokens: 24, modelCalls: 2 });
    expect(
      summarized.request.messages.some((m) => JSON.stringify(m).includes("CURRENT_REQUIRED")),
    ).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});
