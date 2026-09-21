import path from "node:path";

import {
  BenchmarkExecutionProfileSchema,
  BenchmarkSuiteResultSchema,
  BenchmarkSuiteSchema,
  PricingConfigurationSchema,
  benchmarkDefinitionDigest,
  type BenchmarkExecutionProfile,
  type BenchmarkSuite,
  type BenchmarkSuiteResult,
} from "@devflow/eval";
import { describe, expect, it, vi } from "vitest";

import { parseArguments } from "../src/benchmark-main.js";
import {
  attachEfficiencyComparison,
  buildEfficiencyReport,
  compareEfficiencyReports,
  runEfficiencySamples,
} from "../src/efficiency-benchmark.js";

describe("benchmark CLI efficiency options", () => {
  it("keeps the legacy command as one measured run without warm-up", () => {
    const options = parseArguments([
      "--suite",
      "suite.json",
      "--profile",
      "profile.json",
      "--pricing",
      "pricing.json",
      "--output",
      "report.json",
    ]);

    expect(options).toMatchObject({ efficiency: false, repeats: 1, warmup: 0, assert: false });
    expect(options.outputPath).toBe(path.resolve("report.json"));
  });

  it("uses the efficiency defaults and parses scalar counts without treating them as paths", () => {
    const options = parseArguments([
      "--efficiency",
      "--suite",
      "suite.json",
      "--profile",
      "profile.json",
      "--pricing",
      "pricing.json",
      "--repeats",
      "7",
      "--warmup",
      "2",
    ]);

    expect(options).toMatchObject({ efficiency: true, repeats: 7, warmup: 2 });
  });

  it("rejects invalid baseline/assert combinations", () => {
    const required = [
      "--suite",
      "suite.json",
      "--profile",
      "profile.json",
      "--pricing",
      "pricing.json",
    ];
    expect(() => parseArguments([...required, "--assert"])).toThrow("--assert requires --baseline");
    expect(() =>
      parseArguments([...required, "--record-baseline", "one.json", "--baseline", "two.json"]),
    ).toThrow("cannot be used together");
  });
});

describe("efficiency benchmark reports", () => {
  it("runs warm-ups serially and excludes them from raw samples", async () => {
    const suite = benchmarkSuite();
    let calls = 0;
    const execute = vi.fn(async () => benchmarkResult(suite, ++calls, metrics(10)));

    const samples = await runEfficiencySamples(execute, { warmup: 2, repeats: 3 });

    expect(execute).toHaveBeenCalledTimes(5);
    expect(samples.map((sample) => sample.suiteExecutionId)).toEqual([uuid(3), uuid(4), uuid(5)]);
  });

  it("records raw samples and calculates per-case median/min/max", () => {
    const suite = benchmarkSuite();
    const report = reportFor(suite, [30, 10, 20], "baseline");

    expect(report.rawSamples).toHaveLength(3);
    expect(report.configuration).toEqual({ repeats: 3, warmup: 1, concurrency: 1 });
    expect(report.cases[0]?.metrics.modelCalls).toEqual({ median: 20, min: 10, max: 30 });
    expect(report.cases[0]?.metrics.totalTokens).toEqual({ median: 200, min: 100, max: 300 });
    expect(report.provenance).toMatchObject({
      suite: { id: "efficiency-suite", version: "1.0.0" },
      source: { gitSha: "baseline-sha", dirty: true },
      platform: { node: "v22.12.0", platform: "win32", architecture: "x64" },
      sandbox: { image: "devflow-sandbox:test" },
    });
  });

  it("passes only when outcomes do not regress and all four simple-case medians halve", () => {
    const suite = benchmarkSuite();
    const baseline = reportFor(suite, [20, 20, 20], "baseline");
    const candidate = reportFor(suite, [10, 10, 10], "candidate");

    const comparison = compareEfficiencyReports(baseline, candidate);
    const attached = attachEfficiencyComparison(candidate, baseline);

    expect(comparison.passed).toBe(true);
    expect(comparison.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "simple-single-file.modelCalls.median", maximum: 10 }),
        expect.objectContaining({ name: "simple-single-file.totalLatencyMs.median", maximum: 500 }),
      ]),
    );
    expect(attached.comparison).toEqual(comparison);
  });

  it("reports threshold violations and refuses mismatched fixed provenance", () => {
    const suite = benchmarkSuite();
    const baseline = reportFor(suite, [20], "baseline");
    const slowCandidate = reportFor(suite, [11], "candidate");

    expect(compareEfficiencyReports(baseline, slowCandidate)).toMatchObject({
      passed: false,
      violations: expect.arrayContaining([
        expect.stringContaining("simple-single-file.modelCalls.median"),
      ]),
    });

    const incompatible = buildEfficiencyReport({
      suite,
      profile: benchmarkProfile("other-model"),
      pricing: pricing(),
      samples: [benchmarkResult(suite, 8, metrics(10))],
      repeats: 1,
      warmup: 0,
      sandboxImage: "devflow-sandbox:test",
      mode: "candidate",
      source: source("candidate-sha"),
      platform: platform(),
      generatedAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    expect(() => compareEfficiencyReports(baseline, incompatible)).toThrow(
      "fixed provenance differs: profile, model",
    );
  });
});

function reportFor(
  suite: BenchmarkSuite,
  modelCalls: readonly number[],
  mode: "baseline" | "candidate",
) {
  return buildEfficiencyReport({
    suite,
    profile: benchmarkProfile(),
    pricing: pricing(),
    samples: modelCalls.map((value, index) => benchmarkResult(suite, index + 1, metrics(value))),
    repeats: modelCalls.length,
    warmup: 1,
    sandboxImage: "devflow-sandbox:test",
    mode,
    source: source(mode === "baseline" ? "baseline-sha" : "candidate-sha"),
    platform: platform(),
    generatedAt: new Date("2026-09-20T00:00:00.000Z"),
  });
}

function benchmarkSuite(): BenchmarkSuite {
  return BenchmarkSuiteSchema.parse({
    id: "efficiency-suite",
    version: "1.0.0",
    cases: [
      {
        id: "simple-single-file",
        version: "1.0.0",
        repository: { sourceUri: "C:/fixture", baseCommit: "a".repeat(40) },
        task: { title: "Fix subtract", description: "Correct the single faulty function." },
        evaluationCommand: { program: "node", args: ["evaluate.mjs"] },
      },
    ],
  });
}

function benchmarkProfile(model = "qwen3.8-flash"): BenchmarkExecutionProfile {
  return BenchmarkExecutionProfileSchema.parse({
    model: { provider: "openai-compatible", name: model, parameters: { temperature: 0 } },
    runtime: { version: "approval-workflow-v1", configuration: { maxSteps: 25 } },
    tools: {
      version: "core-tools-v1",
      enabled: ["readFile", "applyPatch"],
      policy: "benchmark",
      configuration: { network: false },
    },
  });
}

function pricing() {
  return PricingConfigurationSchema.parse({
    version: "pricing-test",
    entries: [
      {
        provider: "openai-compatible",
        model: "qwen3.8-flash",
        inputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 0.2,
      },
    ],
  });
}

function benchmarkResult(
  suite: BenchmarkSuite,
  index: number,
  values: ReturnType<typeof metrics>,
): BenchmarkSuiteResult {
  const testCase = suite.cases[0]!;
  const executionId = uuid(index + 100);
  const startedAt = "2026-09-20T00:00:00.000Z";
  const finishedAt = "2026-09-20T00:00:01.000Z";
  return BenchmarkSuiteResultSchema.parse({
    schemaVersion: 1,
    suiteExecutionId: uuid(index),
    suiteId: suite.id,
    suiteVersion: suite.version,
    startedAt,
    finishedAt,
    metrics: {
      caseCount: 1,
      successCount: 1,
      failureCount: 0,
      successRate: 1,
      expectedOutcomeMatchCount: 1,
      expectedOutcomeMatchRate: 1,
      steps: aggregate(values.steps),
      toolCalls: aggregate(values.toolCalls),
      modelCalls: aggregate(values.modelCalls),
      inputTokens: aggregate(values.inputTokens),
      outputTokens: aggregate(values.outputTokens),
      totalTokens: aggregate(values.totalTokens),
      estimatedCostUsd: { total: "0.00000001", average: "0.00000001" },
      modelLatencyMs: aggregate(values.modelLatencyMs),
      toolLatencyMs: aggregate(values.toolLatencyMs),
      evaluationLatencyMs: aggregate(values.evaluationLatencyMs),
      totalLatencyMs: aggregate(values.totalLatencyMs),
      retries: aggregate(values.retries),
      repairAttempts: aggregate(values.repairAttempts),
      reviewRetries: aggregate(values.reviewRetries),
    },
    cases: [
      {
        schemaVersion: 1,
        suiteId: suite.id,
        caseId: testCase.id,
        executionId,
        runId: uuid(index + 200),
        runStatus: "SUCCEEDED",
        success: true,
        testPassed: true,
        evaluationPassed: true,
        integrityPassed: true,
        expectedOutcomeMatched: true,
        evaluation: { exitCode: 0, timedOut: false, durationMs: 20, stdout: "ok", stderr: "" },
        metrics: { ...values, estimatedCostUsd: "0.00000001" },
        provenance: {
          schemaVersion: 1,
          executionId,
          suite: { id: suite.id, version: suite.version },
          benchmark: {
            id: testCase.id,
            version: testCase.version,
            definitionDigest: benchmarkDefinitionDigest(testCase),
          },
          repository: testCase.repository,
          task: testCase.task,
          evaluationCommand: testCase.evaluationCommand,
          evaluationRules: testCase.rules,
          expectedOutcome: testCase.expectedOutcome,
          model: benchmarkProfile().model,
          runtime: benchmarkProfile().runtime,
          tools: benchmarkProfile().tools,
          sandboxLimits: testCase.limits,
          pricingVersion: "pricing-test",
          startedAt,
          finishedAt,
        },
        failureReasons: [],
      },
    ],
  });
}

function metrics(modelCalls: number) {
  return {
    steps: modelCalls,
    toolCalls: modelCalls * 2,
    modelCalls,
    inputTokens: modelCalls * 8,
    outputTokens: modelCalls * 2,
    totalTokens: modelCalls * 10,
    modelLatencyMs: modelCalls * 70,
    toolLatencyMs: modelCalls * 20,
    evaluationLatencyMs: 20,
    totalLatencyMs: modelCalls * 50,
    retries: 0,
    repairAttempts: 0,
    reviewRetries: 0,
  };
}

function aggregate(value: number) {
  return { total: value, average: value };
}

function source(gitSha: string) {
  return { gitSha, dirty: true, dirtyDigest: "b".repeat(64) };
}

function platform() {
  return {
    node: "v22.12.0",
    platform: "win32",
    architecture: "x64",
    release: "test-release",
    hostDigest: "c".repeat(64),
  };
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
