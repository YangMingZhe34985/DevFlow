import type { EvaluationCase, EvaluationObservation, EvaluationResult } from "./contracts.js";

export function scoreEvaluation(
  testCase: EvaluationCase,
  observation: EvaluationObservation,
): EvaluationResult {
  const testPassed = observation.evaluationExitCode === 0 && !observation.evaluationTimedOut;
  const success = observation.run.status === "SUCCEEDED" && testPassed;

  return {
    caseId: testCase.id,
    success,
    testPassed,
    metrics: observation.run.metrics,
    ...(success
      ? {}
      : {
          failureReason: observation.evaluationTimedOut
            ? "Evaluation command timed out."
            : `Run ended as ${observation.run.status}; evaluation exit code was ${String(observation.evaluationExitCode)}.`,
        }),
  };
}

// TODO(P11-eval): run hidden checks in the final sandbox, repeat cases, aggregate
// distributions, persist versioned results and compare model/runtime variants.
