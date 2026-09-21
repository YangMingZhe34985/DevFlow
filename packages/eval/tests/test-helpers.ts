import { randomUUID } from "node:crypto";

import {
  BenchmarkCaseSchema,
  BenchmarkExecutionProfileSchema,
  BenchmarkSuiteSchema,
  PricingConfigurationSchema,
  benchmarkDefinitionDigest,
  type BenchmarkCase,
  type BenchmarkExecutionProfile,
  type BenchmarkSuite,
  type EvaluationObservation,
  type PricingConfiguration,
} from "../src/index.js";

export const FIXED_TIME = "2026-09-19T00:00:00.000Z";

export function benchmarkCase(
  id = "single-file",
  options: {
    expectedOutcome?: "PASS" | "FAIL" | "TIMEOUT";
    protectedPath?: { path: string; sha256: string };
  } = {},
): BenchmarkCase {
  return BenchmarkCaseSchema.parse({
    id,
    version: "1.0.0",
    repository: {
      sourceUri: `fixture://${id}`,
      baseCommit: caseCommit(id),
    },
    task: { title: `Fix ${id}`, description: `Repair the deterministic ${id} fixture.` },
    setupCommand: { program: "npm", args: ["install", "--ignore-scripts"] },
    evaluationCommand: { program: "node", args: ["evaluate.mjs"] },
    rules: {
      acceptedExitCodes: [0],
      requiredStdout: ["evaluation passed"],
      forbiddenStdout: ["forged"],
      protectedPaths: options.protectedPath === undefined ? [] : [options.protectedPath],
      requireIsolatedEvaluation: true,
    },
    expectedOutcome: options.expectedOutcome ?? "PASS",
    metadata: { fixtureClass: id },
  });
}

export function benchmarkSuite(cases: readonly BenchmarkCase[]): BenchmarkSuite {
  return BenchmarkSuiteSchema.parse({
    id: "deterministic-suite",
    version: "2026.09",
    cases,
  });
}

export function executionProfile(): BenchmarkExecutionProfile {
  return BenchmarkExecutionProfileSchema.parse({
    model: {
      provider: "fake",
      name: "deterministic-model",
      parameters: { temperature: 0, seed: 42 },
    },
    runtime: {
      version: "approval-workflow-v1",
      configuration: {},
    },
    tools: {
      version: "core-tools-v1",
      enabled: ["readFile", "writeFile", "runCommand"],
      policy: "benchmark",
      configuration: { network: false },
    },
  });
}

export function pricingConfiguration(): PricingConfiguration {
  return PricingConfigurationSchema.parse({
    version: "pricing-2026-09",
    entries: [
      {
        provider: "fake",
        model: "deterministic-model",
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 8,
      },
    ],
  });
}

export interface ObservationOptions {
  runId?: string;
  runStatus?: "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  exitCode?: number | null;
  timedOut?: boolean;
  stdout?: string;
  testPassed?: boolean;
  repairAttempts?: number;
  reviewRetries?: number;
  inputTokens?: number;
  outputTokens?: number;
  steps?: number;
  modelCalls?: number;
  toolCalls?: number;
  retries?: number;
  baseCommit?: string;
  definitionDigest?: string;
  evaluationIsolated?: boolean;
  protectedAfter?: string;
  totalLatencyMs?: number;
}

export function observation(
  testCase: BenchmarkCase,
  options: ObservationOptions = {},
): EvaluationObservation {
  const inputTokens = options.inputTokens ?? 1_000;
  const outputTokens = options.outputTokens ?? 500;
  return {
    run: {
      runId: options.runId ?? randomUUID(),
      status: options.runStatus ?? "SUCCEEDED",
      metrics: {
        durationMs: 40,
        steps: options.steps ?? 4,
        modelCalls: options.modelCalls ?? 3,
        toolCalls: options.toolCalls ?? 5,
        retries: options.retries ?? 1,
        modelLatencyMs: 20,
        toolLatencyMs: 12,
        tokenUsage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      },
    },
    evaluation: {
      exitCode: options.exitCode === undefined ? 0 : options.exitCode,
      timedOut: options.timedOut ?? false,
      durationMs: 10,
      stdout: options.stdout ?? "evaluation passed",
      stderr: "",
    },
    workflow: {
      testPassed: options.testPassed ?? true,
      repairAttempts: options.repairAttempts ?? 1,
      reviewRetries: options.reviewRetries ?? 0,
    },
    integrity: {
      observedBaseCommit: options.baseCommit ?? testCase.repository.baseCommit,
      definitionDigest: options.definitionDigest ?? benchmarkDefinitionDigest(testCase),
      evaluationIsolated: options.evaluationIsolated ?? true,
      protectedPaths: testCase.rules.protectedPaths.map((file) => ({
        path: file.path,
        sha256Before: file.sha256,
        sha256After: options.protectedAfter ?? file.sha256,
      })),
    },
    totalLatencyMs: options.totalLatencyMs ?? 55,
  };
}

export function caseCommit(id: string): string {
  return id
    .split("")
    .reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 2_166_136_261)
    .toString(16)
    .padStart(40, "0");
}
