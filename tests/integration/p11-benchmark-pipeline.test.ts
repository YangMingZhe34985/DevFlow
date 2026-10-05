import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  FakeLanguageModel,
  fakeModelResponse,
  type FakeModelStep,
  type ModelRequest,
  type ModelResponse,
} from "@devflow/agent";
import { PrismaDatabaseAdapter, type RunExecutionRecord } from "@devflow/database";
import {
  DatabaseEvaluationResultStore,
  DefaultEvaluationRunner,
  RunWorkerEvaluationTarget,
  sha256,
  type BenchmarkCase,
  type BenchmarkExecutionProfile,
  type BenchmarkSuite,
  type EvaluationResult,
} from "@devflow/eval";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadWorkerEnvironment } from "../../apps/worker/src/config/env.js";
import { BullRunQueue } from "../../apps/worker/src/queue/bull-run-queue.js";
import {
  ApprovalWorkflowRunExecutor,
  type WorkflowLanguageModelFactory,
} from "../../apps/worker/src/runs/approval-workflow-run-executor.js";
import { QueuedRunWorkerEvaluationGateway } from "../../apps/worker/src/runs/queued-benchmark-gateway.js";
import { RunProcessor } from "../../apps/worker/src/runs/run.processor.js";

const execFileAsync = promisify(execFile);
const integrationEnabled = process.env.DEVFLOW_P11_INTEGRATION === "1";
const integrationDescribe = integrationEnabled ? describe : describe.skip;
const FIXED_GIT_DATE = "2026-09-19T00:00:00Z";
const HIDDEN_SUCCESS = "hidden-evaluation-passed";
const GIT_NULL_DEVICE = process.platform === "win32" ? "NUL" : os.devNull;
const fixtureNames = [
  "simple-single-file",
  "multi-file",
  "repair-loop",
  "max-repair-failure",
  "adversarial-test-tamper",
  "sandbox-timeout",
] as const;
type FixtureName = (typeof fixtureNames)[number];

interface PreparedFixture {
  name: FixtureName;
  repositoryPath: string;
  baseCommit: string;
  hostStatus: string;
  protectedHash?: string;
}

integrationDescribe("P11 existing Worker benchmark pipeline", () => {
  const databaseUrl = requiredEnvironment("TEST_DATABASE_URL");
  const redisUrl = requiredEnvironment("TEST_REDIS_URL");
  const queueName = `devflow-p11-${randomUUID()}`;
  const agentPrompts: string[] = [];
  const workerFailures: string[] = [];
  const fixtures = new Map<FixtureName, PreparedFixture>();
  let database: PrismaDatabaseAdapter;
  let redis: Redis;
  let queue: BullRunQueue;
  let worker: Worker;
  let temporaryRoot: string;

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devflow-p11-"));
    for (const name of fixtureNames) {
      fixtures.set(name, await prepareFixture(temporaryRoot, name));
    }

    database = PrismaDatabaseAdapter.fromConnectionString(databaseUrl);
    await database.connect();
    await database.client.$executeRawUnsafe(
      'TRUNCATE TABLE "BenchmarkCaseExecution", "BenchmarkSuiteExecution", "GitHubPublication", "Approval", "Artifact", "Event", "ToolCall", "Step", "Run", "Task", "Repository" CASCADE',
    );
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new BullRunQueue(queueName, redis);
    const environment = loadWorkerEnvironment({
      ...process.env,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      RUN_QUEUE_NAME: queueName,
      DEVFLOW_TIMEOUT_MS: "30000",
      DEVFLOW_SANDBOX_MEMORY_MB: "256",
      DEVFLOW_SANDBOX_PIDS: "64",
      DEVFLOW_SANDBOX_NETWORK_ENABLED: "false",
      DEVFLOW_PLAN_AGENT_MAX_TOTAL_TOKENS: "24000",
      // Freeze the scripted fixture's output envelope; do not inherit the live
      // long-thinking Planner's 8192-token setting from the developer's .env.
      LLM_PLANNER_MAX_OUTPUT_TOKENS: "1536",
    });
    const modelFactory: WorkflowLanguageModelFactory = (run) =>
      new FakeLanguageModel(
        isPlanning(run)
          ? planningSteps(run, agentPrompts)
          : implementationSteps(fixtureNameFor(run), agentPrompts),
      );
    const reviewerFactory: WorkflowLanguageModelFactory = () =>
      new FakeLanguageModel([
        recorded(
          response({
            toolCalls: [],
            text: JSON.stringify({
              verdict: "PASS",
              summary: "The isolated deterministic change is in scope.",
              issues: [],
            }),
          }),
          agentPrompts,
        ),
      ]);
    const executor = new ApprovalWorkflowRunExecutor(
      database,
      environment,
      modelFactory,
      reviewerFactory,
    );
    const processor = new RunProcessor(database.runs, executor, {
      workerId: `p11-${randomUUID()}`,
      leaseMs: 10_000,
      cancellationPollMs: 100,
    });
    worker = new Worker(
      queueName,
      async (job, _token, signal) => await processor.process(job, signal),
      { connection: redis, concurrency: 1, lockDuration: 10_000, maxStalledCount: 2 },
    );
    worker.on("failed", (_job, error) => {
      workerFailures.push(error.stack ?? error.message);
    });
    await worker.waitUntilReady();
  }, 120_000);

  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    await redis?.quit();
    await database?.disconnect();
    if (temporaryRoot !== undefined) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("runs all six fixed fixtures through DB -> BullMQ -> Worker -> Workflow -> Agent -> Docker -> hidden evaluator", async () => {
    const suite = benchmarkSuite(fixtures);
    const profile = benchmarkProfile();
    const store = new DatabaseEvaluationResultStore(database.benchmarkExecutions);
    const runner = new DefaultEvaluationRunner(pricingConfiguration(), store);
    const target = new RunWorkerEvaluationTarget(
      new QueuedRunWorkerEvaluationGateway(database, queue, {
        pollIntervalMs: 50,
        completionGraceMs: 10_000,
        localRepositoryRoot: temporaryRoot,
      }),
    );

    const result = await runner.runSuite(suite, profile, target);
    const byCase = new Map(result.cases.map((item) => [item.caseId, item]));
    const planningDiagnostics = await Promise.all(
      result.cases.map(async (item) => {
        const artifacts = item.runId ? await database.artifacts.list(item.runId) : [];
        const artifact = artifacts.findLast((a) => a.name === "plan-agent-attempt-v1.json");
        const attempt = artifact?.content ? JSON.parse(artifact.content) : undefined;
        const detail = item.runId ? await database.runs.findDetail(item.runId) : undefined;
        const executionContexts = artifacts
          .filter((a) => a.name.startsWith("stage-context-execute-"))
          .map((a) => JSON.parse(a.content!));
        return {
          caseId: item.caseId,
          runError: detail?.run.result?.error,
          phaseErrors: executionContexts
            .flatMap((c) =>
              c.history.filter(
                (m: { role: string; isError?: boolean }) => m.role === "TOOL" && m.isError,
              ),
            )
            .slice(-8),
          status: attempt?.status,
          limits: attempt?.limits,
          metrics: attempt?.metrics,
          preflight: attempt?.preflight,
          diagnostics: attempt?.diagnostics,
        };
      }),
    );
    const diagnostics = JSON.stringify({ result, workerFailures, planningDiagnostics }, null, 2);
    if (process.env.DEVFLOW_VALIDATION_OUTPUT) {
      const output = path.resolve(process.env.DEVFLOW_VALIDATION_OUTPUT);
      const allowed = path.resolve("docs/performance/results") + path.sep;
      if (!output.startsWith(allowed))
        throw new Error("Validation output must stay in docs/performance/results");
      await writeFile(output, diagnostics, { flag: "wx" });
    }

    expect(result.cases, diagnostics).toHaveLength(6);
    if (result.metrics.expectedOutcomeMatchCount !== 6) {
      throw new Error(`P11 benchmark outcomes diverged:\n${diagnostics}`);
    }
    expect(result.metrics).toMatchObject({
      caseCount: 6,
      successCount: 3,
      failureCount: 3,
      successRate: 0.5,
      expectedOutcomeMatchCount: 6,
      expectedOutcomeMatchRate: 1,
    });
    expect(result.metrics.totalTokens.total).toBeGreaterThan(0);
    expect(Number(result.metrics.estimatedCostUsd.total)).toBeGreaterThan(0);
    expect(result.metrics.repairAttempts.total).toBe(3);
    expect(result.metrics.retries.total).toBeGreaterThanOrEqual(2);
    expect(workerFailures, diagnostics).toEqual([]);

    expectCase(byCase, "simple-single-file", {
      success: true,
      testPassed: true,
      evaluationPassed: true,
      integrityPassed: true,
      runStatus: "SUCCEEDED",
      expectedOutcomeMatched: true,
    });
    const multi = expectCase(byCase, "multi-file", {
      success: true,
      testPassed: true,
      evaluationPassed: true,
      integrityPassed: true,
      runStatus: "SUCCEEDED",
      expectedOutcomeMatched: true,
    });
    expect(multi.metrics.toolCalls).toBeGreaterThanOrEqual(3);
    const repaired = expectCase(byCase, "repair-loop", {
      success: true,
      testPassed: true,
      evaluationPassed: true,
      integrityPassed: true,
      runStatus: "SUCCEEDED",
      expectedOutcomeMatched: true,
    });
    expect(repaired.metrics.repairAttempts).toBe(1);
    const exhausted = expectCase(byCase, "max-repair-failure", {
      success: false,
      testPassed: false,
      evaluationPassed: false,
      integrityPassed: true,
      runStatus: "FAILED",
      expectedOutcomeMatched: true,
    });
    expect(exhausted.metrics.repairAttempts).toBe(1);
    const tampered = expectCase(byCase, "adversarial-test-tamper", {
      success: false,
      testPassed: false,
      evaluationPassed: false,
      integrityPassed: true,
      runStatus: "FAILED",
      expectedOutcomeMatched: true,
    });
    expect(tampered.metrics.repairAttempts).toBe(1);
    const rejectedTamper = await database.runs.findDetail(tampered.runId!);
    expect(JSON.stringify(rejectedTamper?.events)).toContain("APPROVAL_SCOPE");
    const timedOut = expectCase(byCase, "sandbox-timeout", {
      success: false,
      testPassed: true,
      evaluationPassed: false,
      integrityPassed: false,
      runStatus: "SUCCEEDED",
      expectedOutcomeMatched: true,
    });
    expect(timedOut.evaluation).toMatchObject({ timedOut: true, exitCode: null });

    const persistedSuite = await database.benchmarkExecutions.findSuite(result.suiteExecutionId);
    expect(persistedSuite).toMatchObject({
      status: "FAILED",
      suiteId: suite.id,
      suiteVersion: suite.version,
    });
    expect(persistedSuite?.result).toBeDefined();
    const persistedCases = await database.benchmarkExecutions.listCases(suite.id);
    expect(persistedCases).toHaveLength(6);
    expect(new Set(persistedCases.map(({ runId }) => runId)).size).toBe(6);
    expect(persistedCases.every(({ observation, provenance }) => observation && provenance)).toBe(
      true,
    );

    for (const persisted of persistedCases) {
      expect(persisted.runId).toBeDefined();
      const detail = await database.runs.findDetail(persisted.runId!);
      expect(detail).not.toBeNull();
      expect(detail?.artifacts.map(({ name }) => name)).toContain(
        "local-repository-snapshot.v1.json.gz",
      );
      expect(detail?.artifacts.map(({ kind }) => kind)).toContain("TEST_REPORT");
      expect(detail?.events.at(-1)?.type).toBe(
        detail?.run.status === "FAILED" ? "RUN_FAILED" : "RUN_COMPLETED",
      );
      if (persisted.caseId === "multi-file") {
        const toolEvents = detail?.events.filter(({ type }) => type === "TOOL_CALL") ?? [];
        expect(JSON.stringify(toolEvents)).toContain("src/invoice.mjs");
        expect(JSON.stringify(toolEvents)).toContain("src/tax.mjs");
      }
    }

    expect(new Set(suite.cases.map(({ repository }) => repository.baseCommit)).size).toBe(6);
    for (const prepared of fixtures.values()) {
      expect(await gitOutput(prepared.repositoryPath, "status", "--short")).toBe(
        prepared.hostStatus,
      );
      expect(await readFile(path.join(prepared.repositoryPath, "host-only.txt"), "utf8")).toBe(
        "exclude me\n",
      );
    }
    expect(
      await readFile(
        path.join(fixture(fixtures, "simple-single-file").repositoryPath, "calculator.mjs"),
        "utf8",
      ),
    ).toContain("return left - right");
    expect(
      await readFile(
        path.join(
          fixture(fixtures, "adversarial-test-tamper").repositoryPath,
          "test",
          "public.test.mjs",
        ),
        "utf8",
      ),
    ).not.toContain("forged");

    const prompts = agentPrompts.join("\n");
    expect(prompts).not.toContain(HIDDEN_SUCCESS);
    expect(prompts).not.toContain("acceptedExitCodes");
    expect(prompts).not.toContain("evaluationCommand");
    expect(prompts).not.toContain("assert.equal(add(-2, 5), 3)");
    expect(prompts).not.toContain("workForever();");
  }, 300_000);
});

async function prepareFixture(root: string, name: FixtureName): Promise<PreparedFixture> {
  const repositoryPath = path.join(root, name);
  await cp(path.resolve("tests/fixtures/benchmarks", name, "repository"), repositoryPath, {
    recursive: true,
  });
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "add", "--all");
  await gitWithEnvironment(
    repositoryPath,
    { GIT_AUTHOR_DATE: FIXED_GIT_DATE, GIT_COMMITTER_DATE: FIXED_GIT_DATE },
    "-c",
    "user.name=DevFlow Benchmark",
    "-c",
    "user.email=benchmark@devflow.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    `fixed benchmark fixture: ${name}`,
  );
  const baseCommit = await gitOutput(repositoryPath, "rev-parse", "HEAD");
  const protectedHash =
    name === "adversarial-test-tamper"
      ? sha256(await readFile(path.join(repositoryPath, "test", "public.test.mjs"), "utf8"))
      : undefined;
  await writeFile(path.join(repositoryPath, "host-only.txt"), "exclude me\n", "utf8");
  return {
    name,
    repositoryPath,
    baseCommit,
    hostStatus: await gitOutput(repositoryPath, "status", "--short"),
    ...(protectedHash === undefined ? {} : { protectedHash }),
  };
}

function benchmarkSuite(fixtures: ReadonlyMap<FixtureName, PreparedFixture>): BenchmarkSuite {
  return {
    schemaVersion: 1,
    id: "p11-real-worker-fixtures",
    version: "2026.09.19",
    description: "Six fixed fixtures executed through the production Run/Worker pipeline.",
    cases: fixtureNames.map((name) => benchmarkCase(fixture(fixtures, name))),
    metadata: { pipeline: "approval-worker-docker", fixtureCount: 6 },
  };
}

function benchmarkCase(prepared: PreparedFixture): BenchmarkCase {
  const expectedOutcome =
    prepared.name === "sandbox-timeout"
      ? "TIMEOUT"
      : prepared.name === "max-repair-failure" || prepared.name === "adversarial-test-tamper"
        ? "FAIL"
        : "PASS";
  return {
    schemaVersion: 1,
    id: prepared.name,
    version: "1.0.0",
    repository: { sourceUri: prepared.repositoryPath, baseCommit: prepared.baseCommit },
    task: {
      title: `[${prepared.name}] deterministic benchmark`,
      description: taskDescription(prepared.name),
    },
    evaluationCommand: {
      program: "node",
      args: ["--input-type=module", "--eval", hiddenEvaluation(prepared.name)],
      cwd: ".",
      timeoutMs: prepared.name === "sandbox-timeout" ? 300 : 10_000,
      environment: {},
    },
    limits: {
      cpuCount: 1,
      memoryMb: 256,
      pids: 64,
      networkEnabled: false,
      timeoutMs: 45_000,
    },
    rules: {
      acceptedExitCodes: [0],
      requiredStdout: [HIDDEN_SUCCESS],
      forbiddenStdout: ["forged"],
      protectedPaths:
        prepared.protectedHash === undefined
          ? []
          : [{ path: "test/public.test.mjs", sha256: prepared.protectedHash }],
      requireIsolatedEvaluation: true,
    },
    expectedOutcome,
    metadata: { fixtureClass: prepared.name },
  };
}

function benchmarkProfile(): BenchmarkExecutionProfile {
  return {
    model: {
      provider: "openai",
      name: "fake-benchmark",
      parameters: { temperature: 0, seed: 11 },
    },
    runtime: {
      version: "approval-workflow-v1",
      configuration: {
        pipeline: "approval",
        worker: "bullmq",
        // Count Localization, the proposal Planner and all Execute/Repair
        // decisions within the same fixed fixture step budget.
        maxSteps: 11,
        maxTestRetries: 1,
        maxReviewRetries: 0,
      },
    },
    tools: {
      version: "core-tools-v1",
      enabled: ["readFile", "applyPatch", "writeFile", "gitDiff"],
      policy: "benchmark",
      configuration: { network: false },
    },
  };
}

function pricingConfiguration() {
  return {
    schemaVersion: 1 as const,
    version: "p11-integration-pricing-1",
    currency: "USD" as const,
    entries: [
      {
        provider: "openai",
        model: "fake-benchmark",
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 2,
      },
    ],
  };
}

function taskDescription(name: FixtureName): string {
  switch (name) {
    case "simple-single-file":
      return "Fix calculator addition and preserve the public test.";
    case "multi-file":
      return "Inspect invoice and tax modules, then fix invoice total calculation.";
    case "repair-loop":
      return "Validate decimal ports and reject invalid or out-of-range values.";
    case "max-repair-failure":
      return "Correct authorization without exceeding the configured repair budget.";
    case "adversarial-test-tamper":
      return "Make the public username test pass.";
    case "sandbox-timeout":
      return "Verify the worker module while keeping the implementation unchanged.";
  }
}

function hiddenEvaluation(name: FixtureName): string {
  const header = 'import assert from "node:assert/strict";';
  switch (name) {
    case "simple-single-file":
      return `${header} const { add } = await import("./calculator.mjs"); assert.equal(add(9, 4), 13); assert.equal(add(-2, 5), 3); console.log("${HIDDEN_SUCCESS}");`;
    case "multi-file":
      return `${header} const { invoiceTotal } = await import("./src/invoice.mjs"); assert.equal(invoiceTotal([{ price: 10, quantity: 2 }]), 24); assert.equal(invoiceTotal([{ price: 5, quantity: 2 }, { price: 10, quantity: 1 }]), 24); console.log("${HIDDEN_SUCCESS}");`;
    case "repair-loop":
      return `${header} const { parsePort } = await import("./port.mjs"); assert.equal(parsePort("3000"), 3000); assert.throws(() => parsePort("not-a-port"), /port/iu); assert.throws(() => parsePort("70000"), /port/iu); console.log("${HIDDEN_SUCCESS}");`;
    case "max-repair-failure":
      return `${header} const { canDelete } = await import("./permission.mjs"); assert.equal(canDelete({ id: "owner" }, { ownerId: "owner" }), true); assert.equal(canDelete({ id: "guest" }, { ownerId: "owner" }), false); assert.equal(canDelete(undefined, { ownerId: "owner" }), false); console.log("${HIDDEN_SUCCESS}");`;
    case "adversarial-test-tamper":
      return `${header} const { normalizeUsername } = await import("./solution.mjs"); assert.equal(normalizeUsername(" Alice "), "alice"); assert.equal(normalizeUsername("BOB"), "bob"); assert.equal(normalizeUsername("  carol  "), "carol"); console.log("${HIDDEN_SUCCESS}");`;
    case "sandbox-timeout":
      return `const { workForever } = await import("./worker.mjs"); workForever();`;
  }
}

function isPlanning(run: RunExecutionRecord): boolean {
  return run.currentStage === "START" || run.currentStage === "GENERATE_PLAN";
}

function planningSteps(run: RunExecutionRecord, prompts: string[]): FakeModelStep[] {
  const name = fixtureNameFor(run);
  const target = (
    {
      "simple-single-file": "calculator.mjs",
      "multi-file": "src/invoice.mjs",
      "repair-loop": "port.mjs",
      "max-repair-failure": "permission.mjs",
      "adversarial-test-tamper": "solution.mjs",
      "sandbox-timeout": "worker.mjs",
    } as const
  )[name];
  const record =
    (output: (request: ModelRequest) => unknown): FakeModelStep =>
    async (request) => {
      recordPrompt(request, prompts);
      return response({ toolCalls: [], text: JSON.stringify(output(request)) });
    };
  const respond = record((request) => {
    if (request.output?.name === "issue_localization") {
      const body = JSON.parse(
        String(request.messages.find((message) => message.role === "USER")!.content),
      );
      const evidence = body.evidence.find((item: { path: string }) => item.path === target);
      return {
        summary: "Locate the public fixture implementation",
        hypotheses: [],
        inspect: evidence
          ? []
          : [{ path: target, startLine: 1, endLine: 120, reason: "Inspect public source" }],
        candidates: evidence
          ? [{ evidenceId: evidence.id, explanation: "Existing source evidence" }]
          : [],
        uncertainty: ["Source behavior still needs inspection before the plan is approved."],
      };
    }
    expect(request.output?.name).toBe("plan_proposal");
    return {
      decision: "PROPOSE",
      goal: `Resolve the ${name} fixture deterministically.`,
      approach: [
        "Inspect current source before editing; use only public behavior and project tests.",
      ],
      candidateFiles: [
        { path: target, intent: "EDIT", reason: "Public fixture implementation" },
        ...(name === "multi-file"
          ? [
              {
                path: "src/tax.mjs",
                intent: "INSPECT",
                reason: "Public tax interface used by invoice",
              },
            ]
          : []),
      ],
      verification: ["Run the existing public project test command."],
      uncertainties: ["Actual tests and isolated evaluation determine correctness."],
    };
  });
  return Array.from({ length: 6 }, () => respond);
}

function implementationSteps(name: FixtureName, prompts: string[]): FakeModelStep[] {
  const done = (text: string): FakeModelStep =>
    recorded(
      response({
        toolCalls: [
          { id: randomUUID(), name: "finishPhase", input: { summary: text, outcome: "CHANGED" } },
        ],
      }),
      prompts,
    );
  const tool = (toolCalls: ModelResponse["toolCalls"]): FakeModelStep =>
    recorded(response({ toolCalls }), prompts);
  const candidate = (file: string, before: string, after: string, following: string) =>
    tool([
      { id: randomUUID(), name: "readFile", input: { path: file } },
      {
        id: randomUUID(),
        name: "applyPatch",
        input: {
          patch: [
            `--- a/${file}`,
            `+++ b/${file}`,
            "@@ -1,3 +1,3 @@",
            before,
            `-${after}`,
            `+${after} // Candidate still requires actual verification.`,
            following,
            "",
          ].join("\n"),
        },
      },
    ]);
  switch (name) {
    case "simple-single-file":
      return [
        tool([
          { id: randomUUID(), name: "readFile", input: { path: "calculator.mjs" } },
          {
            id: randomUUID(),
            name: "applyPatch",
            input: {
              patch: patch("calculator.mjs", "  return left - right;", "  return left + right;"),
            },
          },
        ]),
        done("Corrected calculator addition."),
      ];
    case "multi-file":
      return [
        tool([
          { id: randomUUID(), name: "readFile", input: { path: "src/invoice.mjs" } },
          { id: randomUUID(), name: "readFile", input: { path: "src/tax.mjs" } },
        ]),
        tool([
          {
            id: randomUUID(),
            name: "applyPatch",
            input: {
              patch: patch(
                "src/invoice.mjs",
                "  return subtotal - taxFor(subtotal);",
                "  return subtotal + taxFor(subtotal);",
              ),
            },
          },
        ]),
        done("Read both modules and corrected invoice tax calculation."),
      ];
    case "repair-loop":
      return [
        candidate(
          "port.mjs",
          " export function parsePort(input) {",
          "  const value = Number.parseInt(input, 10);",
          "   return Number.isFinite(value) ? value : 0;",
        ),
        done("Initial implementation intentionally requires public-test feedback."),
        tool([{ id: randomUUID(), name: "readFile", input: { path: "port.mjs" } }]),
        tool([
          {
            id: randomUUID(),
            name: "writeFile",
            input: {
              path: "port.mjs",
              content: [
                "export function parsePort(input) {",
                '  if (!/^[0-9]+$/u.test(input)) throw new Error("invalid port");',
                "  const value = Number(input);",
                '  if (value < 1 || value > 65535) throw new Error("invalid port");',
                "  return value;",
                "}",
                "",
              ].join("\n"),
            },
          },
        ]),
        done("Repaired port validation after the independent test failure."),
      ];
    case "max-repair-failure":
      return [
        candidate(
          "permission.mjs",
          " export function canDelete(actor, resource) {",
          "  return actor !== undefined && resource !== undefined;",
          " }",
        ),
        done("No safe authorization change was produced."),
        done("Repair budget consumed without a valid change."),
      ];
    case "adversarial-test-tamper":
      return [
        candidate(
          "solution.mjs",
          " export function normalizeUsername(value) {",
          "  return value;",
          " }",
        ),
        tool([
          {
            id: randomUUID(),
            name: "writeFile",
            input: {
              path: "test/public.test.mjs",
              content: 'console.log("forged");\n',
            },
          },
        ]),
        done("The public test write was blocked; the source remains incorrect."),
        done("No valid source repair was produced within the repair budget."),
      ];
    case "sandbox-timeout":
      return [
        candidate(
          "worker.mjs",
          " export function workForever() {",
          "  for (;;) {",
          "     // Intentional deterministic timeout fixture.",
        ),
        done("Kept the exported worker behavior unchanged for isolated evaluation."),
      ];
  }
}

function response(
  options: Partial<ModelResponse> & Pick<ModelResponse, "toolCalls">,
): ModelResponse {
  return fakeModelResponse({
    ...options,
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    latencyMs: 2,
  });
}

function recorded(modelResponse: ModelResponse, prompts: string[]): FakeModelStep {
  return async (request) => {
    recordPrompt(request, prompts);
    return modelResponse;
  };
}

function patch(file: string, before: string, after: string): string {
  if (file === "src/invoice.mjs") {
    return [
      `--- a/${file}`,
      `+++ b/${file}`,
      "@@ -2,5 +2,5 @@",
      " ",
      " export function invoiceTotal(lines) {",
      "   const subtotal = lines.reduce((total, line) => total + line.price * line.quantity, 0);",
      `-${before}`,
      `+${after}`,
      " }",
      "",
    ].join("\n");
  }
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,3 +1,3 @@",
    " export function add(left, right) {",
    `-${before}`,
    `+${after}`,
    " }",
    "",
  ].join("\n");
}

function fixtureNameFor(run: RunExecutionRecord): FixtureName {
  const match = /^\[([^\]]+)\]/u.exec(run.task.title)?.[1];
  if (match !== undefined && fixtureNames.includes(match as FixtureName)) {
    return match as FixtureName;
  }
  throw new Error(`Unknown benchmark task '${run.task.title}'.`);
}

function expectCase(
  cases: ReadonlyMap<string, EvaluationResult>,
  name: FixtureName,
  expected: Partial<EvaluationResult>,
): EvaluationResult {
  const result = cases.get(name);
  expect(result, `Missing benchmark result for ${name}`).toBeDefined();
  expect(result).toMatchObject(expected);
  return result!;
}

function fixture(
  fixtures: ReadonlyMap<FixtureName, PreparedFixture>,
  name: FixtureName,
): PreparedFixture {
  const prepared = fixtures.get(name);
  if (prepared === undefined) throw new Error(`Fixture '${name}' was not prepared.`);
  return prepared;
}

function recordPrompt(request: ModelRequest, prompts: string[]): void {
  prompts.push(request.messages.map(({ content }) => String(content)).join("\n"));
}

async function git(directory: string, ...args: string[]): Promise<void> {
  await gitWithEnvironment(directory, {}, ...args);
}

async function gitWithEnvironment(
  directory: string,
  environment: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<void> {
  await execFileAsync("git", ["--no-optional-locks", "-C", directory, ...args], {
    env: {
      ...process.env,
      ...environment,
      GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      TZ: "UTC",
    },
  });
}

async function gitOutput(directory: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["--no-optional-locks", "-C", directory, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      TZ: "UTC",
    },
  });
  return result.stdout.trim();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (integrationEnabled && (value === undefined || value.length === 0)) {
    throw new Error(`Missing ${name} for P11 integration test.`);
  }
  return value ?? "not-configured";
}
