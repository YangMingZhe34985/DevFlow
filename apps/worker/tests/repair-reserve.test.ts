import { expect, it } from "vitest";
import { repairContinuationReserve } from "../src/runs/repair-reserve.js";
import { estimateOperationPlan } from "../src/runs/resource-budget-scheduler.js";
const input = {
  title: "Invalidate policy cache",
  description: "Public invalidation requirement",
  plan: {},
  diagnostics: [{ kind: "ASSERTION", path: "src/listener.java", line: 40 }],
  source: "class Listener {}",
  repairOutput: 16384,
  reviewOutput: 16384,
  includeRepair: true,
  reviewRecoveryAvailable: true,
};
it("transfers between mutually exclusive branches without charging reservations as consumption", () => {
  const replan = repairContinuationReserve(input);
  const current = repairContinuationReserve({ ...input, includeRepair: false });
  expect(replan.total - current.total).toBe(replan.repair);
  expect(replan.total).toBe(replan.repair + replan.review + replan.recovery);
  const spent = repairContinuationReserve({ ...input, reviewRecoveryAvailable: false });
  expect(replan.total - spent.total).toBe(replan.recovery);
  expect(spent.accounting).toBe("RESERVE_ONLY_RECHECK_ACTUAL_REQUEST");
});
it("uses configured output caps and serialized source size, preserving a separate downstream estimate", () => {
  const initial = repairContinuationReserve(input);
  const larger = repairContinuationReserve({ ...input, source: "多字节源码".repeat(4000) });
  expect(larger.total).toBeGreaterThan(initial.total);
  expect(repairContinuationReserve({ ...input, repairOutput: 32768 }).total - initial.total).toBe(
    16384,
  );
  expect(250000 - 118568 - initial.total).toBeGreaterThan(45231);
});

it("retains sequential Coding, Review and bounded recovery rather than taking their maximum", () => {
  const continuation = repairContinuationReserve(input);
  const projection = estimateOperationPlan(continuation.operationPlan);
  expect(projection.resources).toMatchObject({
    tokens: continuation.total,
    modelCalls: 3,
    steps: 3,
  });
  const active = repairContinuationReserve({
    ...input,
    includeRepair: false,
    reviewRecoveryAvailable: false,
  });
  const activeProjection = estimateOperationPlan(active.operationPlan);
  expect(activeProjection.resources).toMatchObject({
    tokens: active.review,
    modelCalls: 1,
    steps: 1,
  });
  expect(
    activeProjection.operations.filter((operation) => operation.state === "COMPLETED"),
  ).toHaveLength(2);
});
