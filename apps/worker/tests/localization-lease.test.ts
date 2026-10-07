import { expect, it } from "vitest";
import { localizationLease } from "../src/runs/localization-lease.js";
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
