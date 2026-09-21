import { createHash } from "node:crypto";

import type {
  BenchmarkCaseExecutionRecord,
  DatabaseAdapter,
  RunExecutionRecord,
} from "@devflow/database";
import {
  BenchmarkCaseSchema,
  BenchmarkExecutionProfileSchema,
  buildExecutionRequest,
  type BenchmarkCase,
  type BenchmarkRuntimeConfiguration,
  type BenchmarkSandboxLimits,
  type EvaluationObservation,
} from "@devflow/eval";
import type { CommandResult, SandboxSession } from "@devflow/sandbox";
import { DevflowError, type RunResult } from "@devflow/shared";

const MAX_PROTECTED_FILE_BYTES = 1_000_000;
const BENCHMARK_TOOL_NAMES = new Set([
  "applyPatch",
  "gitDiff",
  "gitStatus",
  "listFiles",
  "readFile",
  "runCommand",
  "searchCode",
  "writeFile",
]);

export interface BenchmarkModelParameters {
  temperature?: number;
  topP?: number;
  seed?: number;
  maxOutputTokens?: number;
}

export interface BenchmarkToolConfiguration {
  enabled: readonly string[];
  policy: "benchmark";
  network?: boolean;
}

export interface BenchmarkExecutionConfiguration {
  modelParameters: BenchmarkModelParameters;
  runtime: BenchmarkRuntimeConfiguration;
  tools: BenchmarkToolConfiguration;
}

export interface PreparedBenchmarkEvaluation {
  execution: BenchmarkCaseExecutionRecord;
  testCase: BenchmarkCase;
  observedBaseCommit: string;
  definitionDigest: string;
  protectedBefore: ReadonlyMap<string, string>;
  baselineProcessIdentities: readonly string[];
  configuration: BenchmarkExecutionConfiguration;
  startedAt: number;
}

export interface BenchmarkWorkflowObservation {
  testPassed: boolean;
  repairAttempts: number;
  reviewRetries: number;
}

export async function benchmarkSandboxLimits(
  database: DatabaseAdapter,
  runId: string,
): Promise<BenchmarkSandboxLimits | undefined> {
  const store = database.benchmarkExecutions;
  if (store === undefined) return undefined;
  const execution = await store.findCaseByRunId(runId);
  return execution === null ? undefined : BenchmarkCaseSchema.parse(execution.definition).limits;
}

export async function benchmarkExecutionConfiguration(
  database: DatabaseAdapter,
  runId: string,
): Promise<BenchmarkExecutionConfiguration | undefined> {
  const store = database.benchmarkExecutions;
  if (store === undefined) return undefined;
  const execution = await store.findCaseByRunId(runId);
  if (execution === null) return undefined;
  const testCase = parseBenchmarkCase(execution.definition);
  return parseBenchmarkConfiguration(execution.profile, testCase);
}

export async function prepareBenchmarkEvaluation(
  database: DatabaseAdapter,
  run: RunExecutionRecord,
  sandbox: SandboxSession,
  signal: AbortSignal,
): Promise<PreparedBenchmarkEvaluation | undefined> {
  // A few narrow unit-test adapters intentionally implement only the stores
  // exercised by that test; normal production adapters always expose this.
  const store = database.benchmarkExecutions;
  if (store === undefined) return undefined;
  const execution = await store.findCaseByRunId(run.id);
  if (execution === null) return undefined;
  if (execution.runId !== run.id) {
    throw benchmarkIntegrityError("Benchmark execution is attached to an unexpected Run.");
  }
  const testCase = parseBenchmarkCase(execution.definition);
  const configuration = parseBenchmarkConfiguration(execution.profile, testCase);
  assertRuntimeConfigurationApplied(configuration.runtime, run);
  const request = buildExecutionRequest(testCase, execution.id);
  if (execution.definitionDigest !== request.evaluation.integrity.definitionDigest) {
    throw benchmarkIntegrityError("Persisted benchmark definition digest does not match.");
  }
  if (run.task.baseCommitSha?.toLowerCase() !== testCase.repository.baseCommit.toLowerCase()) {
    throw benchmarkIntegrityError("Run base commit differs from the benchmark definition.");
  }

  const observedBaseCommit =
    run.repository.sourceKind === "LOCAL"
      ? testCase.repository.baseCommit.toLowerCase()
      : await readSandboxHead(sandbox, signal);
  if (observedBaseCommit !== testCase.repository.baseCommit.toLowerCase()) {
    throw benchmarkIntegrityError("Sandbox did not start from the fixed benchmark base commit.");
  }

  if (request.evaluation.setupCommand !== undefined) {
    const setup = await runTrustedCommand(sandbox, request.evaluation.setupCommand, signal);
    if (setup.timedOut || setup.exitCode !== 0) {
      throw new DevflowError({
        code: setup.timedOut ? "TIMEOUT" : "TOOL_FAILED",
        message: setup.timedOut
          ? "Benchmark setup command timed out."
          : `Benchmark setup command failed with exit code ${String(setup.exitCode)}.`,
        details: { stderr: truncate(setup.stderr), phase: "BENCHMARK_SETUP" },
      });
    }
  }

  const protectedBefore = await hashProtectedPaths(
    sandbox,
    request.evaluation.rules.protectedPaths.map(({ path }) => path),
    signal,
  );
  const baselineProcessIdentities = await captureSameUidProcessIdentities(sandbox, signal);
  return {
    execution,
    testCase,
    observedBaseCommit,
    definitionDigest: request.evaluation.integrity.definitionDigest,
    protectedBefore,
    baselineProcessIdentities,
    configuration,
    startedAt: parseBenchmarkStart(execution.startedAt),
  };
}

export async function evaluateBenchmarkInSandbox(
  database: DatabaseAdapter,
  prepared: PreparedBenchmarkEvaluation,
  sandbox: SandboxSession,
  runResult: RunResult,
  workflow: BenchmarkWorkflowObservation,
  signal: AbortSignal,
): Promise<EvaluationObservation> {
  const request = buildExecutionRequest(prepared.testCase, prepared.execution.id);
  await database.benchmarkExecutions.markEvaluating(prepared.execution.id);
  await terminateSameUidAgentProcesses(sandbox, prepared.baselineProcessIdentities, signal);
  const protectedAfterAgent = await hashProtectedPaths(
    sandbox,
    request.evaluation.rules.protectedPaths.map(({ path }) => path),
    signal,
  );
  const evaluated = await runTrustedCommand(sandbox, request.evaluation.evaluationCommand, signal);
  let evaluationIsolated = false;
  let protectedAfter = protectedAfterAgent;
  if (!evaluated.timedOut) {
    // The evaluator is trusted but may itself have spawned children. Remove them
    // before the final hash so no same-UID process can race the integrity snapshot.
    await terminateSameUidAgentProcesses(sandbox, prepared.baselineProcessIdentities, signal);
    protectedAfter = await hashProtectedPaths(
      sandbox,
      request.evaluation.rules.protectedPaths.map(({ path }) => path),
      signal,
    );
    evaluationIsolated = true;
  }
  const observation: EvaluationObservation = {
    run: runResult,
    evaluation: {
      exitCode: evaluated.timedOut ? null : evaluated.exitCode,
      timedOut: evaluated.timedOut,
      durationMs: evaluated.durationMs,
      stdout: evaluated.stdout,
      stderr: evaluated.stderr,
    },
    workflow,
    integrity: {
      observedBaseCommit: prepared.observedBaseCommit,
      definitionDigest: prepared.definitionDigest,
      evaluationIsolated,
      protectedPaths: request.evaluation.rules.protectedPaths.map(({ path }) => ({
        path,
        sha256Before: prepared.protectedBefore.get(path) ?? missingHash(path, "before"),
        sha256After: integrityEvidenceHash(
          path,
          prepared.protectedBefore,
          protectedAfterAgent,
          protectedAfter,
        ),
      })),
    },
    totalLatencyMs: Math.max(0, Date.now() - prepared.startedAt),
  };
  await database.benchmarkExecutions.recordObservation(prepared.execution.id, observation);
  return observation;
}

async function terminateSameUidAgentProcesses(
  sandbox: SandboxSession,
  baselineProcessIdentities: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const result = await sandbox.exec(
    {
      program: "node",
      args: ["-e", TERMINATE_SAME_UID_PROCESSES_SCRIPT, JSON.stringify(baselineProcessIdentities)],
      timeoutMs: 5_000,
      maxOutputBytes: 20_000,
    },
    signal,
  );
  if (result.timedOut || result.exitCode !== 0) {
    throw benchmarkIntegrityError(
      "Agent processes could not be cleared before trusted evaluation.",
    );
  }
}

async function captureSameUidProcessIdentities(
  sandbox: SandboxSession,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const result = await sandbox.exec(
    {
      program: "node",
      args: ["-e", LIST_SAME_UID_PROCESSES_SCRIPT],
      timeoutMs: 5_000,
      maxOutputBytes: 20_000,
    },
    signal,
  );
  if (result.timedOut || result.exitCode !== 0) {
    throw benchmarkIntegrityError("The sandbox process baseline could not be captured.");
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string"))
      throw new Error();
    return parsed;
  } catch {
    throw benchmarkIntegrityError("The sandbox process baseline was invalid.");
  }
}

function integrityEvidenceHash(
  path: string,
  before: ReadonlyMap<string, string>,
  afterAgent: ReadonlyMap<string, string>,
  afterEvaluator: ReadonlyMap<string, string>,
): string {
  const original = before.get(path) ?? missingHash(path, "before");
  const agentHash = afterAgent.get(path) ?? missingHash(path, "after Agent execution");
  const evaluatorHash = afterEvaluator.get(path) ?? missingHash(path, "after evaluation");
  return agentHash === original ? evaluatorHash : agentHash;
}

async function runTrustedCommand(
  sandbox: SandboxSession,
  command: BenchmarkCase["evaluationCommand"],
  signal: AbortSignal,
): Promise<CommandResult> {
  return await sandbox.exec(
    {
      program: command.program,
      args: command.args,
      cwd: command.cwd,
      env: command.environment,
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      maxOutputBytes: 1_000_000,
    },
    signal,
  );
}

async function readSandboxHead(sandbox: SandboxSession, signal: AbortSignal): Promise<string> {
  const result = await sandbox.exec(
    {
      program: "git",
      args: ["rev-parse", "--verify", "HEAD^{commit}"],
      timeoutMs: 30_000,
      maxOutputBytes: 10_000,
    },
    signal,
  );
  const commit = result.stdout.trim().toLowerCase();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw benchmarkIntegrityError("Sandbox base commit could not be verified.");
  }
  return commit;
}

async function hashProtectedPaths(
  sandbox: SandboxSession,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const hashes = new Map<string, string>();
  for (const filePath of paths) {
    const file = await sandbox.readFile(
      { path: filePath, maxBytes: MAX_PROTECTED_FILE_BYTES },
      signal,
    );
    if (file.truncated) throw benchmarkIntegrityError(`Protected path '${filePath}' is too large.`);
    hashes.set(filePath, createHash("sha256").update(file.content, "utf8").digest("hex"));
  }
  return hashes;
}

function missingHash(path: string, phase: string): never {
  throw benchmarkIntegrityError(`Protected path '${path}' was not hashed ${phase} evaluation.`);
}

function benchmarkIntegrityError(message: string): DevflowError {
  return new DevflowError({
    code: "VALIDATION_ERROR",
    message,
    details: { phase: "BENCHMARK_INTEGRITY" },
  });
}

function parseBenchmarkCase(input: unknown): BenchmarkCase {
  const parsed = BenchmarkCaseSchema.safeParse(input);
  if (!parsed.success) {
    throw benchmarkConfigurationError("Persisted benchmark definition is invalid.", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function parseBenchmarkConfiguration(
  input: unknown,
  testCase: BenchmarkCase,
): BenchmarkExecutionConfiguration {
  const parsed = BenchmarkExecutionProfileSchema.safeParse(input);
  if (!parsed.success) {
    throw benchmarkConfigurationError("Persisted benchmark execution profile is invalid.", {
      issues: parsed.error.issues,
    });
  }

  const parameters = parsed.data.model.parameters;
  const allowedParameters = new Set(["temperature", "topP", "seed", "maxOutputTokens"]);
  rejectUnknownKeys(parameters, allowedParameters, "model parameter");
  const modelParameters: BenchmarkModelParameters = {
    ...(parameters.temperature === undefined
      ? {}
      : { temperature: finiteNumber(parameters.temperature, "temperature", 0) }),
    ...(parameters.topP === undefined ? {} : { topP: finiteNumber(parameters.topP, "topP", 0, 1) }),
    ...(parameters.seed === undefined ? {} : { seed: safeInteger(parameters.seed, "seed") }),
    ...(parameters.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: safeInteger(parameters.maxOutputTokens, "maxOutputTokens", 1) }),
  };

  if (parsed.data.tools.policy !== "benchmark") {
    throw benchmarkConfigurationError(
      `Unsupported benchmark tool policy '${parsed.data.tools.policy}'.`,
    );
  }
  const enabled = parsed.data.tools.enabled;
  if (new Set(enabled).size !== enabled.length) {
    throw benchmarkConfigurationError("Benchmark tools.enabled contains duplicate tool names.");
  }
  for (const name of enabled) {
    if (!BENCHMARK_TOOL_NAMES.has(name)) {
      throw benchmarkConfigurationError(`Unknown benchmark tool '${name}'.`);
    }
  }
  const toolConfiguration = parsed.data.tools.configuration;
  rejectUnknownKeys(toolConfiguration, new Set(["network"]), "tool configuration");
  const network = toolConfiguration.network;
  if (network !== undefined && typeof network !== "boolean") {
    throw benchmarkConfigurationError("Benchmark tool configuration 'network' must be boolean.");
  }
  if (network !== undefined && network !== testCase.limits.networkEnabled) {
    throw benchmarkConfigurationError(
      "Benchmark tool network configuration must match the enforced sandbox network limit.",
    );
  }

  return {
    modelParameters,
    runtime: parsed.data.runtime.configuration,
    tools: {
      enabled,
      policy: "benchmark",
      ...(network === undefined ? {} : { network }),
    },
  };
}

function assertRuntimeConfigurationApplied(
  configuration: BenchmarkRuntimeConfiguration,
  run: RunExecutionRecord,
): void {
  const checks = [
    ["maxSteps", configuration.maxSteps, run.maxSteps],
    ["maxTestRetries", configuration.maxTestRetries, run.maxTestRetries],
    ["maxReviewRetries", configuration.maxReviewRetries, run.maxReviewRetries],
  ] as const;
  for (const [name, declared, applied] of checks) {
    if (declared !== undefined && declared !== applied) {
      throw benchmarkConfigurationError(
        `Benchmark runtime configuration '${name}' was not applied to the persisted Run.`,
        { declared, applied },
      );
    }
  }
}

function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw benchmarkConfigurationError(
      `Unknown benchmark ${label}${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    );
  }
}

function finiteNumber(
  input: unknown,
  name: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < minimum || input > maximum) {
    throw benchmarkConfigurationError(
      `Benchmark model parameter '${name}' must be a finite number between ${String(minimum)} and ${String(maximum)}.`,
    );
  }
  return input;
}

function safeInteger(input: unknown, name: string, minimum = Number.MIN_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(input) || (input as number) < minimum) {
    throw benchmarkConfigurationError(
      `Benchmark model parameter '${name}' must be a safe integer of at least ${String(minimum)}.`,
    );
  }
  return input as number;
}

function parseBenchmarkStart(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw benchmarkConfigurationError("Benchmark case execution startedAt is invalid.");
  }
  return timestamp;
}

function benchmarkConfigurationError(
  message: string,
  details: Record<string, unknown> = {},
): DevflowError {
  return new DevflowError({
    code: "VALIDATION_ERROR",
    message,
    details: { phase: "BENCHMARK_CONFIGURATION", ...details },
  });
}

function truncate(value: string, maxLength = 20_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n...[truncated]`;
}

const TERMINATE_SAME_UID_PROCESSES_SCRIPT = [
  'const fs = require("node:fs");',
  "const uid = process.getuid();",
  "const baseline = new Set(JSON.parse(process.argv[1]));",
  "const keep = new Set([1, process.pid]);",
  "let ancestor = process.ppid;",
  "while (ancestor > 0 && !keep.has(ancestor)) {",
  "  keep.add(ancestor);",
  "  try {",
  '    const stat = fs.readFileSync(`/proc/${ancestor}/stat`, "utf8");',
  '    const close = stat.lastIndexOf(")");',
  "    ancestor = Number(stat.slice(close + 2).split(/\\s+/u)[1]);",
  "  } catch { ancestor = 0; }",
  "}",
  "function targets() {",
  "  const result = [];",
  '  for (const name of fs.readdirSync("/proc")) {',
  "    if (!/^\\d+$/u.test(name)) continue;",
  "    const pid = Number(name);",
  "    if (keep.has(pid)) continue;",
  "    try {",
  '      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");',
  "      const owner = Number(/^Uid:\\s+(\\d+)/mu.exec(status)?.[1]);",
  "      if (owner !== uid) continue;",
  '      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");',
  '      const close = stat.lastIndexOf(")");',
  "      const fields = stat.slice(close + 2).split(/\\s+/u);",
  "      const identity = `${pid}:${fields[19]}`;",
  "      if (baseline.has(identity)) continue;",
  "      result.push(pid);",
  "    } catch {}",
  "  }",
  "  return result;",
  "}",
  "const initial = targets();",
  'for (const pid of initial) { try { process.kill(pid, "SIGTERM"); } catch {} }',
  "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);",
  "const afterTerm = targets();",
  'for (const pid of afterTerm) { try { process.kill(pid, "SIGKILL"); } catch {} }',
  "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);",
  "const survivors = targets();",
  "process.stdout.write(JSON.stringify({ uid, terminated: initial.length, survivors }));",
  'if (survivors.length > 0) { process.stderr.write("same-UID processes survived cleanup"); process.exitCode = 1; }',
].join("\n");

const LIST_SAME_UID_PROCESSES_SCRIPT = [
  'const fs = require("node:fs");',
  "const uid = process.getuid();",
  "const identities = [];",
  'for (const name of fs.readdirSync("/proc")) {',
  "  if (!/^\\d+$/u.test(name)) continue;",
  "  const pid = Number(name);",
  "  try {",
  '    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");',
  "    const owner = Number(/^Uid:\\s+(\\d+)/mu.exec(status)?.[1]);",
  "    if (owner !== uid) continue;",
  '    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");',
  '    const close = stat.lastIndexOf(")");',
  "    const fields = stat.slice(close + 2).split(/\\s+/u);",
  "    identities.push(`${pid}:${fields[19]}`);",
  "  } catch {}",
  "}",
  "process.stdout.write(JSON.stringify(identities));",
].join("\n");
