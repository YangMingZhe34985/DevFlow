import { expect, it } from "vitest";
import { InMemoryBudgetLedgerStore } from "@devflow/database";
import { localizationLease } from "../src/runs/localization-lease.js";
import { priceModelOperationPlan } from "../src/runs/resource-budget-runtime.js";
import {
  estimateOperationPlan,
  ResourceBudgetScheduler,
} from "../src/runs/resource-budget-scheduler.js";

const coding = { inputMicrosPerMillionTokens: 8000000, outputMicrosPerMillionTokens: 28000000 };
const review = { inputMicrosPerMillionTokens: 9000000, outputMicrosPerMillionTokens: 27000000 };
const plan = localizationLease({
  dynamic: true,
  remainingTokens: 320000,
  title: "Cache fails to refresh",
  description: "Preserve public consumers after a change",
  evidence: [{ snippet: "export function refresh() { return cache; }\n".repeat(300) }],
  outputs: { localization: 8192, planner: 8192, execute: 8192, repair: 8192, review: 16384 },
}).downstreamOperationPlan;

it("prices future input/output by each role while preserving all model, recovery and validation operations", () => {
  const before = estimateOperationPlan(plan);
  const after = estimateOperationPlan(
    priceModelOperationPlan(plan, (id) => (id.startsWith("review:") ? review : coding)),
  );
  expect(after.operations.map((op) => [op.id, op.state])).toEqual(
    before.operations.map((op) => [op.id, op.state]),
  );
  expect(after.resources).toMatchObject({
    tokens: before.resources.tokens,
    modelCalls: 6,
    steps: 6,
  });
  const expected = before.operations
    .filter((op) => op.state === "PENDING")
    .reduce((total, op) => {
      const price = op.id.startsWith("review:") ? review : coding;
      return (
        total +
        Math.ceil(
          (op.resources.inputTokens * price.inputMicrosPerMillionTokens +
            op.resources.outputTokens * price.outputMicrosPerMillionTokens) /
            1000000,
        )
      );
    }, 0);
  expect(after.resources.costMicros).toBe(expected);
  expect(expected).toBeLessThan(before.resources.tokens * 28);
});

it("denies unknown role pricing and real insufficient funds, with durable diagnostic and no consumption reset", async () => {
  const store = new InMemoryBudgetLedgerStore();
  const options = {
    runId: "priced-run",
    store,
    limits: { costMicros: 4000000 },
    startedAt: 1000,
    deadlineAt: 1501000,
    clock: () => 1000,
  };
  const scheduler = await ResourceBudgetScheduler.open(options);
  const priced = priceModelOperationPlan(plan, (id) =>
    id.startsWith("review:") ? review : coding,
  );
  expect((await scheduler.replaceHold("downstream", priced)).reserved).toBe(true);
  const held = (await scheduler.snapshot()).reservations.downstream;
  const unknown = await scheduler.replaceHold(
    "downstream",
    priceModelOperationPlan(plan, (id) => (id.startsWith("review:") ? undefined : coding)),
  );
  expect(unknown.reserved).toBe(false);
  expect(unknown.quote.reason).toBe("COST_UNKNOWN");
  const expensive = await scheduler.replaceHold(
    "downstream",
    priceModelOperationPlan(plan, () => ({ ...coding, outputMicrosPerMillionTokens: 100000000 })),
  );
  expect(expensive.reserved).toBe(false);
  expect(expensive.quote.shortfalls.costMicros).toBeGreaterThan(0);
  const resumed = await ResourceBudgetScheduler.open(options);
  const state = await resumed.snapshot();
  expect(state.reservations.downstream).toEqual(held);
  expect(state.lastDecision?.quote).toEqual(expensive.quote);
  expect(state.consumed.costMicros).toBe(0);
});

it("never silently prices an unsplit token aggregate as a free request", () => {
  const result = estimateOperationPlan(
    priceModelOperationPlan(
      {
        kind: "OPERATION",
        id: "unsplit",
        state: "PENDING",
        requirement: "REQUIRED",
        resources: { tokens: 1000, modelCalls: 1 },
      },
      () => coding,
    ),
  );
  expect(result.unpricedOperationIds).toEqual(["unsplit"]);
});
