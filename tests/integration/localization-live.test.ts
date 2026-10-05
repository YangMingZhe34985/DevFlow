import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { PrismaDatabaseAdapter } from "@devflow/database";
import { DockerSandboxManager } from "@devflow/sandbox";
import {
  DatabaseEvaluationResultStore,
  DefaultEvaluationRunner,
  RunWorkerEvaluationTarget,
  sha256,
  type BenchmarkCase,
  type BenchmarkExecutionProfile,
} from "@devflow/eval";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { expect, it } from "vitest";

import { loadWorkerEnvironment } from "../../apps/worker/src/config/env.js";
import { BullRunQueue } from "../../apps/worker/src/queue/bull-run-queue.js";
import { ApprovalWorkflowRunExecutor } from "../../apps/worker/src/runs/approval-workflow-run-executor.js";
import { QueuedRunWorkerEvaluationGateway } from "../../apps/worker/src/runs/queued-benchmark-gateway.js";
import { RunProcessor } from "../../apps/worker/src/runs/run.processor.js";

const live =
  process.env.DEVFLOW_LOCALIZATION_LIVE === "1" && process.env.DEVFLOW_P11_INTEGRATION === "1";
const exec = promisify(execFile);

it.skipIf(!live)(
  "records a real-model off/on comparison without exporting credentials or hidden evaluator input",
  async () => {
    const configuration = loadWorkerEnvironment();
    const runtimeHashes = Object.fromEntries(
      await Promise.all(
        [
          "packages/agent/src/runtime.ts",
          "packages/agent/src/working-set.ts",
          "apps/worker/src/runs/working-set.ts",
          "apps/worker/src/runs/approval-workflow-run-executor.ts",
          "apps/worker/src/runs/workflow-stage-policy.ts",
          "packages/agent/src/post-patch.ts",
          "packages/shared/src/completion.ts",
          "apps/worker/src/runs/post-patch.ts",
          "apps/worker/src/runs/efficiency-trace.ts",
          "apps/worker/src/config/env.ts",
          "packages/tools/src/contracts.ts",
          "packages/database/src/prisma-adapter.ts",
        ].map(async (file) => [file, sha256(await readFile(file, "utf8"))]),
      ),
    );
    const sandboxImageId = (
      await exec("docker", [
        "image",
        "inspect",
        configuration.DEVFLOW_SANDBOX_IMAGE,
        "--format",
        "{{.Id}}",
      ])
    ).stdout.trim();
    if (!configuration.LLM_API_KEY || !configuration.LLM_MODEL || !configuration.LLM_PROVIDER)
      throw new Error("Live evaluation requires configured model credentials");
    const directory = await mkdtemp(path.join(os.tmpdir(), "devflow-localization-live-"));
    const repository = path.join(directory, "repository");
    await cp("tests/fixtures/benchmarks/simple-single-file/repository", repository, {
      recursive: true,
    });
    await exec("git", ["init", "--initial-branch=main"], { cwd: repository });
    await exec("git", ["add", "."], { cwd: repository });
    await exec(
      "git",
      [
        "-c",
        "user.name=DevFlow Benchmark",
        "-c",
        "user.email=benchmark@devflow.invalid",
        "commit",
        "--no-gpg-sign",
        "-m",
        "fixed localization fixture",
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-09-19T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-09-19T00:00:00Z",
        },
      },
    );
    const baseCommit = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: repository })
    ).stdout.trim();
    const publicHash = sha256(
      await readFile(path.join(repository, "test/public.test.mjs"), "utf8"),
    );
    // Trusted benchmark process only: never inject base results/evaluator into Agent context.
    let basePublicResult: unknown = null;
    if (process.env.DEVFLOW_PHASE17_BENCHMARK === "1") {
      const session = await new DockerSandboxManager({
        image: configuration.DEVFLOW_SANDBOX_IMAGE,
        workspaceRoot: directory,
      }).create(
        {
          runId: randomUUID(),
          repository: { sourceUri: repository, baseCommit },
          limits: { cpuCount: 1, memoryMb: 256, pids: 64, timeoutMs: 30000, networkEnabled: false },
        },
        AbortSignal.timeout(30000),
      );
      try {
        basePublicResult = {
          command: { program: "npm", args: ["test"] },
          baseCommit,
          publicTestHash: publicHash,
          result: await session.exec(
            { program: "npm", args: ["test"], timeoutMs: 20000, maxOutputBytes: 8192 },
            AbortSignal.timeout(25000),
          ),
        };
      } finally {
        await session.dispose();
      }
    }
    const database = PrismaDatabaseAdapter.fromConnectionString(process.env.TEST_DATABASE_URL!);
    const redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    const observations: unknown[] = [];
    await database.connect();
    try {
      const repetitions = Math.min(
        5,
        Math.max(1, Number(process.env.DEVFLOW_LOCALIZATION_LIVE_SAMPLES ?? 1)),
      );
      const variants =
        process.env.DEVFLOW_PHASE17_BENCHMARK === "1"
          ? ["OFF", "PHASE16", "PHASE17"]
          : process.env.DEVFLOW_EFFICIENCY_TRIAD === "1"
            ? ["OFF", "PHASE15", "PHASE16"]
            : [
                "OFF",
                process.env.DEVFLOW_EVIDENCE_ACTION_ENABLED === "true" ? "PHASE16" : "PHASE15",
              ];
      for (const [sampleIndex, variant] of Array.from({ length: repetitions }, () => variants)
        .flat()
        .entries()) {
        const enabled = variant !== "OFF";
        const queueName = `localization-live-${randomUUID()}`;
        const queue = new BullRunQueue(queueName, redis);
        const environment = {
          ...configuration,
          DEVFLOW_LOCALIZATION_ENABLED: enabled,
          DEVFLOW_EFFICIENCY_TRACE_ENABLED: process.env.DEVFLOW_EFFICIENCY_TRACE_ENABLED === "true",
          DEVFLOW_EVIDENCE_ACTION_ENABLED: ["PHASE16", "PHASE17"].includes(variant),
          DEVFLOW_POST_PATCH_CONVERGENCE_ENABLED: variant === "PHASE17",
          DEVFLOW_POST_PATCH_AUTOFINISH_ENABLED: false,
          DEVFLOW_TIMEOUT_MS: 180_000,
          DEVFLOW_MAX_TOTAL_TOKENS: 50_000,
          DEVFLOW_MAX_RETRIES: 0,
        };
        const executor = new ApprovalWorkflowRunExecutor(database, environment);
        const processor = new RunProcessor(database.runs, executor, {
          workerId: queueName,
          leaseMs: 60_000,
          cancellationPollMs: 1000,
          observeTiming: async (runId, timing) => {
            await database.events.append({
              runId,
              type: "WORKFLOW_CHECKPOINT",
              occurredAt: new Date().toISOString(),
              payload: { dispatchTiming: timing },
            });
          },
        });
        const worker = new Worker(
          queueName,
          async (job, _token, signal) => await processor.process(job, signal),
          { connection: redis, concurrency: 1 },
        );
        worker.on("error", (error) => {
          console.error("Live benchmark worker connection error", error.name);
        });
        await worker.waitUntilReady();
        const profile: BenchmarkExecutionProfile = {
          model: {
            provider: configuration.LLM_PROVIDER,
            name: configuration.LLM_MODEL,
            parameters: { temperature: 0 },
          },
          runtime: {
            version: "approval-workflow-v1",
            configuration: {
              pipeline: "approval",
              worker: "bullmq",
              maxSteps: 12,
              maxTestRetries: 1,
              maxReviewRetries: 1,
            },
          },
          tools: {
            version: "core-tools-v1",
            enabled: ["readFile", "searchCode", "listFiles", "applyPatch", "writeFile", "gitDiff"],
            policy: "benchmark",
            configuration: { network: false },
          },
        };
        const testCase: BenchmarkCase = {
          schemaVersion: 1,
          id: "simple-single-file",
          version: "1.0.0",
          repository: { sourceUri: repository, baseCommit },
          task: {
            title: "Repair calculator addition",
            description: "Fix calculator addition and preserve the public test.",
          },
          evaluationCommand: {
            program: "node",
            args: [
              "--input-type=module",
              "--eval",
              'import assert from "node:assert/strict"; const {add}=await import("./calculator.mjs"); assert.equal(add(9,4),13); assert.equal(add(-2,5),3); console.log("hidden-evaluation-passed");',
            ],
            cwd: ".",
            timeoutMs: 10_000,
            environment: {},
          },
          limits: {
            cpuCount: 1,
            memoryMb: 256,
            pids: 64,
            networkEnabled: false,
            timeoutMs: 180_000,
          },
          rules: {
            acceptedExitCodes: [0],
            requiredStdout: ["hidden-evaluation-passed"],
            forbiddenStdout: [],
            protectedPaths: [{ path: "test/public.test.mjs", sha256: publicHash }],
            requireIsolatedEvaluation: true,
          },
          expectedOutcome: "PASS",
          metadata: {},
        };
        // Pricing is deliberately not measured. Zero entries only satisfy the existing scorer contract.
        const runner = new DefaultEvaluationRunner(
          {
            schemaVersion: 1,
            version: "UNMEASURED-NOT-BILLING",
            currency: "USD",
            entries: [
              {
                provider: configuration.LLM_PROVIDER,
                model: configuration.LLM_MODEL,
                inputUsdPerMillionTokens: 0,
                outputUsdPerMillionTokens: 0,
              },
            ],
          },
          new DatabaseEvaluationResultStore(database.benchmarkExecutions),
        );
        try {
          const started = Date.now();
          const result = await runner.runCase(
            { id: "localization-live", version: "1" },
            testCase,
            profile,
            new RunWorkerEvaluationTarget(
              new QueuedRunWorkerEvaluationGateway(database, queue, {
                localRepositoryRoot: directory,
                pollIntervalMs: 100,
                completionGraceMs: 10_000,
              }),
            ),
          );
          const persisted = result.runId ? await database.runs.findById(result.runId) : null;
          const artifacts = result.runId ? await database.artifacts.list(result.runId) : [];
          const events = result.runId
            ? await database.events.list(result.runId, { limit: 1000 })
            : [];
          const approvals = result.runId ? await database.approvals.list(result.runId) : [];
          observations.push({
            repeat: Math.floor(sampleIndex / variants.length),
            variant,
            enabled,
            evidenceAction: environment.DEVFLOW_EVIDENCE_ACTION_ENABLED,
            wallMs: Date.now() - started,
            profile,
            baseCommit,
            result,
            workflowResult: persisted?.result,
            approvedPlan: approvals.find((a) => a.kind === "PLAN" && a.status === "APPROVED")
              ?.request,
            verification: artifacts
              .filter((a) => a.name === "verification-boundary.json" && a.content)
              .map((a) => JSON.parse(a.content!)),
            stageResults: events
              .filter((e) => ["TEST_RESULT", "REVIEW_RESULT", "REPAIR_STARTED"].includes(e.type))
              .map((e) => ({ type: e.type, payload: e.payload })),
            traces: artifacts
              .filter((a) => a.name === "efficiency-trace.json" && a.content)
              .map((a) => JSON.parse(a.content!)),
            timeline: events.map((e) => ({
              type: e.type,
              occurredAt: e.occurredAt,
              sequence: e.sequence,
            })),
            dispatchTiming: events
              .map((e) => e.payload as Record<string, unknown>)
              .filter((p) => p.dispatchTiming)
              .map((p) => p.dispatchTiming),
            approvalWaitMs: approvals.reduce(
              (sum, a) =>
                sum +
                (a.resolvedAt
                  ? Math.max(0, Date.parse(a.resolvedAt) - Date.parse(a.requestedAt))
                  : 0),
              0,
            ),
          });
        } finally {
          await worker.close();
          await queue.close();
        }
      }
      await mkdir("docs/performance/results", { recursive: true });
      const report =
        JSON.stringify(
          {
            kind: "live-single-fixture-smoke",
            sampleCountPerVariant: repetitions,
            warmup: 0,
            pricing: "NOT_MEASURED",
            runtimeHashes,
            sandboxImageId,
            basePublicResult,
            git: {
              head: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
              trackedDirtyDigest: sha256(
                (await exec("git", ["diff", "--binary", "HEAD"], { maxBuffer: 16 * 1024 * 1024 }))
                  .stdout,
              ),
            },
            host: {
              node: process.version,
              platform: process.platform,
              arch: process.arch,
              cpu: os.cpus()[0]?.model,
              memoryBytes: os.totalmem(),
            },
            promptVersion:
              process.env.DEVFLOW_EVIDENCE_ACTION_ENABLED === "true"
                ? "evidence-action-v1"
                : "phase15",
            cache: "cold candidate; no statistical claim",
            observations,
          },
          null,
          2,
        ) + "\n";
      const reportName =
        process.env.DEVFLOW_PHASE17_BENCHMARK === "1"
          ? "phase17-triad-live"
          : process.env.DEVFLOW_EFFICIENCY_TRIAD === "1"
            ? "phase16-triad-live"
            : process.env.DEVFLOW_EVIDENCE_ACTION_ENABLED === "true"
              ? "phase16-action-live"
              : process.env.DEVFLOW_EFFICIENCY_TRACE_ENABLED === "true"
                ? "phase16-baseline-live"
                : "localization-phase15-live";
      await writeFile(`docs/performance/results/${reportName}-${Date.now()}.json`, report);
      await writeFile(`docs/performance/results/${reportName}.json`, report);
      // Outcome failures remain in the report, rather than being discarded to manufacture a gain.
      expect(observations).toHaveLength(variants.length * repetitions);
    } finally {
      await database.disconnect();
      await redis.quit();
      await rm(directory, { recursive: true, force: true });
    }
  },
  420_000,
);
