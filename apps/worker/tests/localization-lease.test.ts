import { expect, it } from "vitest";
import { localizationLease } from "../src/runs/localization-lease.js";
import { estimateOperationPlan } from "../src/runs/resource-budget-scheduler.js";
const input = {
  remainingTokens: 250000,
  title: "Read behavior",
  description: "Public task",
  evidence: [],
  outputs: { localization: 4096, planner: 16384, execute: 8192, repair: 16384, review: 16384 },
};
it("uses actual output settings, includes downstream once and exposes growth separately", () => {
  const lease = localizationLease(input);
  expect(lease.maxTokens).toBeGreaterThan(18000);
  expect(lease.maxTokens + lease.downstream).toBeLessThanOrEqual(input.remainingTokens);
  expect(lease.explorationAffordable).toBe(true);
  expect(lease.growthAllowance).toBeGreaterThan(0);
  expect(
    localizationLease({ ...input, outputs: { ...input.outputs, review: 32768 } }).downstream -
      lease.downstream,
  ).toBe(32768);
});
it("refuses an underfunded downstream and increases the input projection with real evidence", () => {
  expect(localizationLease({ ...input, remainingTokens: 10000 }).maxTokens).toBe(0);
  const bigger = localizationLease({
    ...input,
    evidence: [{ snippet: "observed code\n".repeat(500) }],
  });
  expect(bigger.serializedInput).toBeGreaterThan(localizationLease(input).serializedInput);
});

it("reserves one failure decision in the unified Coding session without the retired Repair model", () => {
  const lease = localizationLease(input);
  const changedLegacyRepair = localizationLease({
    ...input,
    outputs: { ...input.outputs, repair: 65536 },
  });
  expect(changedLegacyRepair.downstream).toBe(lease.downstream);
  expect(changedLegacyRepair.maxTokens).toBe(lease.maxTokens);
  const downstream = estimateOperationPlan(lease.downstreamOperationPlan);
  const coding = downstream.operations.filter(
    (operation) => operation.id.startsWith("coding:") && operation.state === "PENDING",
  );
  expect(coding.map((operation) => operation.id)).toEqual([
    "coding:initial",
    "coding:failure-decision",
  ]);
  expect(
    coding.every((operation) => operation.resources.outputTokens === input.outputs.execute),
  ).toBe(true);
  expect(downstream.resources.modelCalls).toBe(6); // Planner + recovery, Coding + failure, Review + recovery.
  expect(estimateOperationPlan(lease.localizationOperationPlan).resources.modelCalls).toBe(4);
  const largerCoding = localizationLease({
    ...input,
    outputs: { ...input.outputs, execute: 16384 },
  });
  expect(largerCoding.downstream - lease.downstream).toBe(2 * (16384 - input.outputs.execute));
  expect(localizationLease({ ...input, remainingTokens: lease.downstream }).maxTokens).toBe(0);
});
