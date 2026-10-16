import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildExecutionRequest } from "../src/index.js";
import { benchmarkCase } from "./test-helpers.js";

describe("buildExecutionRequest", () => {
  it("keeps hidden evaluator inputs out of the Agent-visible request", () => {
    const testCase = benchmarkCase();
    const executionId = randomUUID();
    const request = buildExecutionRequest(testCase, executionId);
    expect(request.agent).toEqual({
      executionId,
      repository: testCase.repository,
      task: testCase.task,
      limits: testCase.limits,
    });
    expect(request.agent).not.toHaveProperty("evaluationCommand");
    expect(request.agent).not.toHaveProperty("rules");
    expect(request.evaluation).toHaveProperty("evaluationCommand");
    expect(request.evaluation.integrity).toBeDefined();
  });
});
