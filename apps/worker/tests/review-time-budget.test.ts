import { afterEach, expect, it, vi } from "vitest";
import {
  restoredWorkflowTiming,
  reviewTimeReserve,
  finalValidationReviewTimePlan,
  codingTimePathPlan,
  codingReplanReachable,
} from "../src/runs/review-time-budget.js";
import {
  estimateOperationPlan,
  ResourceBudgetScheduler,
  type ResourceBudgetOperationPlan,
} from "../src/runs/resource-budget-scheduler.js";
import { InMemoryBudgetLedgerStore } from "@devflow/database";
import { loadWorkerEnvironment } from "../src/config/env.js";
import { WorkflowBudgetLedger } from "../src/runs/workflow-budget.js";
afterEach(() => vi.useRealTimers());
it("restores absolute deadlines even after downtime and a larger configuration", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const old = { deadlineAt: new Date(1_040_000).toISOString(), limits: { timeoutMs: 900_000 } };
  const t = restoredWorkflowTiming([old], Date.now(), 50, 1_500_000);
  const ledger = new WorkflowBudgetLedger({ ...t, maxSteps: 25, maxReviewRetries: 1 });
  expect(ledger.remainingTimeMs).toBe(40_000);
  vi.advanceTimersByTime(45_000);
  expect(ledger.remainingTimeMs).toBe(0);
  const resumed = restoredWorkflowTiming([old], Date.now(), 50, 1_500_000);
  expect(resumed.deadlineAt).toBe(1_040_000);
});
it("honors a shorter explicit task deadline without extending a saved expiry", () => {
  const saved = { deadlineAt: new Date(1_500_000).toISOString(), limits: { timeoutMs: 900_000 } };
  expect(restoredWorkflowTiming([saved], 1_000_000, 0, 1_500_000, 600_000).deadlineAt).toBe(
    1_200_000,
  );
  expect(restoredWorkflowTiming([saved], 1_000_000, 0, 1_500_000, 1_800_000).deadlineAt).toBe(
    1_500_000,
  );
  const first = restoredWorkflowTiming([saved], 1_000_000, 0, 1_500_000, 1_800_000);
  const resumed = restoredWorkflowTiming(
    [
      {
        deadlineAt: new Date(first.deadlineAt).toISOString(),
        limits: { timeoutMs: first.timeoutMs },
      },
    ],
    1_010_000,
    0,
    1_500_000,
  );
  expect(resumed).toEqual(first);
  expect(restoredWorkflowTiming([], 1_000_000, 1000, 1_500_000, 60_000).deadlineAt).toBe(1_059_000);
});
it("releases only unavailable recovery credit while retaining request and finalization time", () => {
  const env = loadWorkerEnvironment({ DATABASE_URL: "test" });
  expect(reviewTimeReserve(env, 1)).toBe(480_000);
  expect(reviewTimeReserve(env, 2)).toBe(270_000);
});

const replanTime: ResourceBudgetOperationPlan = {
  kind: "SEQUENCE",
  id: "replan:time",
  operations: [
    {
      kind: "OPERATION",
      id: "planner:shared-phase-deadline",
      requirement: "REQUIRED",
      state: "PENDING",
      resources: { timeMs: 180_000 },
    },
    {
      kind: "OPERATION",
      id: "coding:resume",
      requirement: "REQUIRED",
      state: "PENDING",
      resources: { timeMs: 60_000 },
    },
  ],
};
it("replays the frozen time rejection without deleting reachable validation, Review or Replan", async () => {
  const env = loadWorkerEnvironment({ DATABASE_URL: "test" });
  const plan = codingTimePathPlan({
    sharedFinal: finalValidationReviewTimePlan(env, true),
    replan: replanTime,
  });
  const estimate = estimateOperationPlan(plan);
  expect(estimate.resources.timeMs).toBe(1_020_000);
  expect(estimate.operations.map((row) => row.id)).toEqual([
    "validation:shared-profile-deadline",
    "review:normal-request",
    "review:available-output-recovery",
    "workflow:finalize",
    "planner:shared-phase-deadline",
    "coding:resume",
  ]);
  const scheduler = await ResourceBudgetScheduler.open({
    runId: "frozen-time-replay",
    store: new InMemoryBudgetLedgerStore(),
    startedAt: 0,
    deadlineAt: 1_500_000,
    limits: { timeMs: 1_500_000 },
    clock: () => 423_993,
  });
  const current: ResourceBudgetOperationPlan = {
    kind: "SEQUENCE",
    id: "request-and-downstream",
    operations: [
      {
        kind: "OPERATION",
        id: "current:request",
        requirement: "REQUIRED",
        state: "PENDING",
        resources: { timeMs: 60_000 },
      },
      plan,
    ],
  };
  const quote = await scheduler.quote(current);
  expect(quote.fits).toBe(false);
  expect(quote.shortfalls.timeMs).toBe(3993);
  expect((await scheduler.snapshot()).consumed.timeMs).toBe(0);
});
it("omits only an exhausted recovery or an unreachable replan, and retains sequential work", () => {
  const env = loadWorkerEnvironment({ DATABASE_URL: "test" });
  const usedRecovery = codingTimePathPlan({
    sharedFinal: finalValidationReviewTimePlan(env, false),
    replan: replanTime,
  });
  expect(estimateOperationPlan(usedRecovery).resources.timeMs).toBe(810_000);
  const submission = codingTimePathPlan({
    sharedFinal: finalValidationReviewTimePlan(env, true),
    replan: replanTime,
    submitCurrent: true,
  });
  expect(estimateOperationPlan(submission).resources.timeMs).toBe(780_000);
  expect(codingReplanReachable(false, 2, 3)).toBe(true);
  expect(codingReplanReachable(false, 3, 3)).toBe(false);
  expect(codingReplanReachable(false, 0, 0)).toBe(false);
  expect(codingReplanReachable(true, 0, 3)).toBe(false);
});
