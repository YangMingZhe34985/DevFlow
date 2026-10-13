import { expect, it } from "vitest";
import { InMemoryBudgetLedgerStore } from "@devflow/database";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import { codingContinuationOperationPlan, codingReplanReserve } from "../src/runs/coding-budget.js";
import { localizationLease } from "../src/runs/localization-lease.js";
import {
  priceModelOperationPlan,
  ResourceBudgetRuntime,
} from "../src/runs/resource-budget-runtime.js";
import {
  estimateOperationPlan,
  ResourceBudgetScheduler,
  type ResourceBudgetOperationPlan,
} from "../src/runs/resource-budget-scheduler.js";

const solver = { inputMicrosPerMillionTokens: 8_000_000, outputMicrosPerMillionTokens: 28_000_000 };
const review = { inputMicrosPerMillionTokens: 9_000_000, outputMicrosPerMillionTokens: 27_000_000 };
const request = (
  id: string,
  inputTokens: number,
  outputTokens: number,
  calls = 1,
  timeMs = 0,
): ResourceBudgetOperationPlan => ({
  kind: "OPERATION",
  id,
  requirement: "REQUIRED",
  state: "PENDING",
  resources: { inputTokens, outputTokens, modelCalls: calls, steps: calls, timeMs },
});
const price = (plan: ResourceBudgetOperationPlan) =>
  priceModelOperationPlan(plan, (id) => (id.startsWith("review:") ? review : solver));

// Numeric projections only, extracted from the 2026-10-13 public Run trace.
// No task source, expected patch, scorer input or privileged answer is used.
it.each([
  {
    case: "E02",
    current: 12662,
    shared: 50761,
    planner: 40369,
    coding: 8253,
    remaining: 3156828,
    old: 3342772,
    tokens: 128429,
    tools: 15,
  },
  {
    case: "E05",
    current: 14741,
    shared: 55862,
    planner: 42104,
    coding: 9988,
    remaining: 3290640,
    old: 3599392,
    tokens: 139079,
    tools: 16,
  },
  {
    case: "E09",
    current: 11344,
    shared: 51331,
    planner: 40576,
    coding: 8460,
    remaining: 3183172,
    old: 3359780,
    tokens: 128095,
    tools: 15,
  },
])(
  "$case reprices the same mandatory path without removing a request, recovery or validation",
  async (f) => {
    const plan = price(
      codingContinuationOperationPlan({
        finalModels: request("review:normal-and-existing-recovery", f.shared - 32768, 32768, 2),
        validationAndFinalize: { timeMs: 780000, logicalToolCalls: f.tools },
        replan: {
          kind: "SEQUENCE",
          id: "replan",
          operations: [
            request("planner:current-projection-and-recovery", f.planner - 16384, 16384, 2, 180000),
            request("coding:resumed-decision", f.coding, 8192, 1, 60000),
          ],
        },
        submitCurrent: false,
      }),
    );
    const future = estimateOperationPlan(plan);
    const full: ResourceBudgetOperationPlan = {
      kind: "SEQUENCE",
      id: "request-and-continuation",
      operations: [price(request("coding:actual", f.current, 8192, 1, 60000)), plan],
    };
    const projected = estimateOperationPlan(full);
    expect(projected.resources.tokens).toBe(f.tokens);
    expect(projected.resources.timeMs).toBe(1080000);
    expect(projected.resources.modelCalls).toBe(6);
    expect(projected.resources.costMicros).toBeLessThan(f.remaining);
    expect(f.old).toBeGreaterThan(f.remaining);
    const scheduler = await ResourceBudgetScheduler.open({
      runId: f.case,
      store: new InMemoryBudgetLedgerStore(),
      startedAt: 0,
      deadlineAt: 1500000,
      clock: () => 0,
      limits: { costMicros: 4000000, tokens: 320000, steps: 32, logicalToolCalls: 75 },
      initialConsumed: { costMicros: 4000000 - f.remaining },
    });
    expect((await scheduler.quote(full)).fits).toBe(true);
    expect((await scheduler.snapshot()).consumed.costMicros).toBe(4000000 - f.remaining);
    const submitted = price(
      codingContinuationOperationPlan({
        finalModels: request("review:normal-and-existing-recovery", f.shared - 32768, 32768, 2),
        validationAndFinalize: { timeMs: 780000, logicalToolCalls: f.tools },
        replan: plan,
        submitCurrent: true,
      }),
    );
    expect(estimateOperationPlan(submitted).resources.tokens).toBe(f.shared);
    expect(future.resources.tokens).toBe(f.tokens - f.current - 8192);
  },
);

it("keeps Planner output recovery's exact token split under its single phase deadline", () => {
  const result = codingReplanReserve({
    plannerContext: { task: "Public task" },
    plannerOutputTokens: 8192,
    plannerInputGrowthTokens: 2048,
    plannerTimeoutMs: 180000,
    codingMessages: [{ role: "USER", content: "Current plan and source" }],
    codingTools: [],
    codingOutputTokens: 8192,
    codingInputGrowthTokens: 4096,
    codingTimeoutMs: 60000,
  });
  const plan = estimateOperationPlan(result.operationPlan);
  const planner = plan.operations[0]!;
  expect(planner.resources.inputTokens + planner.resources.outputTokens).toBe(
    planner.resources.tokens,
  );
  expect(planner.resources.outputTokens).toBe(16384);
  expect(plan.resources.timeMs).toBe(240000);
  const lease = localizationLease({
    dynamic: true,
    remainingTokens: 320000,
    title: "Task",
    description: "Public requirements",
    evidence: [],
    outputs: { localization: 8192, planner: 8192, execute: 8192, repair: 8192, review: 16384 },
    deadlines: {
      planner: 180000,
      coding: 60000,
      validation: 300000,
      review: 240000,
      recovery: 210000,
      finalize: 30000,
    },
  });
  const downstream = estimateOperationPlan(lease.downstreamOperationPlan);
  expect(downstream.resources.timeMs).toBe(1080000);
  expect(downstream.resources.modelCalls).toBe(6);
  expect(
    downstream.operations.find((op) => op.id === "planner:existing-recovery")?.resources,
  ).toMatchObject({ modelCalls: 1, outputTokens: 8192, timeMs: 0 });
});

it("shares one closing Coordinator hold across investigators and transfers it without consumption", async () => {
  const scheduler = await ResourceBudgetScheduler.open({
    runId: "closing",
    store: new InMemoryBudgetLedgerStore(),
    limits: { tokens: 320000, steps: 32, costMicros: 4000000, logicalToolCalls: 75 },
    startedAt: 0,
    deadlineAt: 1500000,
    clock: () => 0,
    initialConsumed: { tokens: 128000, costMicros: 1000000 },
  });
  const downstream = request("review:future", 70000, 45000, 6, 1080000);
  const closing = request("coordinator:closing", 23000, 8192, 1, 180000);
  const hold = price({
    kind: "SEQUENCE",
    id: "closing-and-downstream",
    operations: [downstream, closing],
  });
  expect((await scheduler.replaceHold("shared", hold)).reserved).toBe(true);
  expect((await scheduler.replaceHold("shared", hold)).reserved).toBe(true);
  const investigator = price(request("investigator:optional", 43000, 8192));
  const denied = await scheduler.quote(investigator);
  expect(denied.fits).toBe(false);
  expect(denied.shortfalls.tokens).toBeGreaterThan(0);
  expect((await scheduler.snapshot()).consumed.tokens).toBe(128000);
  expect((await scheduler.replaceHold("shared", price(downstream))).reserved).toBe(true);
  expect((await scheduler.reserve("actual-coordinator", price(closing))).reserved).toBe(true);
  expect((await scheduler.admit("actual-coordinator")).admitted).toBe(true);
});

it.each([
  {
    case: "E06",
    remainingTokens: 27590,
    requiredTokens: 30554,
    remainingCost: 291229,
    requiredCost: 408272,
    missingTokens: 2964,
    missingCost: 117043,
  },
  {
    case: "E08",
    remainingTokens: 24476,
    requiredTokens: 29615,
    remainingCost: 269139,
    requiredCost: 400760,
    missingTokens: 5139,
    missingCost: 131621,
  },
])(
  "$case frozen late state remains honestly insufficient; protection must start before optional investigation",
  async (f) => {
    const scheduler = await ResourceBudgetScheduler.open({
      runId: f.case,
      store: new InMemoryBudgetLedgerStore(),
      limits: { tokens: 320000, costMicros: 4000000 },
      startedAt: 0,
      deadlineAt: 1500000,
      clock: () => 0,
      initialConsumed: {
        tokens: 320000 - f.remainingTokens,
        costMicros: 4000000 - f.remainingCost,
      },
    });
    const result = await scheduler.reserve("closing", {
      kind: "OPERATION",
      id: "closing",
      requirement: "REQUIRED",
      state: "PENDING",
      resources: { tokens: f.requiredTokens, costMicros: f.requiredCost },
      costStatus: "PRICED",
    });
    expect(result.reserved).toBe(false);
    expect(result.quote.shortfalls).toMatchObject({
      tokens: f.missingTokens,
      costMicros: f.missingCost,
    });
    expect(Object.keys((await scheduler.snapshot()).reservations)).toHaveLength(0);
  },
);

it("uses explicit continuation pricing at dispatch; unknown pricing cannot use the legacy fallback", async () => {
  const scheduler = await ResourceBudgetScheduler.open({
    runId: "runtime",
    store: new InMemoryBudgetLedgerStore(),
    limits: { costMicros: 500000 },
    startedAt: Date.now(),
    deadlineAt: Date.now() + 1500000,
  });
  const events: unknown[] = [];
  const runtime = new ResourceBudgetRuntime(scheduler, async (e) => {
    events.push(e);
  });
  const raw = new FakeLanguageModel([
    fakeModelResponse({
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    }),
  ]);
  const model = runtime.model(raw, {
    stage: "EXECUTE",
    timeoutMs: 1000,
    outputTokens: 8192,
    price: solver,
    continuationMicrosPerMillionTokens: 28000000,
  });
  const req = {
    messages: [{ role: "USER" as const, content: "Same current evidence" }],
    tools: [],
    settings: { maxOutputTokens: 8192 },
    resourceContinuation: {
      tokens: 10000,
      costMicros: 80000,
      costStatus: "PRICED" as const,
      modelCalls: 1,
      audit: { stage: "PLANNER", inputTokens: 10000, outputTokens: 0 },
    },
  };
  await model.generate(req, { signal: new AbortController().signal });
  expect(raw.requests).toHaveLength(1);
  expect((await scheduler.snapshot()).consumed.costMicros).toBe(136);
  expect(JSON.stringify(events)).toContain("CONTINUATION_PROJECTION");
  await expect(
    model.generate(
      { ...req, resourceContinuation: { ...req.resourceContinuation, costStatus: "UNPRICED" } },
      { signal: new AbortController().signal },
    ),
  ).rejects.toMatchObject({
    details: { requestIssued: false, diagnostics: { reason: "COST_UNKNOWN" } },
  });
  expect(raw.requests).toHaveLength(1);
  await expect(
    runtime.checkContinuation(
      { tokens: 1000, costMicros: 0, costStatus: "UNPRICED" },
      "diagnostic:unpriced-next-decision",
    ),
  ).rejects.toMatchObject({
    details: { requestIssued: false, diagnostics: { reason: "COST_UNKNOWN" } },
  });
});
