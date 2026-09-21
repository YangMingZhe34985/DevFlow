import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { FakeLanguageModel, fakeModelResponse, type ModelRequest } from "@devflow/agent";
import { PrismaDatabaseAdapter, type RunExecutionRecord } from "@devflow/database";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "../../apps/api/src/app.module.js";
import { ApiExceptionFilter } from "../../apps/api/src/common/api-exception.filter.js";
import { BullRunQueue as ApiRunQueue } from "../../apps/api/src/infrastructure/bull-run-queue.js";
import { loadWorkerEnvironment } from "../../apps/worker/src/config/env.js";
import { BullRunQueue as WorkerRunQueue } from "../../apps/worker/src/queue/bull-run-queue.js";
import {
  ApprovalWorkflowRunExecutor,
  type WorkflowLanguageModelFactory,
} from "../../apps/worker/src/runs/approval-workflow-run-executor.js";
import { RunProcessor } from "../../apps/worker/src/runs/run.processor.js";

const execFileAsync = promisify(execFile);
const integrationEnabled = process.env.DEVFLOW_P9_INTEGRATION === "1";
const integrationDescribe = integrationEnabled ? describe : describe.skip;
const originalLocalRepositoryRoot = process.env.DEVFLOW_LOCAL_REPOSITORY_ROOT;

integrationDescribe("P6-P9 interactive approval workflow", () => {
  const databaseUrl = requiredEnvironment("TEST_DATABASE_URL");
  const redisUrl = requiredEnvironment("TEST_REDIS_URL");
  const queueName = `devflow-p9-${crypto.randomUUID()}`;
  const fixturePath = path.resolve("tests/fixtures/calculator-bug");
  const planningPrompts: string[] = [];
  const reviewRequests: ModelRequest[] = [];
  let database: PrismaDatabaseAdapter;
  let apiQueue: ApiRunQueue;
  let workerQueue: WorkerRunQueue;
  let workerRedis: Redis;
  let queueWorker: Worker | undefined;
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let apiBaseUrl: string;
  let workspace: string;
  let temporaryRoot: string;
  let webProcess: ChildProcess | undefined;
  let webBaseUrl: string;
  let webDistributionDirectory: string | undefined;
  let webOutput = "";
  let browser: Browser | undefined;
  let reviewerCalls = 0;

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devflow-p9-"));
    workspace = path.join(temporaryRoot, "repository");
    process.env.DEVFLOW_LOCAL_REPOSITORY_ROOT = temporaryRoot;
    await cp(fixturePath, workspace, { recursive: true });
    await initializeGitRepository(workspace);

    database = PrismaDatabaseAdapter.fromConnectionString(databaseUrl);
    await database.connect();
    await database.client.$executeRawUnsafe(
      'TRUNCATE TABLE "Approval", "Artifact", "Event", "ToolCall", "Step", "Run", "Task", "Repository" CASCADE',
    );
    apiQueue = new ApiRunQueue(queueName, redisUrl);
    app = await NestFactory.create(AppModule.register({ database, runQueue: apiQueue }), {
      logger: false,
      forceCloseConnections: true,
    });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new ApiExceptionFilter());
    app.enableCors({ origin: true, credentials: true });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    apiBaseUrl = `http://127.0.0.1:${String(address.port)}/api/v1`;

    const environment = loadWorkerEnvironment({
      ...process.env,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      RUN_QUEUE_NAME: queueName,
      DEVFLOW_TIMEOUT_MS: "60000",
      DEVFLOW_SANDBOX_MEMORY_MB: "256",
      DEVFLOW_SANDBOX_PIDS: "64",
      DEVFLOW_SANDBOX_NETWORK_ENABLED: "false",
    });
    const implementationFactory: WorkflowLanguageModelFactory = (run) =>
      workflowModel(run, planningPrompts);
    const reviewerFactory: WorkflowLanguageModelFactory = () =>
      new FakeLanguageModel([
        async (request) => {
          reviewerCalls += 1;
          reviewRequests.push(request);
          return fakeModelResponse({
            toolCalls: [],
            text: JSON.stringify({
              verdict: "PASS",
              summary: "Independent review approved the tested subtraction fix.",
              issues: [],
            }),
            usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
            latencyMs: 2,
          });
        },
      ]);
    const executor = new ApprovalWorkflowRunExecutor(
      database,
      environment,
      implementationFactory,
      reviewerFactory,
    );
    const processor = new RunProcessor(database.runs, executor, {
      workerId: `p9-${crypto.randomUUID()}`,
      leaseMs: 10_000,
      cancellationPollMs: 100,
    });
    workerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    workerQueue = new WorkerRunQueue(queueName, workerRedis);
    queueWorker = new Worker(
      queueName,
      async (job, _token, signal) => await processor.process(job, signal),
      { connection: workerRedis, concurrency: 1, lockDuration: 10_000, maxStalledCount: 2 },
    );
    await queueWorker.waitUntilReady();

    const webPort = await availablePort();
    webBaseUrl = `http://127.0.0.1:${String(webPort)}`;
    webDistributionDirectory = `.next-p9-${process.pid}-${crypto.randomUUID()}`;
    webProcess = spawn(
      process.execPath,
      [
        path.resolve("node_modules/next/dist/bin/next"),
        "dev",
        "apps/web",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(webPort),
      ],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          NODE_ENV: "development",
          NEXT_PUBLIC_API_BASE_URL: apiBaseUrl,
          DEVFLOW_NEXT_DIST_DIR: webDistributionDirectory,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const captureWebOutput = (chunk: Buffer): void => {
      webOutput = `${webOutput}${chunk.toString("utf8")}`.slice(-20_000);
    };
    webProcess.stdout?.on("data", captureWebOutput);
    webProcess.stderr?.on("data", captureWebOutput);
    await waitForHttp(webProcess, webBaseUrl, 60_000, () => webOutput);
    browser = await launchBrowser();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await stopProcessTree(webProcess);
    await queueWorker?.close();
    await workerQueue?.close();
    await workerRedis?.quit();
    await app?.close();
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
    if (webDistributionDirectory !== undefined) {
      await rm(path.join("apps/web", webDistributionDirectory), { recursive: true, force: true });
    }
    if (originalLocalRepositoryRoot === undefined) {
      delete process.env.DEVFLOW_LOCAL_REPOSITORY_ROOT;
    } else {
      process.env.DEVFLOW_LOCAL_REPOSITORY_ROOT = originalLocalRepositoryRoot;
    }
  }, 120_000);

  it("completes Task -> Plan -> Reject/Replan -> Approval -> Execute -> Repair -> Review -> Result in a browser", async () => {
    const page = await browser!.newPage();
    await page.goto(webBaseUrl);

    const repositoryName = `calculator-${crypto.randomUUID().slice(0, 8)}`;
    const repositoryForm = page.getByTestId("repository-form");
    await repositoryForm.getByLabel("名称").fill(repositoryName);
    await repositoryForm.getByLabel("绝对路径").fill(workspace);
    await repositoryForm.getByRole("button", { name: "创建 Repository" }).click();

    const taskTitle = "Repair calculator subtraction";
    const taskForm = page.getByTestId("task-form");
    await taskForm.getByLabel("Repository").selectOption({ label: repositoryName });
    await taskForm.getByLabel("标题").fill(taskTitle);
    await taskForm.getByLabel("需求描述").fill("Fix subtract so the existing test suite passes.");
    await taskForm.getByRole("button", { name: "创建 Task" }).click();

    const runForm = page.getByTestId("run-form");
    await runForm.getByLabel("Task").selectOption({ label: taskTitle });
    await runForm.getByLabel("Max steps").fill("8");
    await runForm.getByLabel("Max repair").fill("2");
    await runForm.getByRole("button", { name: "创建并启动 Run" }).click();
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/runs/");

    const runId = page.url().split("/runs/")[1]?.split(/[?#]/u)[0];
    expect(runId).toMatch(/^[0-9a-f-]{36}$/u);
    if (runId === undefined) throw new Error("The browser did not navigate to a Run detail URL.");
    await page.getByRole("button", { name: "拒绝并重新规划" }).waitFor({ timeout: 30_000 });
    expect(await database.client.toolCall.count({ where: { runId } })).toBe(0);
    expect(await database.client.event.count({ where: { runId, type: "TEST_STARTED" } })).toBe(0);

    const feedback = "Add an explicit test-first repair step and preserve add().";
    await page.getByPlaceholder(/说明需要修改/u).fill(feedback);
    await page.getByRole("button", { name: "拒绝并重新规划" }).click();
    await expect
      .poll(
        async () => await database.client.approval.count({ where: { runId, status: "PENDING" } }),
        { timeout: 30_000 },
      )
      .toBe(1);
    await page.getByRole("button", { name: "批准并继续" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "批准并继续" }).click();

    await expect
      .poll(async () => (await database.runs.findById(runId))?.status, { timeout: 90_000 })
      .toBe("SUCCEEDED");
    await page.getByText("SUCCEEDED", { exact: true }).first().waitFor({ timeout: 30_000 });
    await page
      .getByTestId("run-review")
      .getByText("Independent review approved the tested subtraction fix.", { exact: true })
      .waitFor();
    await page
      .getByTestId("run-diff")
      .getByText(/return left - right/u)
      .waitFor();
    await page.getByText("REPAIR_STARTED", { exact: true }).first().waitFor();
    expect(await page.getByTestId("run-review").textContent()).toContain(
      "Independent review approved",
    );
    expect(await page.getByTestId("run-diff").textContent()).toContain("return left - right");

    const detail = await database.runs.findDetail(runId);
    expect(detail).not.toBeNull();
    expect(detail!.approvals.map(({ status }) => status)).toEqual(["REJECTED", "APPROVED"]);
    expect(detail!.artifacts.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["PLAN", "TEST_REPORT", "REVIEW_REPORT", "DIFF"]),
    );
    const testResults = detail!.events.filter(({ type }) => type === "TEST_RESULT");
    expect(testResults).toHaveLength(2);
    expect(testResults.map(({ payload }) => (payload as { ok: boolean }).ok)).toEqual([
      false,
      true,
    ]);
    expect(planningPrompts.some((prompt) => prompt.includes(feedback))).toBe(true);
    expect(reviewerCalls).toBe(1);
    expect(reviewRequests[0]?.tools).toHaveLength(0);

    const sequences = detail!.events.map(({ sequence }) => sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, index) => index + 1));
    await page.close();
  }, 180_000);

  it("fails after the configured repair limit and never invokes review", async () => {
    const repository = await request("POST", "/repositories", {
      name: `limit-${crypto.randomUUID()}`,
      sourceKind: "LOCAL",
      sourceUri: workspace,
    });
    const task = await request("POST", "/tasks", {
      repositoryId: repository.id,
      title: "Never repairs",
      description: "Exercise the maximum repair limit.",
    });
    const created = await request("POST", "/runs", {
      taskId: task.id,
      maxSteps: 3,
      maxTestRetries: 1,
    });
    const runId = (created.run as { id: string }).id;
    const waiting = await waitForRun(runId, "WAITING_APPROVAL");
    expect(waiting.currentStage).toBe("WAITING_APPROVAL");
    const approvals = (await request("GET", `/approvals?runId=${runId}`)) as unknown as Array<{
      id: string;
      status: string;
    }>;
    const pending = approvals.find(({ status }) => status === "PENDING");
    expect(pending).toBeDefined();
    await request("POST", `/approvals/${pending!.id}/resolve`, { status: "APPROVED" });

    const failed = await waitForRun(runId, "FAILED", 90_000);
    expect(
      (failed.result as { error: { details: { workflowCode: string } } }).error.details,
    ).toMatchObject({ workflowCode: "TEST_FAILED" });
    expect(await database.client.event.count({ where: { runId, type: "REPAIR_STARTED" } })).toBe(1);
    expect(await database.client.event.count({ where: { runId, type: "REVIEW_STARTED" } })).toBe(0);
    expect(reviewerCalls).toBe(1);
  }, 120_000);

  async function request(
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(apiBaseUrl + endpoint, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(`${method} ${endpoint} failed: ${JSON.stringify(payload)}`);
    return payload;
  }

  async function waitForRun(
    runId: string,
    status: string,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await request("GET", `/runs/${runId}`);
      if (run.status === status) return run;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for Run ${runId} to reach ${status}.`);
  }
});

function workflowModel(run: RunExecutionRecord, planningPrompts: string[]): FakeLanguageModel {
  if (run.currentStage === "START" || run.currentStage === "GENERATE_PLAN") {
    return new FakeLanguageModel([
      async (request) => {
        planningPrompts.push(request.messages.map(({ content }) => String(content)).join("\n"));
        const revised = run.currentStage === "GENERATE_PLAN";
        return fakeModelResponse({
          toolCalls: [],
          text: JSON.stringify({
            summary: revised ? "Revised test-first calculator plan" : "Initial calculator plan",
            complexity: "SIMPLE",
            estimatedSteps: revised ? 9 : 8,
            confidence: 0.9,
            steps: [
              {
                id: revised ? "inspect-tests-revised" : "inspect-tests",
                title: "Inspect existing calculator tests",
                description: revised
                  ? "Inspect tests first, preserve add(), then repair subtract()."
                  : "Inspect the failing subtraction behavior.",
              },
            ],
          }),
        });
      },
    ]);
  }

  if (run.task.title === "Never repairs") {
    return new FakeLanguageModel([
      fakeModelResponse({ toolCalls: [], text: "Implementation intentionally made no change." }),
      fakeModelResponse({ toolCalls: [], text: "Repair intentionally made no change." }),
    ]);
  }

  return new FakeLanguageModel([
    fakeModelResponse({
      toolCalls: [],
      text: "Inspected the task; independent tests will identify the defect.",
    }),
    fakeModelResponse({
      toolCalls: [
        {
          id: crypto.randomUUID(),
          name: "applyPatch",
          input: {
            patch: [
              "--- a/src/calculator.js",
              "+++ b/src/calculator.js",
              "@@ -5,4 +5,4 @@",
              " export function subtract(left, right) {",
              "-  // Intentional fixture bug: the agent should change + to -.",
              "-  return left + right;",
              "+  // Subtraction must preserve the left-to-right operand order.",
              "+  return left - right;",
              " }",
              "",
            ].join("\n"),
          },
        },
      ],
    }),
    fakeModelResponse({
      toolCalls: [],
      text: "Repaired subtract after analyzing the test failure.",
    }),
  ]);
}

async function initializeGitRepository(directory: string): Promise<void> {
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: directory });
  await execFileAsync("git", ["add", "."], { cwd: directory });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=DevFlow Test",
      "-c",
      "user.email=devflow@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: directory },
  );
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

async function waitForHttp(
  childProcess: ChildProcess,
  url: string,
  timeoutMs: number,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childProcess.exitCode !== null) {
      throw new Error(
        `Next.js P9 server exited with ${String(childProcess.exitCode)} before becoming ready.\n${output()}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The Next.js development server has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}.\n${output()}`);
}

async function stopProcessTree(childProcess: ChildProcess | undefined): Promise<void> {
  if (childProcess?.pid === undefined || childProcess.exitCode !== null) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(childProcess.pid), "/T", "/F"]).catch(
      () => undefined,
    );
    return;
  }
  childProcess.kill("SIGTERM");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (integrationEnabled && (value === undefined || value.length === 0)) {
    throw new Error(`Missing ${name} for P9 integration test.`);
  }
  return value ?? "not-configured";
}

async function launchBrowser(): Promise<Browser> {
  const failures: string[] = [];
  for (const executablePath of browserExecutables()) {
    try {
      return await chromium.launch({ headless: true, executablePath });
    } catch (error) {
      failures.push(`${executablePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No Chromium executable could be launched:\n${failures.join("\n")}`);
}

function browserExecutables(): string[] {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : undefined,
    process.platform === "win32"
      ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
      : undefined,
    chromium.executablePath(),
  ];
  return [
    ...new Set(candidates.filter((candidate): candidate is string => candidate !== undefined)),
  ].filter((candidate) => existsSync(candidate));
}
