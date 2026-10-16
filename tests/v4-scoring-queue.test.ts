import { describe, expect, it } from "vitest";
import { serialScore } from "../scripts/v4/scoring-queue.js";

describe("hidden scoring mutex", () => {
  it("runs one evaluator at a time and releases after an error", async () => {
    let active = 0;
    let peak = 0;
    const score = (fail: boolean) =>
      serialScore(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (fail) throw new Error("scorer failed");
        return "PASS";
      });
    const results = await Promise.allSettled([score(true), score(false), score(false)]);
    expect(peak).toBe(1);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
  });
});
