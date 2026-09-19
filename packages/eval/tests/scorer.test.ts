import { describe, expect, it } from "vitest";

import { scoreEvaluation, type EvaluationCase } from "../src/index.js";

const testCase: EvaluationCase = {
  id: "case-1",
  repository: { sourceUri: "https://example.invalid/repo.git", baseCommit: "abc123" },
  task: { title: "Fix test", description: "Make the failing test pass." },
  evaluationCommand: { program: "npm", args: ["test"] },
};

describe("scoreEvaluation", () => {
  it("requires both a successful run and passing evaluation", () => {
    const result = scoreEvaluation(testCase, {
      run: {
        runId: "run-1",
        status: "SUCCEEDED",
        metrics: {
          durationMs: 10,
          steps: 1,
          modelCalls: 1,
          toolCalls: 1,
          retries: 0,
          modelLatencyMs: 7,
          toolLatencyMs: 3,
          tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
      evaluationExitCode: 0,
      evaluationTimedOut: false,
    });

    expect(result).toMatchObject({
      caseId: "case-1",
      success: true,
      testPassed: true,
      metrics: { durationMs: 10, steps: 1, toolCalls: 1, retries: 0 },
    });
  });
});
