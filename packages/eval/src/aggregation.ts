import type { EvaluationResult, SuiteMetrics } from "./contracts.js";
import { addUsd, averageUsd } from "./pricing.js";

export function aggregateSuiteMetrics(results: readonly EvaluationResult[]): SuiteMetrics {
  if (results.length === 0) throw new Error("Cannot aggregate an empty benchmark suite.");
  const successCount = results.filter((result) => result.success).length;
  const expectedOutcomeMatchCount = results.filter(
    (result) => result.expectedOutcomeMatched,
  ).length;
  const totalCost = addUsd(results.map((result) => result.metrics.estimatedCostUsd));

  return {
    caseCount: results.length,
    successCount,
    failureCount: results.length - successCount,
    successRate: successCount / results.length,
    expectedOutcomeMatchCount,
    expectedOutcomeMatchRate: expectedOutcomeMatchCount / results.length,
    steps: aggregate(results, "steps"),
    toolCalls: aggregate(results, "toolCalls"),
    modelCalls: aggregate(results, "modelCalls"),
    inputTokens: aggregate(results, "inputTokens"),
    outputTokens: aggregate(results, "outputTokens"),
    totalTokens: aggregate(results, "totalTokens"),
    estimatedCostUsd: {
      total: totalCost,
      average: averageUsd(totalCost, results.length),
    },
    modelLatencyMs: aggregate(results, "modelLatencyMs"),
    toolLatencyMs: aggregate(results, "toolLatencyMs"),
    evaluationLatencyMs: aggregate(results, "evaluationLatencyMs"),
    totalLatencyMs: aggregate(results, "totalLatencyMs"),
    retries: aggregate(results, "retries"),
    repairAttempts: aggregate(results, "repairAttempts"),
    reviewRetries: aggregate(results, "reviewRetries"),
  };
}

function aggregate(
  results: readonly EvaluationResult[],
  key: Exclude<keyof EvaluationResult["metrics"], "estimatedCostUsd">,
): { total: number; average: number } {
  const total = results.reduce((sum, result) => sum + result.metrics[key], 0);
  return { total, average: total / results.length };
}
