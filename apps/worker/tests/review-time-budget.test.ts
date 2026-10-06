import { afterEach, expect, it, vi } from "vitest";
import { restoredWorkflowTiming, reviewTimeReserve } from "../src/runs/review-time-budget.js";
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
