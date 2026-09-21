import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { scoreEvaluation, sha256 } from "../src/index.js";
import {
  FIXED_TIME,
  benchmarkCase,
  executionProfile,
  observation,
  pricingConfiguration,
} from "./test-helpers.js";

describe("scoreEvaluation", () => {
  it("scores run, test, isolated evaluation and all requested metrics", () => {
    const testCase = benchmarkCase();
    const executionId = randomUUID();
    const result = scoreEvaluation(testCase, observation(testCase), {
      suite: { id: "suite", version: "1" },
      executionId,
      profile: executionProfile(),
      pricing: pricingConfiguration(),
      startedAt: FIXED_TIME,
      finishedAt: FIXED_TIME,
    });

    expect(result).toMatchObject({
      success: true,
      testPassed: true,
      evaluationPassed: true,
      integrityPassed: true,
      expectedOutcomeMatched: true,
      metrics: {
        steps: 4,
        modelCalls: 3,
        toolCalls: 5,
        inputTokens: 1_000,
        outputTokens: 500,
        totalTokens: 1_500,
        estimatedCostUsd: "0.00600000",
        retries: 1,
        repairAttempts: 1,
        reviewRetries: 0,
      },
      provenance: {
        executionId,
        pricingVersion: "pricing-2026-09",
        repository: { baseCommit: testCase.repository.baseCommit },
      },
    });
  });

  it("rejects a forged pass when a protected evaluation path changed", () => {
    const originalHash = sha256("original test");
    const testCase = benchmarkCase("adversarial", {
      protectedPath: { path: "test/visible.test.mjs", sha256: originalHash },
    });
    const result = scoreEvaluation(
      testCase,
      observation(testCase, { protectedAfter: sha256("test.skip()") }),
      options(),
    );

    expect(result.success).toBe(false);
    expect(result.evaluationPassed).toBe(true);
    expect(result.integrityPassed).toBe(false);
    expect(result.expectedOutcomeMatched).toBe(false);
    expect(result.failureReasons).toContain(
      "Protected path 'test/visible.test.mjs' was modified by the Agent run.",
    );
  });

  it("requires workflow tests as well as the hidden evaluator", () => {
    const testCase = benchmarkCase();
    const result = scoreEvaluation(
      testCase,
      observation(testCase, { testPassed: false }),
      options(),
    );

    expect(result.success).toBe(false);
    expect(result.expectedOutcomeMatched).toBe(false);
    expect(result.failureReasons).toContain("The workflow test stage did not pass.");
  });

  it("matches an expected failure against the complete benchmark outcome", () => {
    const testCase = benchmarkCase("expected-failure", { expectedOutcome: "FAIL" });
    const result = scoreEvaluation(
      testCase,
      observation(testCase, { runStatus: "FAILED", testPassed: false }),
      options(),
    );

    expect(result).toMatchObject({
      success: false,
      evaluationPassed: true,
      expectedOutcomeMatched: true,
    });
  });

  it("does not match expected FAIL when the trusted evaluator never ran", () => {
    const testCase = benchmarkCase("infrastructure-failure", { expectedOutcome: "FAIL" });
    const result = scoreEvaluation(
      testCase,
      observation(testCase, {
        runStatus: "FAILED",
        testPassed: false,
        evaluationIsolated: false,
      }),
      options(),
    );

    expect(result.expectedOutcomeMatched).toBe(false);
  });

  it("does not match expected FAIL for a forged evaluator definition", () => {
    const testCase = benchmarkCase("forged-definition", { expectedOutcome: "FAIL" });
    const result = scoreEvaluation(
      testCase,
      observation(testCase, {
        runStatus: "FAILED",
        testPassed: false,
        definitionDigest: "f".repeat(64),
      }),
      options(),
    );

    expect(result.expectedOutcomeMatched).toBe(false);
  });

  it("matches expected FAIL for adversarial integrity failure after trusted evaluation", () => {
    const originalHash = sha256("original test");
    const testCase = benchmarkCase("expected-adversarial", {
      expectedOutcome: "FAIL",
      protectedPath: { path: "test/protected.mjs", sha256: originalHash },
    });
    const result = scoreEvaluation(
      testCase,
      observation(testCase, { protectedAfter: sha256("tampered") }),
      options(),
    );

    expect(result).toMatchObject({
      success: false,
      integrityPassed: false,
      expectedOutcomeMatched: true,
    });
  });

  it("records an expected timeout without treating it as a successful repair", () => {
    const testCase = benchmarkCase("sandbox-timeout", { expectedOutcome: "TIMEOUT" });
    const result = scoreEvaluation(
      testCase,
      observation(testCase, {
        runStatus: "TIMED_OUT",
        exitCode: null,
        timedOut: true,
        testPassed: false,
      }),
      options(),
    );

    expect(result).toMatchObject({ success: false, expectedOutcomeMatched: true });
  });
});

function options() {
  return {
    suite: { id: "suite", version: "1" },
    executionId: randomUUID(),
    profile: executionProfile(),
    pricing: pricingConfiguration(),
    startedAt: FIXED_TIME,
    finishedAt: FIXED_TIME,
  };
}
