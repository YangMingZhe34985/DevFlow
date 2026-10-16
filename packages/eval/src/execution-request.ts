import {
  BenchmarkCaseSchema,
  BenchmarkExecutionRequestSchema,
  type BenchmarkCase,
  type BenchmarkExecutionRequest,
} from "./contracts.js";
import { createIntegrityManifest } from "./integrity.js";

/** Splits a case into what the Agent may see and what only the trusted evaluator gets. */
export function buildExecutionRequest(
  testCaseInput: BenchmarkCase,
  executionId: string,
): BenchmarkExecutionRequest {
  const testCase = BenchmarkCaseSchema.parse(testCaseInput);
  return BenchmarkExecutionRequestSchema.parse({
    agent: {
      executionId,
      repository: testCase.repository,
      task: testCase.task,
      limits: testCase.limits,
    },
    evaluation: {
      ...(testCase.setupCommand === undefined ? {} : { setupCommand: testCase.setupCommand }),
      evaluationCommand: testCase.evaluationCommand,
      rules: testCase.rules,
      integrity: createIntegrityManifest(testCase),
    },
  });
}
