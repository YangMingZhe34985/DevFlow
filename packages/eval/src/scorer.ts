import {
  BenchmarkCaseSchema,
  BenchmarkExecutionProfileSchema,
  EvaluationObservationSchema,
  EvaluationResultSchema,
  PricingConfigurationSchema,
  type BenchmarkCase,
  type BenchmarkExecutionProfile,
  type EvaluationObservation,
  type EvaluationProvenance,
  type EvaluationResult,
  type PricingConfiguration,
} from "./contracts.js";
import { benchmarkDefinitionDigest } from "./canonical.js";
import { createIntegrityManifest, verifyIntegrity } from "./integrity.js";
import { estimateCostUsd } from "./pricing.js";

export interface ScoreEvaluationOptions {
  suite: { id: string; version: string };
  executionId: string;
  profile: BenchmarkExecutionProfile;
  pricing: PricingConfiguration;
  startedAt: string;
  finishedAt: string;
}

export function scoreEvaluation(
  testCaseInput: BenchmarkCase,
  observationInput: EvaluationObservation,
  options: ScoreEvaluationOptions,
): EvaluationResult {
  const testCase = BenchmarkCaseSchema.parse(testCaseInput);
  const observation = EvaluationObservationSchema.parse(observationInput);
  const profile = BenchmarkExecutionProfileSchema.parse(options.profile);
  const pricing = PricingConfigurationSchema.parse(options.pricing);
  const manifest = createIntegrityManifest(testCase);
  const integrity = verifyIntegrity(
    manifest,
    observation.integrity,
    testCase.rules.requireIsolatedEvaluation,
  );
  const evaluationFailures = evaluationRuleFailures(testCase, observation);
  const evaluationPassed = evaluationFailures.length === 0;
  const testPassed = observation.workflow.testPassed;
  const success =
    observation.run.status === "SUCCEEDED" && testPassed && evaluationPassed && integrity.passed;
  const failureReasons = [
    ...(observation.run.status === "SUCCEEDED"
      ? []
      : [`Run ended with status ${observation.run.status}.`]),
    ...(testPassed ? [] : ["The workflow test stage did not pass."]),
    ...evaluationFailures,
    ...integrity.violations,
  ];
  const estimatedCostUsd = estimateCostUsd(
    pricing,
    profile.model.provider,
    profile.model.name,
    observation.run.metrics.tokenUsage,
  );
  const definitionDigest = benchmarkDefinitionDigest(testCase);
  const provenance: EvaluationProvenance = {
    schemaVersion: 1,
    executionId: options.executionId,
    suite: options.suite,
    benchmark: {
      id: testCase.id,
      version: testCase.version,
      definitionDigest,
    },
    repository: testCase.repository,
    task: testCase.task,
    ...(testCase.setupCommand === undefined ? {} : { setupCommand: testCase.setupCommand }),
    evaluationCommand: testCase.evaluationCommand,
    evaluationRules: testCase.rules,
    expectedOutcome: testCase.expectedOutcome,
    model: profile.model,
    runtime: profile.runtime,
    tools: profile.tools,
    sandboxLimits: testCase.limits,
    pricingVersion: pricing.version,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
  };

  return EvaluationResultSchema.parse({
    schemaVersion: 1,
    suiteId: options.suite.id,
    caseId: testCase.id,
    executionId: options.executionId,
    runId: observation.run.runId,
    runStatus: observation.run.status,
    success,
    testPassed,
    evaluationPassed,
    integrityPassed: integrity.passed,
    expectedOutcomeMatched: expectedOutcomeMatched(testCase, observation, success),
    evaluation: observation.evaluation,
    metrics: {
      steps: observation.run.metrics.steps,
      toolCalls: observation.run.metrics.toolCalls,
      modelCalls: observation.run.metrics.modelCalls,
      inputTokens: observation.run.metrics.tokenUsage.inputTokens,
      outputTokens: observation.run.metrics.tokenUsage.outputTokens,
      totalTokens: observation.run.metrics.tokenUsage.totalTokens,
      estimatedCostUsd,
      modelLatencyMs: observation.run.metrics.modelLatencyMs,
      toolLatencyMs: observation.run.metrics.toolLatencyMs,
      evaluationLatencyMs: observation.evaluation.durationMs,
      totalLatencyMs: observation.totalLatencyMs,
      retries: observation.run.metrics.retries,
      repairAttempts: observation.workflow.repairAttempts,
      reviewRetries: observation.workflow.reviewRetries,
    },
    provenance,
    failureReasons,
  });
}

function evaluationRuleFailures(
  testCase: BenchmarkCase,
  observation: EvaluationObservation,
): string[] {
  if (observation.evaluation.timedOut) return ["Evaluation command timed out."];
  const failures: string[] = [];
  if (
    observation.evaluation.exitCode === null ||
    !testCase.rules.acceptedExitCodes.includes(observation.evaluation.exitCode)
  ) {
    failures.push(
      `Evaluation exit code ${String(observation.evaluation.exitCode)} is not accepted.`,
    );
  }
  for (const expected of testCase.rules.requiredStdout) {
    if (!observation.evaluation.stdout.includes(expected)) {
      failures.push(`Evaluation stdout did not contain required text '${expected}'.`);
    }
  }
  for (const forbidden of testCase.rules.forbiddenStdout) {
    if (observation.evaluation.stdout.includes(forbidden)) {
      failures.push(`Evaluation stdout contained forbidden text '${forbidden}'.`);
    }
  }
  return failures;
}

function expectedOutcomeMatched(
  testCase: BenchmarkCase,
  observation: EvaluationObservation,
  success: boolean,
): boolean {
  switch (testCase.expectedOutcome) {
    case "PASS":
      return success;
    case "FAIL":
      return (
        !success &&
        !observation.evaluation.timedOut &&
        observation.run.status !== "TIMED_OUT" &&
        observation.integrity.evaluationIsolated &&
        observation.integrity.definitionDigest === benchmarkDefinitionDigest(testCase) &&
        observation.integrity.observedBaseCommit.toLowerCase() ===
          testCase.repository.baseCommit.toLowerCase()
      );
    case "TIMEOUT":
      return observation.evaluation.timedOut || observation.run.status === "TIMED_OUT";
  }
}
