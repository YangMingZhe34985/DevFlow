import { execFileSync } from "node:child_process";
import os from "node:os";

import {
  BenchmarkExecutionProfileSchema,
  BenchmarkSuiteResultSchema,
  canonicalJson,
  sha256,
  suiteDefinitionDigest,
  type BenchmarkExecutionProfile,
  type BenchmarkSuite,
  type BenchmarkSuiteResult,
  type PricingConfiguration,
} from "@devflow/eval";
import { DevflowError } from "@devflow/shared";
import { z } from "zod";

const EfficiencyMetricNameSchema = z.enum([
  "steps",
  "toolCalls",
  "modelCalls",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "modelLatencyMs",
  "toolLatencyMs",
  "evaluationLatencyMs",
  "totalLatencyMs",
  "retries",
  "repairAttempts",
  "reviewRetries",
]);

export type EfficiencyMetricName = z.infer<typeof EfficiencyMetricNameSchema>;

export const EFFICIENCY_METRIC_NAMES = EfficiencyMetricNameSchema.options;

const MetricStatisticsSchema = z
  .object({
    median: z.number().nonnegative(),
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
  })
  .strict();

const MetricStatisticsMapSchema = z.record(EfficiencyMetricNameSchema, MetricStatisticsSchema);

const EfficiencyCaseSummarySchema = z
  .object({
    caseId: z.string().min(1),
    expectedOutcome: z.enum(["PASS", "FAIL", "TIMEOUT"]),
    sampleCount: z.number().int().positive(),
    successCount: z.number().int().nonnegative(),
    successRate: z.number().min(0).max(1),
    expectedOutcomeMatchCount: z.number().int().nonnegative(),
    expectedOutcomeMatchRate: z.number().min(0).max(1),
    metrics: MetricStatisticsMapSchema,
  })
  .strict();

const OutcomeSummarySchema = z
  .object({
    sampleCount: z.number().int().positive(),
    successCount: z.number().int().nonnegative(),
    successRate: z.number().min(0).max(1),
    expectedOutcomeMatchCount: z.number().int().nonnegative(),
    expectedOutcomeMatchRate: z.number().min(0).max(1),
  })
  .strict();

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const EfficiencyProvenanceSchema = z
  .object({
    suite: z
      .object({ id: z.string().min(1), version: z.string().min(1), digest: DigestSchema })
      .strict(),
    profile: z.object({ digest: DigestSchema, value: BenchmarkExecutionProfileSchema }).strict(),
    pricing: z.object({ version: z.string().min(1), digest: DigestSchema }).strict(),
    source: z
      .object({
        gitSha: z.string().min(1),
        dirty: z.boolean(),
        dirtyDigest: DigestSchema,
      })
      .strict(),
    platform: z
      .object({
        node: z.string().min(1),
        platform: z.string().min(1),
        architecture: z.string().min(1),
        release: z.string().min(1),
        hostDigest: DigestSchema,
      })
      .strict(),
    modelDigest: DigestSchema,
    runtimeDigest: DigestSchema,
    toolsDigest: DigestSchema,
    sandbox: z
      .object({
        image: z.string().min(1),
        digest: DigestSchema,
        cases: z.array(
          z
            .object({
              caseId: z.string().min(1),
              limits: z
                .object({
                  cpuCount: z.number().positive(),
                  memoryMb: z.number().int().positive(),
                  pids: z.number().int().positive(),
                  networkEnabled: z.boolean(),
                  timeoutMs: z.number().int().positive(),
                })
                .strict(),
            })
            .strict(),
        ),
      })
      .strict(),
    versions: z
      .object({
        report: z.literal("efficiency-v1"),
        runtime: z.string().min(1),
        tools: z.string().min(1),
        prompt: z.string().min(1),
        structuredOutputSchema: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const EfficiencyCheckSchema = z
  .object({
    name: z.string().min(1),
    baseline: z.number().nonnegative(),
    candidate: z.number().nonnegative(),
    maximum: z.number().nonnegative().optional(),
    passed: z.boolean(),
  })
  .strict();

const EfficiencyComparisonSchema = z
  .object({
    baselineGeneratedAt: z.string().datetime({ offset: true }),
    checks: z.array(EfficiencyCheckSchema),
    violations: z.array(z.string().min(1)),
    passed: z.boolean(),
  })
  .strict();

export const EfficiencyBenchmarkReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("devflow-efficiency-report"),
    mode: z.enum(["baseline", "candidate", "measurement"]),
    generatedAt: z.string().datetime({ offset: true }),
    configuration: z
      .object({
        repeats: z.number().int().positive(),
        warmup: z.number().int().nonnegative(),
        concurrency: z.literal(1),
      })
      .strict(),
    provenance: EfficiencyProvenanceSchema,
    outcomes: OutcomeSummarySchema,
    cases: z.array(EfficiencyCaseSummarySchema).min(1),
    rawSamples: z.array(BenchmarkSuiteResultSchema).min(1),
    comparison: EfficiencyComparisonSchema.optional(),
  })
  .strict();

export type EfficiencyBenchmarkReport = z.infer<typeof EfficiencyBenchmarkReportSchema>;
export type EfficiencyComparison = z.infer<typeof EfficiencyComparisonSchema>;

export interface EfficiencyRunOptions {
  repeats: number;
  warmup: number;
}

export interface EfficiencyReportInput {
  suite: BenchmarkSuite;
  profile: BenchmarkExecutionProfile;
  pricing: PricingConfiguration;
  samples: readonly BenchmarkSuiteResult[];
  repeats: number;
  warmup: number;
  sandboxImage: string;
  mode: EfficiencyBenchmarkReport["mode"];
  source?: EfficiencyBenchmarkReport["provenance"]["source"];
  platform?: EfficiencyBenchmarkReport["provenance"]["platform"];
  generatedAt?: Date;
}

export async function runEfficiencySamples(
  execute: () => Promise<BenchmarkSuiteResult>,
  options: EfficiencyRunOptions,
  signal?: AbortSignal,
): Promise<BenchmarkSuiteResult[]> {
  assertCount(options.repeats, "repeats", 1, 100);
  assertCount(options.warmup, "warmup", 0, 20);
  for (let index = 0; index < options.warmup; index += 1) {
    signal?.throwIfAborted();
    await execute();
  }
  const samples: BenchmarkSuiteResult[] = [];
  for (let index = 0; index < options.repeats; index += 1) {
    signal?.throwIfAborted();
    samples.push(BenchmarkSuiteResultSchema.parse(await execute()));
  }
  return samples;
}

export function buildEfficiencyReport(input: EfficiencyReportInput): EfficiencyBenchmarkReport {
  assertCount(input.repeats, "repeats", 1, 100);
  assertCount(input.warmup, "warmup", 0, 20);
  if (input.samples.length !== input.repeats) {
    throw validationError(
      `Efficiency report expected ${input.repeats} measured samples but received ${input.samples.length}.`,
    );
  }
  const samples = input.samples.map((sample) => BenchmarkSuiteResultSchema.parse(sample));
  validateSamples(input.suite, samples);
  const profile = BenchmarkExecutionProfileSchema.parse(input.profile);
  const sandboxCases = input.suite.cases.map((testCase) => ({
    caseId: testCase.id,
    limits: testCase.limits,
  }));
  const sandboxValue = { image: input.sandboxImage, cases: sandboxCases };
  const allCases = samples.flatMap((sample) => sample.cases);
  const successCount = allCases.filter((result) => result.success).length;
  const expectedOutcomeMatchCount = allCases.filter(
    (result) => result.expectedOutcomeMatched,
  ).length;
  const source = input.source ?? collectSourceProvenance();
  const platform = input.platform ?? collectPlatformProvenance();
  return EfficiencyBenchmarkReportSchema.parse({
    schemaVersion: 1,
    kind: "devflow-efficiency-report",
    mode: input.mode,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    configuration: { repeats: input.repeats, warmup: input.warmup, concurrency: 1 },
    provenance: {
      suite: {
        id: input.suite.id,
        version: input.suite.version,
        digest: suiteDefinitionDigest(input.suite),
      },
      profile: { digest: digest(profile), value: profile },
      pricing: { version: input.pricing.version, digest: digest(input.pricing) },
      source,
      platform,
      modelDigest: digest(profile.model),
      runtimeDigest: digest(profile.runtime),
      toolsDigest: digest(profile.tools),
      sandbox: { ...sandboxValue, digest: digest(sandboxValue) },
      versions: {
        report: "efficiency-v1",
        runtime: profile.runtime.version,
        tools: profile.tools.version,
        prompt: "workflow-stage-policy-v1",
        structuredOutputSchema: "workflow-structured-output-v1",
      },
    },
    outcomes: {
      sampleCount: allCases.length,
      successCount,
      successRate: successCount / allCases.length,
      expectedOutcomeMatchCount,
      expectedOutcomeMatchRate: expectedOutcomeMatchCount / allCases.length,
    },
    cases: input.suite.cases.map((testCase) => {
      const results = samples.map((sample) =>
        sample.cases.find((item) => item.caseId === testCase.id)!,
      );
      const caseSuccessCount = results.filter((result) => result.success).length;
      const caseExpectedCount = results.filter((result) => result.expectedOutcomeMatched).length;
      return {
        caseId: testCase.id,
        expectedOutcome: testCase.expectedOutcome,
        sampleCount: results.length,
        successCount: caseSuccessCount,
        successRate: caseSuccessCount / results.length,
        expectedOutcomeMatchCount: caseExpectedCount,
        expectedOutcomeMatchRate: caseExpectedCount / results.length,
        metrics: Object.fromEntries(
          EFFICIENCY_METRIC_NAMES.map((name) => [
            name,
            statistics(results.map((result) => result.metrics[name])),
          ]),
        ),
      };
    }),
    rawSamples: samples,
  });
}

export function compareEfficiencyReports(
  baselineInput: unknown,
  candidateInput: unknown,
): EfficiencyComparison {
  const baseline = EfficiencyBenchmarkReportSchema.parse(baselineInput);
  const candidate = EfficiencyBenchmarkReportSchema.parse(candidateInput);
  assertComparableProvenance(baseline, candidate);

  const checks: z.infer<typeof EfficiencyCheckSchema>[] = [];
  checks.push(
    minimumCheck(
      "expectedOutcomeMatchRate",
      baseline.outcomes.expectedOutcomeMatchRate,
      candidate.outcomes.expectedOutcomeMatchRate,
    ),
    minimumCheck("successRate", baseline.outcomes.successRate, candidate.outcomes.successRate),
    minimumCheck("allExpectedOutcomesMatched", 1, candidate.outcomes.expectedOutcomeMatchRate),
  );

  const baselineSimple = findSimpleCase(baseline);
  const candidateSimple = findSimpleCase(candidate);
  for (const metric of ["modelCalls", "toolCalls", "totalTokens", "totalLatencyMs"] as const) {
    const baselineMedian = baselineSimple.metrics[metric].median;
    const candidateMedian = candidateSimple.metrics[metric].median;
    const maximum = baselineMedian * 0.5;
    checks.push({
      name: `simple-single-file.${metric}.median`,
      baseline: baselineMedian,
      candidate: candidateMedian,
      maximum,
      passed: candidateMedian <= maximum,
    });
  }
  const violations = checks
    .filter((check) => !check.passed)
    .map((check) =>
      check.maximum === undefined
        ? `${check.name}: candidate ${check.candidate} is below required ${check.baseline}.`
        : `${check.name}: candidate ${check.candidate} exceeds maximum ${check.maximum} (baseline ${check.baseline}).`,
    );
  return EfficiencyComparisonSchema.parse({
    baselineGeneratedAt: baseline.generatedAt,
    checks,
    violations,
    passed: violations.length === 0,
  });
}

export function attachEfficiencyComparison(
  candidateInput: unknown,
  baselineInput: unknown,
): EfficiencyBenchmarkReport {
  const candidate = EfficiencyBenchmarkReportSchema.parse(candidateInput);
  const comparison = compareEfficiencyReports(baselineInput, candidate);
  return EfficiencyBenchmarkReportSchema.parse({ ...candidate, comparison });
}

export function collectSourceProvenance(
  cwd = process.cwd(),
): EfficiencyBenchmarkReport["provenance"]["source"] {
  const gitSha = gitOutput(["rev-parse", "HEAD"], cwd)?.trim() || "unavailable";
  const status = gitOutput(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd) ?? "";
  return { gitSha, dirty: status.length > 0, dirtyDigest: sha256(status) };
}

export function collectPlatformProvenance(): EfficiencyBenchmarkReport["provenance"]["platform"] {
  return {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    release: os.release(),
    hostDigest: sha256(os.hostname()),
  };
}

function validateSamples(suite: BenchmarkSuite, samples: readonly BenchmarkSuiteResult[]): void {
  const expectedIds = suite.cases.map((testCase) => testCase.id).sort();
  for (const sample of samples) {
    if (sample.suiteId !== suite.id || sample.suiteVersion !== suite.version) {
      throw validationError(
        `Sample '${sample.suiteExecutionId}' belongs to ${sample.suiteId}@${sample.suiteVersion}, expected ${suite.id}@${suite.version}.`,
      );
    }
    const observedIds = sample.cases.map((result) => result.caseId).sort();
    if (canonicalJson(observedIds) !== canonicalJson(expectedIds)) {
      throw validationError(
        `Sample '${sample.suiteExecutionId}' does not contain exactly the configured benchmark cases.`,
      );
    }
  }
}

function assertComparableProvenance(
  baseline: EfficiencyBenchmarkReport,
  candidate: EfficiencyBenchmarkReport,
): void {
  const fixedFields: readonly [string, string, string][] = [
    ["suite", baseline.provenance.suite.digest, candidate.provenance.suite.digest],
    ["profile", baseline.provenance.profile.digest, candidate.provenance.profile.digest],
    ["pricing", baseline.provenance.pricing.digest, candidate.provenance.pricing.digest],
    ["model", baseline.provenance.modelDigest, candidate.provenance.modelDigest],
    ["runtime", baseline.provenance.runtimeDigest, candidate.provenance.runtimeDigest],
    ["tools", baseline.provenance.toolsDigest, candidate.provenance.toolsDigest],
    ["sandbox", baseline.provenance.sandbox.digest, candidate.provenance.sandbox.digest],
  ];
  const platformFields: readonly [string, string, string][] = [
    ["Node.js", baseline.provenance.platform.node, candidate.provenance.platform.node],
    ["OS platform", baseline.provenance.platform.platform, candidate.provenance.platform.platform],
    [
      "OS architecture",
      baseline.provenance.platform.architecture,
      candidate.provenance.platform.architecture,
    ],
    ["OS release", baseline.provenance.platform.release, candidate.provenance.platform.release],
    ["host", baseline.provenance.platform.hostDigest, candidate.provenance.platform.hostDigest],
  ];
  const mismatches = [...fixedFields, ...platformFields]
    .filter(([, left, right]) => left !== right)
    .map(([name]) => name);
  if (mismatches.length > 0) {
    throw validationError(
      `Efficiency reports are not comparable; fixed provenance differs: ${mismatches.join(", ")}.`,
    );
  }
}

function findSimpleCase(report: EfficiencyBenchmarkReport) {
  const testCase = report.cases.find((item) => item.caseId === "simple-single-file");
  if (testCase === undefined) {
    throw validationError("Efficiency assertion requires the 'simple-single-file' benchmark case.");
  }
  return testCase;
}

function minimumCheck(name: string, baseline: number, candidate: number) {
  return { name, baseline, candidate, passed: candidate >= baseline };
}

function statistics(values: readonly number[]) {
  if (values.length === 0)
    throw validationError("Cannot calculate statistics for an empty sample.");
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median =
    ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle]!;
  return { median, min: ordered[0]!, max: ordered.at(-1)! };
}

function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function assertCount(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw validationError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function gitOutput(args: readonly string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1_024 * 1_024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function validationError(message: string): DevflowError {
  return new DevflowError({ code: "VALIDATION_ERROR", message });
}
