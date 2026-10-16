import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import { PrismaDatabaseAdapter, type RunExecutionRecord } from "@devflow/database";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "../../apps/api/src/app.module.js";
import { ApiExceptionFilter } from "../../apps/api/src/common/api-exception.filter.js";
import { BullRunQueue as ApiRunQueue } from "../../apps/api/src/infrastructure/bull-run-queue.js";
import { AutonomousRunExecutor } from "../../apps/worker/src/autonomous/executor.js";
import { ExecutionModeRouter } from "../../apps/worker/src/autonomous/router.js";
import { loadWorkerEnvironment } from "../../apps/worker/src/config/env.js";
import { BullRunQueue as WorkerRunQueue } from "../../apps/worker/src/queue/bull-run-queue.js";
import { GitHubDeliveryExecutor } from "../../apps/worker/src/runs/github-delivery.js";
import { RunProcessor } from "../../apps/worker/src/runs/run.processor.js";

const execFileAsync = promisify(execFile);
const integrationEnabled = process.env.DEVFLOW_P9_INTEGRATION === "1";
const integrationDescribe = integrationEnabled ? describe : describe.skip;
const originalLocalRepositoryRoot = process.env.DEVFLOW_LOCAL_REPOSITORY_ROOT;
const REVIEW_SUMMARY = "Subtraction now returns the difference; add() is unchanged.";

integrationDescribe("P9 autonomous Run in the browser", () => {
  const databaseUrl = requiredEnvironment("TEST_DATABASE_URL");
  const redisUrl = requiredEnvironment("TEST_REDIS_URL");
  const queueName = `devflow-p9-${crypto.randomUUID()}`;
  const fixturePath = path.resolve("tests/fixtures/calculator-bug");
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
  let originalNextEnvironment: string | undefined;
  let webOutput = "";
  let browser: Browser | undefined;

  beforeAll(async () => {
    originalNextEnvironment = await readFile("apps/web/next-env.d.ts", "utf8");
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devflow-p9-"));
    workspace = path.join(temporaryRoot, "repository");
    process.env.DEVFLOW_LOCAL_REPOSITORY_ROOT = temporaryRoot;
    await cp(fixturePath, workspace, { recursive: true });
    await initializeGitRepository(workspace);

    database = PrismaDatabaseAdapter.fromConnectionString(databaseUrl);
    await database.connect();
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
      DEVFLOW_SANDBOX_MEMORY_MB: "256",
      DEVFLOW_SANDBOX_PIDS: "64",
      DEVFLOW_SANDBOX_NETWORK_ENABLED: "false",
      DEVFLOW_AUTONOMOUS_REVIEW: "1",
      DEVFLOW_AUTONOMOUS_MAX_ATTEMPTS: "1",
    });
    const autonomous = new AutonomousRunExecutor(database, environment, {
      modelFactory: (run) => ({
        model: solver(run),
        settings: {},
        bindingHash: "p9-fake-solver",
      }),
      reviewModelFactory: () => ({
        model: new FakeLanguageModel([
          fakeModelResponse({
            toolCalls: [],
            output: { concerns: [], verdict: "PASS", findings: [], summary: REVIEW_SUMMARY },
          }),
        ]),
        settings: {},
        bindingHash: "p9-fake-reviewer",
      }),
    });
    const processor = new RunProcessor(
      database.runs,
      new ExecutionModeRouter(autonomous, new GitHubDeliveryExecutor(database, environment)),
      { workerId: `p9-${crypto.randomUUID()}`, leaseMs: 10_000, cancellationPollMs: 100 },
    );
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
    if (originalNextEnvironment !== undefined) {
      await writeFile("apps/web/next-env.d.ts", originalNextEnvironment);
    }
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

  it("creates an autonomous Run from the Web UI and shows the reviewed diff", async () => {
    const page = await browser!.newPage();
    const runId = await startRunInBrowser(page, "Repair calculator subtraction");

    await expect
      .poll(async () => (await database.runs.findById(runId))?.status, { timeout: 90_000 })
      .toBe("SUCCEEDED");
    await page.getByText("SUCCEEDED", { exact: true }).first().waitFor({ timeout: 30_000 });
    await page.getByTestId("run-review").getByText(REVIEW_SUMMARY, { exact: true }).waitFor();
    await page
      .getByTestId("run-diff")
      .getByText(/return left - right/u)
      .waitFor();

    const run = await database.runs.findById(runId);
    expect(run?.executionMode).toBe("autonomous");
    const detail = await database.runs.findDetail(runId);
    expect(detail!.artifacts.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["REVIEW_REPORT", "DIFF"]),
    );
    expect(detail!.approvals).toEqual([]);
    await page.close();
  }, 180_000);

  it("shows a failed Run when the agent submits without changing anything", async () => {
    const page = await browser!.newPage();
    const runId = await startRunInBrowser(page, "Never changes anything");

    await expect
      .poll(async () => (await database.runs.findById(runId))?.status, { timeout: 90_000 })
      .toBe("FAILED");
    await page.getByText("FAILED", { exact: true }).first().waitFor({ timeout: 30_000 });
    const detail = await database.runs.findDetail(runId);
    expect(detail!.artifacts.some(({ kind }) => kind === "REVIEW_REPORT")).toBe(false);
    await page.close();
  }, 180_000);

  async function startRunInBrowser(page: Page, taskTitle: string): Promise<string> {
    await page.goto(webBaseUrl);
    const repositoryName = `calculator-${crypto.randomUUID().slice(0, 8)}`;
    const repositoryForm = page.getByTestId("repository-form");
    await repositoryForm.getByLabel("名称").fill(repositoryName);
    await repositoryForm.getByLabel("绝对路径").fill(workspace);
    await repositoryForm.getByRole("button", { name: "创建 Repository" }).click();

    const taskForm = page.getByTestId("task-form");
    await taskForm.getByLabel("Repository").selectOption({ label: repositoryName });
    await taskForm.getByLabel("标题").fill(taskTitle);
    await taskForm.getByLabel("需求描述").fill("Fix subtract so the existing test suite passes.");
    await taskForm.getByRole("button", { name: "创建 Task" }).click();

    const runForm = page.getByTestId("run-form");
    await runForm.getByLabel("Task").selectOption({ label: taskTitle });
    await runForm.getByRole("button", { name: "创建并启动 Run" }).click();
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/runs/");
    const runId = page.url().split("/runs/")[1]?.split(/[?#]/u)[0];
    if (runId === undefined || !/^[0-9a-f-]{36}$/u.test(runId))
      throw new Error("The browser did not navigate to a Run detail URL.");
    return runId;
  }
});

/** Fixes the fixture for the repair task; submits immediately for the no-change task. */
function solver(run: RunExecutionRecord): FakeLanguageModel {
  const submit = fakeModelResponse({
    toolCalls: [{ id: crypto.randomUUID(), name: "submit", input: { summary: "Done." } }],
    usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
  });
  if (run.task.title === "Never changes anything") return new FakeLanguageModel([submit]);
  return new FakeLanguageModel([
    fakeModelResponse({
      toolCalls: [
        {
          id: crypto.randomUUID(),
          name: "edit_file",
          input: {
            path: "src/calculator.js",
            old_text:
              "  // Intentional fixture bug: the agent should change + to -.\n  return left + right;",
            new_text: "  return left - right;",
          },
        },
      ],
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    }),
    submit,
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
