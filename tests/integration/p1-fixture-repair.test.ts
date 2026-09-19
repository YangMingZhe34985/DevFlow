import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  DefaultAgentRuntime,
  FakeLanguageModel,
  JsonFileAgentStateStore,
  fakeModelResponse,
  type ModelToolDescriptor,
} from "@devflow/agent";
import { SandboxGitService } from "@devflow/git";
import { DockerSandboxManager, type CommandResult, type SandboxSession } from "@devflow/sandbox";
import {
  DefaultToolExecutor,
  ExplicitToolPolicy,
  registerCoreTools,
  ToolRegistry,
  type ToolExecutionRequest,
} from "@devflow/tools";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const dockerIt = process.env.DEVFLOW_DOCKER_INTEGRATION === "1" ? it : it.skip;
const fixturePath = path.resolve("tests/fixtures/calculator-bug");

const repairedCalculator = `export function add(left, right) {
  return left + right;
}

export function subtract(left, right) {
  return left - right;
}
`;

describe("P1 Docker fixture repair", () => {
  dockerIt(
    "repairs the fixture, passes tests, produces a diff and cleans up",
    async () => {
      const runId = randomUUID();
      const manager = createManager();
      const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "devflow-p2-state-"));
      const stateStore = new JsonFileAgentStateStore(stateDirectory);
      let sandbox: SandboxSession | undefined;
      let sandboxId = "";
      try {
        sandbox = await createSandbox(manager, runId);
        sandboxId = sandbox.id;
        await initializeFixtureRepository(sandbox);

        const git = new SandboxGitService();
        const registry = new ToolRegistry();
        registerCoreTools(registry, git);
        const executor = new DefaultToolExecutor(
          registry,
          new ExplicitToolPolicy(["READ", "WRITE", "EXECUTE", "GIT"]),
        );
        const tools: ModelToolDescriptor[] = registry.list().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
        const model = new FakeLanguageModel([
          fakeModelResponse({
            toolCalls: [{ id: "1", name: "listFiles", input: { path: "." } }],
          }),
          fakeModelResponse({
            toolCalls: [{ id: "2", name: "readFile", input: { path: "test/calculator.test.js" } }],
          }),
          fakeModelResponse({
            toolCalls: [{ id: "3", name: "readFile", input: { path: "src/calculator.js" } }],
          }),
          fakeModelResponse({
            toolCalls: [
              {
                id: "4",
                name: "writeFile",
                input: { path: "src/calculator.js", content: repairedCalculator },
              },
            ],
          }),
          fakeModelResponse({
            toolCalls: [{ id: "5", name: "runCommand", input: { program: "npm", args: ["test"] } }],
          }),
          fakeModelResponse({
            toolCalls: [{ id: "6", name: "gitDiff", input: {} }],
          }),
          fakeModelResponse({ toolCalls: [], text: "Fixed subtract; calculator tests pass." }),
        ]);
        const cancellation = new AbortController();
        const runtime = new DefaultAgentRuntime(model);
        const result = await runtime.run(
          { maxSteps: 10, timeoutMs: 120_000, maxRetries: 0 },
          {
            runId,
            task: {
              taskId: randomUUID(),
              repositoryId: randomUUID(),
              title: "Fix the calculator tests",
              description: "Fix the bug causing the calculator tests to fail.",
            },
            signal: cancellation.signal,
            tools,
            stateStore,
            async emit() {},
            executeTool: async (
              stepId,
              request: ToolExecutionRequest,
              signal = cancellation.signal,
            ) =>
              executor.execute(request, {
                runId,
                stepId,
                sandbox: sandbox as SandboxSession,
                signal,
                async emit() {},
              }),
          },
        );

        expect(result.status).toBe("SUCCEEDED");
        const persistedState = await stateStore.load(runId);
        expect(persistedState).toMatchObject({
          runId,
          phase: "COMPLETED",
          stepCount: 7,
          metrics: {
            modelCalls: 7,
            toolCalls: 6,
            retries: 0,
            tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
          finalResult: { runId, status: "SUCCEEDED" },
        });
        const rawState = JSON.parse(
          await readFile(path.join(stateDirectory, `${runId}.json`), "utf8"),
        ) as Record<string, unknown>;
        expect(rawState).toHaveProperty("metrics.modelLatencyMs");
        expect(rawState).toHaveProperty("metrics.toolLatencyMs");
        expect(rawState).toHaveProperty("finalResult.metrics.tokenUsage.totalTokens");
        const unicode = await sandbox.exec({
          program: "node",
          args: ["-e", "process.stdout.write('测试通过：你好，DevFlow 🚀')"],
        });
        expect(unicode.stdout).toBe("测试通过：你好，DevFlow 🚀");
        const tests = await sandbox.exec({ program: "npm", args: ["test"], timeoutMs: 30_000 });
        expect(tests.exitCode).toBe(0);
        expect(tests.stdout).toContain("pass");
        const diff = await git.diff(sandbox);
        expect(diff.patch).toContain("return left - right");
        expect(diff.filesChanged).toBe(1);
      } finally {
        await sandbox?.dispose();
        await rm(stateDirectory, { recursive: true, force: true });
      }

      expect(await containerExists(sandboxId)).toBe(false);
    },
    180_000,
  );

  dockerIt(
    "cleans up after an agent limit failure",
    async () => {
      const runId = randomUUID();
      const manager = createManager();
      const sandbox = await createSandbox(manager, runId);
      const sandboxId = sandbox.id;
      try {
        const model = new FakeLanguageModel([
          fakeModelResponse({
            toolCalls: [{ id: "limit", name: "readFile", input: { path: "package.json" } }],
          }),
        ]);
        const result = await new DefaultAgentRuntime(model).run(
          { maxSteps: 1, timeoutMs: 30_000, maxRetries: 0 },
          {
            runId,
            task: {
              taskId: randomUUID(),
              repositoryId: randomUUID(),
              title: "Limit test",
              description: "Exercise cleanup after failure.",
            },
            signal: new AbortController().signal,
            tools: [],
            async emit() {},
            async executeTool() {
              return { ok: true, output: {}, durationMs: 0 };
            },
          },
        );
        expect(result.error?.code).toBe("MAX_STEPS_EXCEEDED");
      } finally {
        await sandbox.dispose();
      }
      expect(await containerExists(sandboxId)).toBe(false);
    },
    120_000,
  );
});

function createManager(): DockerSandboxManager {
  return new DockerSandboxManager({
    image: "devflow-sandbox:local",
    workspaceRoot: fixturePath,
  });
}

async function createSandbox(manager: DockerSandboxManager, runId: string) {
  return await manager.create({
    runId,
    repository: { sourceUri: pathToFileURL(fixturePath).href },
    limits: {
      cpuCount: 1,
      memoryMb: 512,
      pids: 64,
      timeoutMs: 120_000,
      networkEnabled: false,
    },
  });
}

async function initializeFixtureRepository(sandbox: SandboxSession): Promise<void> {
  await expectSuccess(sandbox.exec({ program: "git", args: ["init", "-b", "main"] }));
  await expectSuccess(
    sandbox.exec({ program: "git", args: ["config", "user.email", "fixture@devflow.local"] }),
  );
  await expectSuccess(
    sandbox.exec({ program: "git", args: ["config", "user.name", "DevFlow Fixture"] }),
  );
  await expectSuccess(sandbox.exec({ program: "git", args: ["add", "."] }));
  await expectSuccess(sandbox.exec({ program: "git", args: ["commit", "-m", "fixture baseline"] }));
}

async function expectSuccess(promise: Promise<CommandResult>): Promise<void> {
  const result = await promise;
  expect(result.exitCode, result.stderr).toBe(0);
}

async function containerExists(containerId: string): Promise<boolean> {
  if (containerId.length === 0) return false;
  try {
    await execFileAsync("docker", ["inspect", containerId], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
