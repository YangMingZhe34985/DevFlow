import type { BenchmarkCase, IntegrityManifest, IntegrityObservation } from "./contracts.js";
import { benchmarkDefinitionDigest } from "./canonical.js";

export interface IntegrityVerification {
  passed: boolean;
  violations: readonly string[];
}

export function createIntegrityManifest(testCase: BenchmarkCase): IntegrityManifest {
  return {
    definitionDigest: benchmarkDefinitionDigest(testCase),
    expectedBaseCommit: testCase.repository.baseCommit,
    protectedPaths: testCase.rules.protectedPaths,
  };
}

export function verifyIntegrity(
  manifest: IntegrityManifest,
  observation: IntegrityObservation,
  requireIsolatedEvaluation: boolean,
): IntegrityVerification {
  const violations: string[] = [];
  if (observation.observedBaseCommit !== manifest.expectedBaseCommit) {
    violations.push(
      "The evaluated repository base commit does not match the benchmark definition.",
    );
  }
  if (observation.definitionDigest !== manifest.definitionDigest) {
    violations.push("The benchmark definition changed during execution.");
  }
  if (requireIsolatedEvaluation && !observation.evaluationIsolated) {
    violations.push("The evaluation command did not run in the trusted isolated evaluator.");
  }

  const observedByPath = new Map(observation.protectedPaths.map((file) => [file.path, file]));
  for (const expected of manifest.protectedPaths) {
    const observed = observedByPath.get(expected.path);
    if (observed === undefined) {
      violations.push(`Protected path '${expected.path}' was not verified.`);
      continue;
    }
    if (observed.sha256Before !== expected.sha256) {
      violations.push(`Protected path '${expected.path}' did not start with its expected content.`);
    }
    if (observed.sha256After !== expected.sha256) {
      violations.push(`Protected path '${expected.path}' was modified by the Agent run.`);
    }
  }

  return { passed: violations.length === 0, violations };
}
