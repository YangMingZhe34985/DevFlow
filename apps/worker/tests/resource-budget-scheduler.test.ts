import { describe, expect, it } from "vitest";

import { InMemoryBudgetLedgerStore, type BudgetLedgerStore } from "@devflow/database";

import {
  estimateOperationPlan,
  ResourceBudgetScheduler,
  type ResourceBudgetOperationPlan,
  type ResourceBudgetSchedulerOptions,
  type ResourceVector,
} from "../src/runs/resource-budget-scheduler.js";

function operation(
  id: string,
  resources: Partial<ResourceVector>,
  overrides: Partial<Extract<ResourceBudgetOperationPlan, { kind: "OPERATION" }>> = {},
): ResourceBudgetOperationPlan {
  return {
    kind: "OPERATION",
    id,
    requirement: "REQUIRED",
    state: "PENDING",
    resources,
    ...overrides,
  };
}

function setup(overrides: Partial<ResourceBudgetSchedulerOptions> = {}) {
  let now = 1_000;
  const store = overrides.store ?? new InMemoryBudgetLedgerStore();
  const options: ResourceBudgetSchedulerOptions = {
    runId: "run-1",
    store,
    limits: { tokens: 1_000, logicalToolCalls: 10, steps: 5, timeMs: 10_000, costMicros: 1_000 },
    startedAt: now,
    deadlineAt: now + 10_000,
    clock: () => now,
    ...overrides,
  };
  return {
    store,
    options,
    setTime: (time: number) => {
      now = time;
    },
    open: () => ResourceBudgetScheduler.open(options),
  };
}

describe("resource operation planning", () => {
  it("adds sequential stages, with one shared downstream envelope for explicitly exclusive branches", () => {
    const plan: ResourceBudgetOperationPlan = {
      kind: "EXCLUSIVE",
      id: "submit-or-replan",
      exclusivityKey: "coding.outcome",
      shared: operation("review", { tokens: 100, logicalToolCalls: 2 }),
      branches: [
        operation("submit", { tokens: 30, logicalToolCalls: 2 }),
        {
          kind: "SEQUENCE",
          id: "replan",
          operations: [
            operation("planner", { tokens: 80, logicalToolCalls: 3 }),
            operation("restore", { logicalToolCalls: 4 }),
          ],
        },
      ],
    };
    expect(estimateOperationPlan(plan).resources).toMatchObject({
      tokens: 180,
      logicalToolCalls: 9,
    });
    const sequential: ResourceBudgetOperationPlan = {
      kind: "SEQUENCE",
      id: "actual-two-stages",
      operations: [operation("a", { tokens: 80 }), operation("b", { tokens: 70 })],
    };
    expect(estimateOperationPlan(sequential).resources.tokens).toBe(150);
  });

  it("does not combine input and output maxima of mutually exclusive requests", () => {
    const plan: ResourceBudgetOperationPlan = {
      kind: "EXCLUSIVE",
      id: "branches",
      exclusivityKey: "one-choice",
      branches: [
        operation("input-heavy", { inputTokens: 100 }),
        operation("output-heavy", { outputTokens: 100 }),
      ],
    };
    expect(estimateOperationPlan(plan).resources).toMatchObject({
      tokens: 100,
      inputTokens: 100,
      outputTokens: 100,
    });
  });

  it("counts cached/completed operations as no new IO and rejects shared identity duplication", () => {
    const plan: ResourceBudgetOperationPlan = {
      kind: "SEQUENCE",
      id: "io",
      operations: [
        operation("cached", { ioReads: 1, logicalToolCalls: 1 }, { state: "CACHED" }),
        operation("done", { ioWrites: 1 }, { state: "COMPLETED" }),
        operation("needed", { ioReads: 1, logicalToolCalls: 1 }),
      ],
    };
    expect(estimateOperationPlan(plan).resources).toMatchObject({
      ioReads: 1,
      ioWrites: 0,
      logicalToolCalls: 1,
    });
    expect(() =>
      estimateOperationPlan({
        kind: "SEQUENCE",
        id: "repeat",
        operations: [operation("same", { tokens: 2 }), operation("same", { tokens: 2 })],
      }),
    ).toThrow(/Duplicate operation/);
  });

  it("requires an explicit exclusivity key and validates overflow, negative and fractional costs", () => {
    expect(() =>
      estimateOperationPlan({ kind: "EXCLUSIVE", id: "invalid", exclusivityKey: "", branches: [] }),
    ).toThrow();
    for (const value of [-1, 0.1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => estimateOperationPlan(operation("invalid", { costMicros: value }))).toThrow();
    }
    expect(() =>
      estimateOperationPlan({
        kind: "SEQUENCE",
        id: "overflow",
        operations: [
          operation("a", { tokens: Number.MAX_SAFE_INTEGER }),
          operation("b", { tokens: 1 }),
        ],
      }),
    ).toThrow();
  });
});

describe("durable Resource Budget Scheduler", () => {
  it("quotes without spending, removes optional operations first and blocks necessary resource gaps", async () => {
    const scheduler = await setup().open();
    const plan: ResourceBudgetOperationPlan = {
      kind: "SEQUENCE",
      id: "request-and-validation",
      operations: [
        operation("request", { tokens: 800 }),
        operation("optional-navigation", { tokens: 300 }, { requirement: "OPTIONAL" }),
        operation("validation", { tokens: 100 }),
      ],
    };
    const quote = await scheduler.quote(plan);
    expect(quote).toMatchObject({
      fits: true,
      resources: { tokens: 900 },
      omittedOperationIds: ["optional-navigation"],
    });
    expect((await scheduler.snapshot()).consumed.tokens).toBe(0);
    const rejected = await scheduler.reserve(
      "oversized",
      operation("must-read", { tokens: 1_001 }),
    );
    expect(rejected).toMatchObject({
      reserved: false,
      quote: { fits: false, shortfalls: { tokens: 1 } },
    });
    const ledger = await scheduler.snapshot();
    expect(ledger.reservations).toEqual({});
    expect(ledger.lastDecision).toMatchObject({ operationId: "oversized", requestIssued: false });
  });

  it("persists reservation and single-owner admission before a side effect", async () => {
    const fixture = setup();
    const scheduler = await fixture.open();
    await scheduler.reserve("request", operation("llm", { tokens: 800, costMicros: 50 }));
    expect((await fixture.store.get("run-1"))?.revision).toBe(1);
    expect((await scheduler.quote(operation("too-late", { tokens: 300 }))).fits).toBe(false);
    const [first, second] = await Promise.all([
      scheduler.admit("request"),
      scheduler.admit("request"),
    ]);
    expect([first.admitted, second.admitted].filter(Boolean)).toHaveLength(1);
    expect((await scheduler.snapshot()).reservations.request?.status).toBe("ADMITTED");
  });

  it("handles competing independent instances without oversubscribing one run", async () => {
    const fixture = setup();
    const a = await fixture.open();
    const b = await fixture.open();
    const results = await Promise.all([
      a.reserve("a", operation("one", { logicalToolCalls: 7 })),
      b.reserve("b", operation("two", { logicalToolCalls: 7 })),
    ]);
    expect(results.filter((result) => result.reserved)).toHaveLength(1);
    expect((await a.snapshot()).consumed.logicalToolCalls).toBe(0);
  });

  it("atomically settles exactly once and releases only the unused part of the quote", async () => {
    const fixture = setup();
    const a = await fixture.open();
    const b = await fixture.open();
    await a.reserve("request", operation("llm", { tokens: 800, modelCalls: 1, costMicros: 90 }));
    await a.admit("request");
    await Promise.all([
      a.settle("request", { tokens: 500, modelCalls: 1, costMicros: 45 }),
      b.settle("request", { tokens: 500, modelCalls: 1, costMicros: 45 }),
    ]);
    expect((await a.snapshot()).consumed).toMatchObject({
      tokens: 500,
      modelCalls: 1,
      costMicros: 45,
    });
    expect((await b.quote(operation("next", { tokens: 500 }))).fits).toBe(true);
    expect((await b.admit("request")).reason).toBe("ALREADY_SETTLED");
    await expect(a.settle("request", { tokens: 501 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("holds unknown inflight resources across crash and approval resume without extending deadline", async () => {
    const fixture = setup();
    const first = await fixture.open();
    await first.reserve("issued", operation("llm", { tokens: 900, costMicros: 700, timeMs: 500 }));
    await first.admit("issued");
    fixture.setTime(8_000);
    const resumed = await ResourceBudgetScheduler.open({
      ...fixture.options,
      startedAt: 8_000,
      deadlineAt: 18_000,
    });
    expect((await resumed.snapshot()).deadlineAt).toBe(11_000);
    expect((await resumed.quote(operation("new", { tokens: 101 }))).fits).toBe(false);
    expect((await resumed.admit("issued")).reason).toBe("ALREADY_ADMITTED");
    await expect(resumed.release("issued", "worker restarted")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      ResourceBudgetScheduler.open({
        ...fixture.options,
        limits: { ...fixture.options.limits, tokens: 2_000 },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rechecks the absolute deadline between reserve and dispatch", async () => {
    const fixture = setup();
    const scheduler = await fixture.open();
    await scheduler.reserve("delayed", operation("request", { tokens: 10, timeMs: 1_000 }));
    fixture.setTime(10_100);
    expect(await scheduler.admit("delayed")).toMatchObject({
      admitted: false,
      reason: "LIMIT_EXCEEDED",
      shortfalls: { timeMs: 100 },
    });
    fixture.setTime(11_000);
    expect(await scheduler.quote(operation("zero-estimate", {}))).toMatchObject({
      fits: false,
      shortfalls: { timeMs: 1 },
    });
  });

  it("records quote variance without rejecting safely affordable provider usage", async () => {
    const scheduler = await setup().open();
    await scheduler.reserve("bad-estimate", operation("request", { tokens: 500 }));
    await scheduler.admit("bad-estimate");
    const ledger = await scheduler.settle("bad-estimate", { tokens: 600, ioBytes: 1_024 });
    expect(ledger.consumed.tokens).toBe(600);
    expect(ledger.violations).toEqual([]);
    expect(ledger.estimateVariances).toContainEqual({
      operationId: "bad-estimate",
      dimension: "tokens",
      estimated: 500,
      actual: 600,
    });
    expect((await scheduler.quote(operation("another", { tokens: 400 }))).fits).toBe(true);
  });

  it("blocks when actual usage displaces another valid reservation or exceeds the Run cap", async () => {
    const scheduler = await setup().open();
    await scheduler.reserve("request", operation("llm", { tokens: 500 }));
    await scheduler.reserve("required-review", operation("review", { tokens: 500 }));
    await scheduler.admit("request");
    const ledger = await scheduler.settle("request", { tokens: 600 });
    expect(ledger.violations).toContainEqual({
      operationId: "request",
      dimension: "tokens",
      estimated: 1_000,
      actual: 1_100,
    });
    expect(await scheduler.admit("required-review")).toMatchObject({
      admitted: false,
      reason: "LEDGER_VIOLATION",
    });
    expect((await scheduler.quote(operation("another", { tokens: 1 }))).reason).toBe(
      "LEDGER_VIOLATION",
    );
    const overCap = await setup({ initialConsumed: { tokens: 1_001 } }).open();
    expect((await overCap.quote(operation("zero", {}))).reason).toBe("LEDGER_VIOLATION");
  });

  it("uses wall time for the deadline and records parallel execution durations only as observations", async () => {
    const fixture = setup();
    const scheduler = await fixture.open();
    await scheduler.reserve(
      "parallel-tools",
      operation("batch", { timeMs: 3_000, toolExecutions: 2 }),
    );
    await scheduler.admit("parallel-tools");
    fixture.setTime(4_000);
    const ledger = await scheduler.settle("parallel-tools", { timeMs: 6_000, toolExecutions: 2 });
    expect(ledger.violations).toEqual([]);
    expect((await scheduler.quote(operation("followup", { timeMs: 7_000 }))).fits).toBe(true);
  });

  it("fails closed on incomplete persisted consumption instead of interpreting it as zero", async () => {
    const fixture = setup();
    const scheduler = await fixture.open();
    const record = await fixture.store.get("run-1");
    const corrupt = await scheduler.snapshot();
    delete (corrupt.consumed as Partial<ResourceVector>).tokens;
    await fixture.store.compareAndSwap("run-1", record!.revision, corrupt);
    await expect(fixture.open()).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps logical calls, nested executions and IO independently observable", async () => {
    const scheduler = await setup().open();
    await scheduler.reserve(
      "logical-read",
      operation("tool", { logicalToolCalls: 1, toolExecutions: 3, ioReads: 2 }),
    );
    await scheduler.admit("logical-read");
    await scheduler.settle("logical-read", {
      logicalToolCalls: 1,
      toolExecutions: 3,
      ioReads: 2,
      ioBytes: 1_234,
    });
    expect((await scheduler.snapshot()).consumed).toMatchObject({
      logicalToolCalls: 1,
      toolExecutions: 3,
      ioReads: 2,
      ioBytes: 1_234,
    });
    await scheduler.reconcileObservation("legacy-tool-1", { logicalToolCalls: 1 });
    expect((await scheduler.snapshot()).consumed.logicalToolCalls).toBe(1);
  });

  it("reconciles old cumulative metrics by a monotonic floor and rejects ambiguous inflight overlap", async () => {
    const scheduler = await setup({ initialConsumed: { tokens: 200, steps: 1 } }).open();
    await scheduler.reconcileObservation("historical", { tokens: 200, steps: 2 });
    await scheduler.reconcileObservation("historical", { tokens: 200, steps: 2 });
    await scheduler.reconcileObservation("old-checkpoint", { tokens: 100, steps: 1 });
    await scheduler.reserve("new", operation("llm", { tokens: 300 }));
    await scheduler.admit("new");
    await expect(
      scheduler.reconcileObservation("premature", { tokens: 400 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await scheduler.settle("new", { tokens: 250 });
    await scheduler.reconcileObservation("after-response", { tokens: 450, steps: 3 });
    expect((await scheduler.snapshot()).consumed).toMatchObject({ tokens: 450, steps: 3 });
    await expect(
      scheduler.reconcileObservation("historical", { tokens: 500 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not treat missing prices as a zero-cost model invocation", async () => {
    const priced = await setup().open();
    expect(
      (await priced.quote(operation("unpriced-llm", { tokens: 1, modelCalls: 1 }))).reason,
    ).toBe("COST_UNKNOWN");
    const externalBudget = await setup({ limits: { tokens: 1_000 } }).open();
    await externalBudget.reserve(
      "external-priced",
      operation("request", { tokens: 100, modelCalls: 1 }, { costStatus: "UNPRICED" }),
    );
    await externalBudget.admit("external-priced");
    await externalBudget.settle(
      "external-priced",
      { tokens: 80, modelCalls: 1 },
      { costStatus: "UNPRICED" },
    );
    expect((await externalBudget.snapshot()).unpricedOperationIds).toEqual(["external-priced"]);
  });

  it("fails closed before dispatch if durable CAS repeatedly conflicts", async () => {
    const fixture = setup();
    const first = await fixture.open();
    const broken: BudgetLedgerStore = {
      get: (id) => fixture.store.get(id),
      compareAndSwap: async () => false,
    };
    const scheduler = await ResourceBudgetScheduler.open({ ...fixture.options, store: broken });
    await expect(
      scheduler.reserve("request", operation("llm", { tokens: 10 })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await first.snapshot()).reservations).toEqual({});
  });

  it("never accepts a different operation plan under a previously used identity", async () => {
    const scheduler = await setup().open();
    await scheduler.reserve("request", operation("first", { tokens: 100 }));
    await expect(
      scheduler.reserve("request", operation("first", { tokens: 101 })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await scheduler.release("request", "branch no longer selected");
    expect((await scheduler.quote(operation("next", { tokens: 1_000 }))).fits).toBe(true);
    expect((await scheduler.admit("request")).reason).toBe("RELEASED");
  });
});
