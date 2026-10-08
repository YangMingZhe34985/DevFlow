import { describe, expect, it, vi } from "vitest";
import { InMemoryBudgetLedgerStore } from "@devflow/database";
import { DevflowError } from "@devflow/shared";
import {
  createConfiguredLanguageModel,
  FakeLanguageModel,
  fakeModelResponse,
  type ModelRequest,
  type AgentState,
  type AgentStateStore,
} from "@devflow/agent";
import type { SandboxSession } from "@devflow/sandbox";
import type { IndexSource } from "../src/localization/contracts.js";
import { estimatePlanRequest } from "../src/runs/plan-agent-context.js";
import {
  ResourceBudgetScheduler,
  type ResourceLimits,
} from "../src/runs/resource-budget-scheduler.js";
import {
  ResourceBudgetRuntime,
  resourceBudgetContext,
  recordLogicalResourceWork,
  recordDecisionResourceWork,
} from "../src/runs/resource-budget-runtime.js";

const signal = () => new AbortController().signal;

it("quotes and dispatches the identical prepared wire input through the stage wrapper", async () => {
  const { runtime, events } = await fixture();
  const { stageLanguageModel } = await import("../src/runs/stage-language-model.js");
  let wire = "";
  vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
    wire = init.body;
    return new Response(
      JSON.stringify({
        id: "projection-test",
        model: "glm-5.3",
        choices: [
          { index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  try {
    const raw = createConfiguredLanguageModel({
      provider: "openai-compatible",
      providerName: "bailian",
      model: "glm-5.3",
      apiKey: "offline-only",
      baseUrl: "https://provider.invalid/v1",
      contextMaxBytes: 96000,
    });
    const model = stageLanguageModel({
      model: runtime.model(raw, { stage: "EXECUTE", outputTokens: 8192, timeoutMs: 1000, price }),
      stage: "EXECUTE",
      contextTokens: 32000,
      settings: { maxOutputTokens: 8192, reasoningEffort: "low" },
      provenance: {},
    });
    const prepared = await model.prepareRequest!(
      { messages: [{ role: "USER", content: "Task and current diff" }], tools: [] },
      { signal: signal() },
    );
    expect(events).toEqual([]);
    await model.generate(prepared, { signal: signal() });
    expect(wire).toBe(prepared.inputProjection!.serialized);
    expect(events).toContainEqual({
      budgetScheduler: expect.objectContaining({
        action: "INVOKE",
        inputFingerprint: prepared.inputProjection!.fingerprint,
        resources: expect.objectContaining({
          inputTokens: prepared.inputProjection!.estimatedInputTokens,
        }),
      }),
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
const price = { inputMicrosPerMillionTokens: 8_000_000, outputMicrosPerMillionTokens: 28_000_000 };
const request: ModelRequest = {
  messages: [{ role: "USER", content: "Current code and public failure evidence\n".repeat(30) }],
  tools: [],
  settings: { maxOutputTokens: 16384, enableThinking: true, reasoningEffort: "low" },
};

async function fixture(limits: ResourceLimits = {}) {
  const store = new InMemoryBudgetLedgerStore();
  const startedAt = Date.now();
  const options = {
    runId: "runtime-test",
    store,
    startedAt,
    deadlineAt: startedAt + 1_500_000,
    limits: {
      tokens: 250000,
      steps: 25,
      modelCalls: 31,
      logicalToolCalls: 75,
      timeMs: 1_500_000,
      ...limits,
    },
  };
  const scheduler = await ResourceBudgetScheduler.open(options);
  const events: Record<string, unknown>[] = [];
  const runtime = new ResourceBudgetRuntime(scheduler, async (event) => {
    events.push(event);
  });
  return { store, options, scheduler, runtime, events };
}

function sandbox() {
  const readFile = vi.fn(async () => ({
    path: "a.ts",
    content: "export const value = 1;\n",
    fileSha256: "a".repeat(64),
    truncated: false,
  }));
  const exec = vi.fn(async () => ({
    stdout: "public check passed",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    outputTruncated: false,
    durationMs: 1,
  }));
  const value = {
    id: "sandbox",
    workspacePath: "/workspace",
    readFile,
    exec,
    dispose: async () => undefined,
  } as unknown as SandboxSession;
  return { value, readFile, exec };
}

describe("Resource Budget Scheduler execution boundary", () => {
  it("refuses a request that fits alone but would spend the necessary continuation", async () => {
    const required = estimatePlanRequest(request).estimatedInputTokens + 16384;
    const { runtime } = await fixture({ tokens: required + 1999 });
    const model = new FakeLanguageModel([]);
    await expect(
      runtime
        .model(model, { stage: "EXECUTE", outputTokens: 16384, timeoutMs: 1000 })
        .generate({ ...request, resourceContinuation: { tokens: 2000 } }, { signal: signal() }),
    ).rejects.toMatchObject({
      code: "EXECUTION_BUDGET_EXCEEDED",
      details: { requestIssued: false },
    });
    expect(model.requests).toHaveLength(0);
  });

  it("does not price unknown downstream models as free under a monetary cap", async () => {
    const { runtime } = await fixture({ costMicros: 10_000_000 });
    const model = new FakeLanguageModel([]);
    await expect(
      runtime
        .model(model, { stage: "EXECUTE", outputTokens: 16384, timeoutMs: 1000, price })
        .generate({ ...request, resourceContinuation: { tokens: 2000 } }, { signal: signal() }),
    ).rejects.toMatchObject({
      code: "EXECUTION_BUDGET_EXCEEDED",
      details: { diagnostics: { reason: "COST_UNKNOWN" } },
    });
    expect(model.requests).toHaveLength(0);
  });

  it("quotes downstream cost conservatively and settles only actual provider cost", async () => {
    const { runtime, scheduler, events } = await fixture({ costMicros: 10_000_000 });
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [],
        usage: { inputTokens: 50, outputTokens: 40, totalTokens: 90 },
      }),
    ]);
    await runtime
      .model(model, {
        stage: "EXECUTE",
        outputTokens: 16384,
        timeoutMs: 1000,
        price,
        continuationMicrosPerMillionTokens: 28_000_000,
      })
      .generate({ ...request, resourceContinuation: { tokens: 2000 } }, { signal: signal() });
    expect((await scheduler.snapshot()).consumed.costMicros).toBe(1520);
    expect(JSON.stringify(events)).toContain('"costMicros":56000');
  });
  it("persists the actual projection before dispatch and settles reasoning-inclusive usage exactly once", async () => {
    const { scheduler, runtime } = await fixture({ costMicros: 1_000_000 });
    const model = new FakeLanguageModel([
      async (actualRequest) => {
        expect(actualRequest).toEqual(request);
        const pending = Object.values((await scheduler.snapshot()).reservations).filter(
          (entry) => entry.status === "ADMITTED",
        );
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          status: "ADMITTED",
          quote: {
            resources: {
              inputTokens: estimatePlanRequest(request).estimatedInputTokens,
              outputTokens: 16384,
              modelCalls: 1,
              steps: 0,
            },
          },
        });
        return fakeModelResponse({
          toolCalls: [],
          reasoningTokens: 30,
          usage: { inputTokens: 50, outputTokens: 40, totalTokens: 90 },
        });
      },
    ]);
    await resourceBudgetContext.run(runtime, async () => {
      recordDecisionResourceWork(1);
      await runtime
        .model(model, { stage: "EXECUTE", outputTokens: 16384, timeoutMs: 1000, price })
        .generate(request, { signal: signal() });
    });
    const ledger = await scheduler.snapshot();
    expect(ledger.consumed).toMatchObject({
      tokens: 90,
      inputTokens: 50,
      outputTokens: 40,
      modelCalls: 1,
      steps: 1,
      costMicros: 1520,
    });
    expect(Object.values(ledger.reservations)[0]!.status).toBe("SETTLED");
    expect(ledger.violations).toEqual([]);
  });

  it("refuses insufficient projected input plus configured output without reducing the cap or dispatching", async () => {
    const required = estimatePlanRequest(request).estimatedInputTokens + 16384;
    const { scheduler, runtime, events } = await fixture({ tokens: required - 1 });
    const model = new FakeLanguageModel([]);
    await expect(
      runtime
        .model(model, { stage: "EXECUTE", outputTokens: 16384, timeoutMs: 1000, price })
        .generate(request, { signal: signal() }),
    ).rejects.toMatchObject({
      code: "EXECUTION_BUDGET_EXCEEDED",
      details: { requestIssued: false },
    });
    expect(model.requests).toEqual([]);
    expect((await scheduler.snapshot()).consumed.tokens).toBe(0);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          budgetScheduler: expect.objectContaining({ requestIssued: false }),
        }),
      ]),
    );
  });

  it("keeps unknown provider consumption held across a new Worker and cannot reuse that model-call capacity", async () => {
    const { options, scheduler, runtime } = await fixture({ modelCalls: 1 });
    const failing = new FakeLanguageModel([
      async () => {
        throw Error("transport interrupted");
      },
    ]);
    await expect(
      runtime
        .model(failing, { stage: "REVIEW", outputTokens: 16384, timeoutMs: 1000, price })
        .generate(request, { signal: signal() }),
    ).rejects.toThrow("transport interrupted");
    const before = await scheduler.snapshot();
    expect(before.consumed.modelCalls).toBe(1);
    expect(Object.values(before.reservations)[0]!.knownUsage?.timeMs).toBeTypeOf("number");
    expect(Object.values(before.reservations)[0]!.status).toBe("ADMITTED");
    const resumed = await ResourceBudgetScheduler.open({
      ...options,
      startedAt: Date.now(),
      deadlineAt: Date.now() + 2_000_000,
    });
    const next = new FakeLanguageModel([]);
    const resumedRuntime = new ResourceBudgetRuntime(resumed, async () => undefined);
    await expect(
      resumedRuntime
        .model(next, { stage: "REVIEW", outputTokens: 16384, timeoutMs: 1000, price })
        .generate(request, { signal: signal() }),
    ).rejects.toMatchObject({ code: "EXECUTION_BUDGET_EXCEEDED" });
    expect(next.requests).toEqual([]);
    expect((await resumed.snapshot()).deadlineAt).toBe(before.deadlineAt);
    expect(
      Object.values((await resumed.snapshot()).reservations).filter((r) => r.status === "ADMITTED"),
    ).toHaveLength(1);
  });

  it.each([true, false])(
    "settles a trusted local rejection without token or cost exposure (priced=%s)",
    async (priced) => {
      const { runtime, scheduler, options, events } = await fixture();
      const failure = new DevflowError({
        code: "VALIDATION_ERROR",
        message: "The provider input exceeds its local byte limit.",
        details: { requestIssued: false, requiredBytes: 98090, maxBytes: 96000 },
      });
      const model = new FakeLanguageModel([
        async () => {
          throw failure;
        },
      ]);
      await expect(
        runtime
          .model(model, {
            stage: "EXECUTE",
            outputTokens: 16384,
            timeoutMs: 1000,
            ...(priced ? { price } : {}),
          })
          .generate(request, { signal: signal() }),
      ).rejects.toBe(failure);
      const before = await scheduler.snapshot();
      const reservation = Object.values(before.reservations)[0]!;
      expect(reservation).toMatchObject({
        status: "SETTLED",
        costStatus: "PRICED",
        actual: { tokens: 0, inputTokens: 0, outputTokens: 0, costMicros: 0, modelCalls: 1 },
      });
      expect(reservation.actual!.timeMs).toBeGreaterThanOrEqual(0);
      expect(before.consumed).toMatchObject({ tokens: 0, costMicros: 0, modelCalls: 1 });
      expect(before.unpricedOperationIds).toEqual([]);
      expect(events).toContainEqual({
        budgetScheduler: expect.objectContaining({
          action: "NOT_DISPATCHED",
          requestIssued: false,
          dispatchStatus: "NOT_ISSUED",
        }),
      });
      expect(JSON.stringify(events)).not.toContain('"requestIssued":true');
      const resumed = await ResourceBudgetScheduler.open(options);
      await resumed.settle(reservation.id, reservation.actual!, { costStatus: "PRICED" });
      expect((await resumed.snapshot()).consumed).toEqual(before.consumed);
      expect((await resumed.snapshot()).deadlineAt).toBe(before.deadlineAt);
      expect(Object.values((await resumed.snapshot()).reservations)).toEqual(
        Object.values(before.reservations),
      );
    },
  );

  it("does not trust a plain transport error claiming that no request was issued", async () => {
    const { runtime, scheduler, events } = await fixture();
    const failure = Object.assign(Error("untrusted transport failure"), {
      details: { requestIssued: false },
    });
    await expect(
      runtime
        .model(
          new FakeLanguageModel([
            async () => {
              throw failure;
            },
          ]),
          {
            stage: "EXECUTE",
            outputTokens: 16384,
            timeoutMs: 1000,
            price,
          },
        )
        .generate(request, { signal: signal() }),
    ).rejects.toBe(failure);
    const ledger = await scheduler.snapshot();
    expect(Object.values(ledger.reservations)[0]).toMatchObject({
      status: "ADMITTED",
      knownUsage: { modelCalls: 1 },
    });
    expect(events).toContainEqual({
      budgetScheduler: expect.objectContaining({ action: "UNCERTAIN", dispatchStatus: "UNKNOWN" }),
    });
    expect(JSON.stringify(events)).not.toContain('"requestIssued":true');
  });

  it("releases the real provider byte-preflight quote without issuing HTTP", async () => {
    const { runtime, scheduler, events } = await fixture({ costMicros: 2_000_000 });
    const http = vi.fn(async () => {
      throw Error("HTTP must not be called");
    });
    vi.stubGlobal("fetch", http);
    try {
      const adapter = createConfiguredLanguageModel({
        provider: "openai-compatible",
        model: "test-model",
        apiKey: "test-only",
        baseUrl: "https://provider.invalid/v1",
        contextMaxBytes: 96000,
      });
      await expect(
        runtime
          .model(adapter, { stage: "EXECUTE", outputTokens: 8192, timeoutMs: 1000, price })
          .generate(
            {
              messages: [{ role: "USER", content: "a".repeat(98000) }],
              tools: [],
              settings: { maxOutputTokens: 8192 },
            },
            { signal: signal() },
          ),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        details: { maxBytes: 96000, requestIssued: false },
      });
      expect(http).not.toHaveBeenCalled();
      const ledger = await scheduler.snapshot();
      expect(ledger.consumed).toMatchObject({ tokens: 0, costMicros: 0, modelCalls: 1 });
      expect(Object.values(ledger.reservations)[0]?.status).toBe("SETTLED");
      expect(JSON.stringify(events)).not.toContain('"requestIssued":true');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("blocks an unpriced LLM when a hard cost cap is configured", async () => {
    const { scheduler, runtime } = await fixture({ costMicros: 1_000_000 });
    const model = new FakeLanguageModel([]);
    await expect(
      runtime
        .model(model, { stage: "PLANNER", outputTokens: 16384, timeoutMs: 1000 })
        .generate(request, { signal: signal() }),
    ).rejects.toMatchObject({ code: "EXECUTION_BUDGET_EXCEEDED" });
    expect(model.requests).toEqual([]);
    expect((await scheduler.snapshot()).lastDecision?.quote.reason).toBe("COST_UNKNOWN");
  });

  it("separates logical cache-hit decisions from physical IO and preserves the ledger on resume", async () => {
    const { runtime, scheduler, options } = await fixture();
    const source = sandbox(),
      wrapped = runtime.sandbox(source.value);
    expect(runtime.sandbox(source.value)).toBe(wrapped);
    await runtime.logicalTool("first-read");
    await wrapped.readFile({ path: "a.ts", maxBytes: 4096 }, signal());
    await runtime.logicalTool("cached-read"); // Agent cache serves the second call without sandbox IO.
    expect(source.readFile).toHaveBeenCalledTimes(1);
    const before = await scheduler.snapshot();
    expect(before.consumed).toMatchObject({
      logicalToolCalls: 2,
      toolExecutions: 1,
      ioReads: 1,
      ioBytes: 24,
    });
    const resumed = await ResourceBudgetScheduler.open(options);
    expect((await resumed.snapshot()).consumed).toEqual(before.consumed);
  });

  it("counts a source read that delegates to Sandbox only once and exempts immutable memory projection", async () => {
    const { runtime, scheduler } = await fixture();
    const raw = sandbox(),
      wrapped = runtime.sandbox(raw.value);
    const source = {
      resourceIOOwner: "SANDBOX",
      manifest: async () => ({ entries: [], incomplete: false }),
      read: async (path: string, abort: AbortSignal) => {
        const file = await wrapped.readFile({ path, maxBytes: 4096 }, abort);
        return { path, content: file.content, contentHash: file.fileSha256! };
      },
    } as IndexSource;
    expect(runtime.source(source, true)).toBe(source);
    await runtime.source(source).read("a.ts", signal());
    expect(raw.readFile).toHaveBeenCalledTimes(1);
    expect((await scheduler.snapshot()).consumed).toMatchObject({
      logicalToolCalls: 0,
      toolExecutions: 1,
      ioReads: 1,
      ioBytes: 24,
    });
  });

  it("drains a failed logical admission before issuing physical IO", async () => {
    const { runtime, scheduler } = await fixture({ logicalToolCalls: 1 });
    const source = sandbox();
    await resourceBudgetContext.run(runtime, async () => {
      recordLogicalResourceWork(2);
      await expect(
        runtime.sandbox(source.value).readFile({ path: "a.ts", maxBytes: 4096 }, signal()),
      ).rejects.toMatchObject({ code: "EXECUTION_BUDGET_EXCEEDED" });
    });
    expect(source.readFile).not.toHaveBeenCalled();
    expect((await scheduler.snapshot()).consumed).toMatchObject({
      logicalToolCalls: 0,
      toolExecutions: 0,
      ioReads: 0,
    });
  });

  it("measures command output bytes under the configured physical IO cap", async () => {
    const { runtime, scheduler } = await fixture({ ioBytes: 128 });
    const source = sandbox();
    await runtime
      .sandbox(source.value)
      .exec({ program: "node", args: ["--version"], maxOutputBytes: 128 }, signal());
    const ledger = await scheduler.snapshot();
    expect(ledger.consumed.ioBytes).toBe(Buffer.byteLength("public check passed"));
    expect(ledger.violations).toEqual([]);
    expect(ledger.estimateVariances ?? []).toEqual([]);
  });

  it("restores decision checkpoints monotonically without charging the same saved step again", async () => {
    const { runtime, scheduler, options } = await fixture({ steps: 4 });
    let current = { runId: "runtime-test", stepCount: 0 } as AgentState;
    const store: AgentStateStore = {
      load: async () => current,
      save: async (next) => {
        current = next;
      },
    };
    const wrapped = runtime.stateStore(store);
    await wrapped.load("runtime-test");
    await wrapped.save({ ...current, stepCount: 1 });
    await wrapped.save({ ...current, stepCount: 1 });
    expect((await scheduler.snapshot()).consumed.steps).toBe(1);
    const resumedScheduler = await ResourceBudgetScheduler.open(options);
    const resumed = new ResourceBudgetRuntime(resumedScheduler, async () => undefined).stateStore(
      store,
    );
    await resumed.load("runtime-test");
    await resumed.save({ ...current, stepCount: 1 });
    await resumed.save({ ...current, stepCount: 2 });
    expect((await resumedScheduler.snapshot()).consumed.steps).toBe(2);
  });

  it("does not double-charge a decision when the ledger survived but checkpoint persistence failed", async () => {
    const { runtime, scheduler, options } = await fixture();
    const prior = { runId: "runtime-test", stepCount: 0 } as AgentState;
    const failing: AgentStateStore = {
      load: async () => prior,
      save: async () => {
        throw Error("checkpoint write failed");
      },
    };
    const first = runtime.stateStore(failing);
    await first.load("runtime-test");
    await expect(first.save({ ...prior, stepCount: 1 })).rejects.toThrow("checkpoint write failed");
    expect((await scheduler.snapshot()).consumed.steps).toBe(1);
    const resumedScheduler = await ResourceBudgetScheduler.open(options);
    const resumed = new ResourceBudgetRuntime(resumedScheduler, async () => undefined).stateStore({
      load: async () => prior,
      save: async () => undefined,
    });
    await resumed.load("runtime-test");
    // Recovery may safely resume the same settled identity or explicitly block the divergent state.
    try {
      await resumed.save({ ...prior, stepCount: 1 });
    } catch {
      /* A fail-closed recovery is permitted. */
    }
    expect((await resumedScheduler.snapshot()).consumed.steps).toBe(1);
  });
});
