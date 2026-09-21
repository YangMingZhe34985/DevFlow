import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaDatabaseAdapter } from "@devflow/database";
import {
  BenchmarkExecutionProfileSchema,
  BenchmarkSuiteSchema,
  DatabaseEvaluationResultStore,
  DefaultEvaluationRunner,
  PricingConfigurationSchema,
  RunWorkerEvaluationTarget,
} from "@devflow/eval";
import { DevflowError, toDevflowError } from "@devflow/shared";
import { Redis } from "ioredis";

import { loadWorkerEnvironment } from "./config/env.js";
import { BullRunQueue } from "./queue/bull-run-queue.js";
import { QueuedRunWorkerEvaluationGateway } from "./runs/queued-benchmark-gateway.js";
import {
  attachEfficiencyComparison,
  buildEfficiencyReport,
  EfficiencyBenchmarkReportSchema,
  runEfficiencySamples,
  type EfficiencyBenchmarkReport,
} from "./efficiency-benchmark.js";

interface BenchmarkCliOptions {
  suitePath: string;
  profilePath: string;
  pricingPath: string;
  outputPath?: string;
  efficiency: boolean;
  recordBaselinePath?: string;
  baselinePath?: string;
  assert: boolean;
  repeats: number;
  warmup: number;
}

function printUsage(): void {
  console.log(`DevFlow P11 Benchmark Runner

Usage:
  npm run benchmark -- --suite <suite.json> --profile <profile.json> --pricing <pricing.json> [--output <report.json>]
  npm run benchmark:efficiency -- --suite <suite.json> --profile <profile.json> --pricing <pricing.json>
      [--record-baseline <baseline.json> | --baseline <baseline.json>] [--output <report.json>]
      [--assert] [--repeats <1-100>] [--warmup <0-20>]

The API infrastructure and a normal DevFlow Worker must already be running and
must use the same DATABASE_URL, REDIS_URL, and RUN_QUEUE_NAME. Benchmark Runs are
created in PostgreSQL, dispatched through BullMQ, and executed by that Worker.

The regular benchmark command remains a single run. Efficiency mode runs serially
(one warm-up and five measured samples by default), records raw samples and
provenance, and can compare a candidate against a previously recorded baseline.`);
}

async function main(): Promise<number> {
  if (process.argv.slice(2).includes("--help")) {
    printUsage();
    return 0;
  }
  const options = parseArguments(process.argv.slice(2));
  const [suite, profile, pricing] = await Promise.all([
    readJson(options.suitePath).then((value) => BenchmarkSuiteSchema.parse(value)),
    readJson(options.profilePath).then((value) => BenchmarkExecutionProfileSchema.parse(value)),
    readJson(options.pricingPath).then((value) => PricingConfigurationSchema.parse(value)),
  ]);
  const environment = loadWorkerEnvironment();
  const database = PrismaDatabaseAdapter.fromConnectionString(environment.DATABASE_URL);
  const redis = new Redis(environment.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new BullRunQueue(environment.RUN_QUEUE_NAME, redis);
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort(new Error("Benchmark cancellation requested."));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  try {
    await database.connect();
    await Promise.all([database.ping(), queue.ping()]);
    const runner = new DefaultEvaluationRunner(
      pricing,
      new DatabaseEvaluationResultStore(database.benchmarkExecutions),
    );
    const target = new RunWorkerEvaluationTarget(
      new QueuedRunWorkerEvaluationGateway(database, queue, {
        ...(process.env.DEVFLOW_LOCAL_REPOSITORY_ROOT === undefined
          ? {}
          : { localRepositoryRoot: process.env.DEVFLOW_LOCAL_REPOSITORY_ROOT }),
      }),
    );
    const execute = async () => await runner.runSuite(suite, profile, target, cancellation.signal);
    if (!options.efficiency) {
      const result = await execute();
      await emitReport(result, options.outputPath);
      return result.metrics.expectedOutcomeMatchCount === result.metrics.caseCount ? 0 : 1;
    }

    const samples = await runEfficiencySamples(
      execute,
      { repeats: options.repeats, warmup: options.warmup },
      cancellation.signal,
    );
    let report: EfficiencyBenchmarkReport = buildEfficiencyReport({
      suite,
      profile,
      pricing,
      samples,
      repeats: options.repeats,
      warmup: options.warmup,
      sandboxImage: environment.DEVFLOW_SANDBOX_IMAGE,
      mode:
        options.recordBaselinePath !== undefined
          ? "baseline"
          : options.baselinePath !== undefined
            ? "candidate"
            : "measurement",
    });
    if (options.baselinePath !== undefined) {
      const baseline = EfficiencyBenchmarkReportSchema.parse(await readJson(options.baselinePath));
      report = attachEfficiencyComparison(report, baseline);
    }

    const destinations = new Set(
      [options.recordBaselinePath, options.outputPath].filter(
        (value): value is string => value !== undefined,
      ),
    );
    if (destinations.size === 0) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const destination of destinations) await writeReport(destination, report);
    }
    if (options.assert && report.comparison?.passed !== true) return 1;
    return report.outcomes.expectedOutcomeMatchRate === 1 ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await Promise.allSettled([queue.close(), database.disconnect(), redis.quit()]);
  }
}

export function parseArguments(args: readonly string[]): BenchmarkCliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--suite",
    "--profile",
    "--pricing",
    "--output",
    "--record-baseline",
    "--baseline",
    "--repeats",
    "--warmup",
  ]);
  const pathOptions = new Set([
    "--suite",
    "--profile",
    "--pricing",
    "--output",
    "--record-baseline",
    "--baseline",
  ]);
  const booleanOptions = new Set(["--efficiency", "--assert"]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (booleanOptions.has(option ?? "")) {
      flags.add(option!);
      continue;
    }
    if (!valueOptions.has(option ?? "")) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: `Unknown benchmark option '${option ?? ""}'.`,
      });
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: `${option ?? "Benchmark option"} requires a value.`,
      });
    }
    values.set(option as string, pathOptions.has(option!) ? path.resolve(value) : value);
    index += 1;
  }
  const outputPath = values.get("--output");
  const recordBaselinePath = values.get("--record-baseline");
  const baselinePath = values.get("--baseline");
  const explicitlyEfficient =
    flags.has("--efficiency") ||
    recordBaselinePath !== undefined ||
    baselinePath !== undefined ||
    values.has("--repeats") ||
    values.has("--warmup") ||
    flags.has("--assert");
  if (recordBaselinePath !== undefined && baselinePath !== undefined) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "--record-baseline and --baseline cannot be used together.",
    });
  }
  if (flags.has("--assert") && baselinePath === undefined) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "--assert requires --baseline <baseline.json>.",
    });
  }
  return {
    suitePath: requiredOption(values, "--suite"),
    profilePath: requiredOption(values, "--profile"),
    pricingPath: requiredOption(values, "--pricing"),
    efficiency: explicitlyEfficient,
    assert: flags.has("--assert"),
    repeats: parseCount(values.get("--repeats"), "--repeats", explicitlyEfficient ? 5 : 1, 1, 100),
    warmup: parseCount(values.get("--warmup"), "--warmup", explicitlyEfficient ? 1 : 0, 0, 20),
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(recordBaselinePath === undefined ? {} : { recordBaselinePath }),
    ...(baselinePath === undefined ? {} : { baselinePath }),
  };
}

function requiredOption(values: ReadonlyMap<string, string>, option: string): string {
  const value = values.get(option);
  if (value === undefined) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: `Missing required benchmark option ${option}.`,
    });
  }
  return value;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function parseCount(
  value: string | undefined,
  option: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: `${option} must be an integer between ${minimum} and ${maximum}.`,
    });
  }
  return parsed;
}

async function emitReport(report: unknown, outputPath: string | undefined): Promise<void> {
  if (outputPath === undefined) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  await writeReport(outputPath, report);
}

async function writeReport(outputPath: string, report: unknown): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(`Benchmark report written to ${outputPath}`);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const normalized = toDevflowError(error, {
        code: "INTERNAL_ERROR",
        message: "Benchmark runner failed.",
      });
      console.error(`${normalized.code}: ${normalized.message}`);
      process.exitCode = 1;
    });
}
