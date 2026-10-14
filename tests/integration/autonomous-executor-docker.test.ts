import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeLanguageModel, fakeModelResponse, type ModelRequest } from "@devflow/agent";
import type {
  ArtifactRecord,
  CreateArtifactInput,
  DatabaseAdapter,
  RunExecutionRecord,
  RunTransitionInput,
} from "@devflow/database";
import { DockerSandboxManager } from "@devflow/sandbox";
import { DevflowError, type AgentEvent, type NewAgentEvent, type RunResult } from "@devflow/shared";

import {
  AUTONOMOUS_CHECKPOINT_ARTIFACT,
  AutonomousRunExecutor,
} from "../../apps/worker/src/autonomous/executor.js";
import { loadWorkerEnvironment } from "../../apps/worker/src/config/env.js";

const enabled =
  process.env.DEVFLOW_RESOURCE_BUDGET_INTEGRATION === "1" ||
  process.env.DEVFLOW_AUTONOMOUS_DOCKER === "1";
const fixture = path.resolve("tests/fixtures/calculator-bug");
const BUG = "  // Intentional fixture bug: the agent should change + to -.\n  return left + right;";

function memoryDatabase(
  initial: RunExecutionRecord,
  failEvent?: (event: NewAgentEvent) => boolean,
) {
  const events: AgentEvent[] = [];
  const artifacts: ArtifactRecord[] = [];
  let run = { ...initial };
  const append = async (event: NewAgentEvent): Promise<AgentEvent> => {
    if (failEvent?.(event)) {
      failEvent = undefined;
      throw new DevflowError({
        code: "DATABASE_FAILED",
        message: "injected outage",
        retryable: true,
      });
    }
    const stored = {
      schemaVersion: 1 as const,
      eventId: randomUUID(),
      sequence: events.length + 1,
      level: event.level ?? ("INFO" as const),
      ...event,
    } as AgentEvent;
    events.push(stored);
    return stored;
  };
  const database = {
    runs: {
      findById: async () => run,
      transition: async (input: RunTransitionInput) => {
        if (run.status !== input.expectedStatus) throw new Error("status changed");
        run = { ...run, status: input.status, currentStage: input.currentStage };
        return { run, event: await append(input.event) };
      },
    },
    artifacts: {
      create: async (input: CreateArtifactInput) => {
        const record = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          ...input,
        } as unknown as ArtifactRecord;
        artifacts.push(record);
        return record;
      },
      list: async () => artifacts,
    },
    events: { append, list: async () => events },
  } as unknown as DatabaseAdapter;
  return { database, events, artifacts, current: () => run };
}

function runRecord(): RunExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    taskId: randomUUID(),
    status: "RUNNING",
    currentStage: "START",
    executionMode: "autonomous",
    maxSteps: 30,
    maxTestRetries: 2,
    maxReviewRetries: 1,
    dispatchRevision: 0,
    retryCount: 0,
    cancellationRequested: false,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    task: {
      id: randomUUID(),
      repositoryId: randomUUID(),
      title: "subtract adds instead of subtracting",
      description: "subtract(5, 3) returns 8; it should return 2.",
    },
    repository: { id: randomUUID(), sourceKind: "LOCAL", sourceUri: fixture },
  } as unknown as RunExecutionRecord;
}

function executor(database: DatabaseAdapter, model: FakeLanguageModel) {
  const environment = loadWorkerEnvironment({
    DATABASE_URL: "postgresql://devflow:devflow@localhost:5432/devflow",
    DEVFLOW_AUTONOMOUS_CHECKPOINT_TURNS: "1",
  });
  return new AutonomousRunExecutor(database, environment, {
    modelFactory: () => ({ model, settings: {}, bindingHash: "fake-binding" }),
    sandboxFactory: async (run) =>
      await new DockerSandboxManager({
        image: "devflow-sandbox:local",
        workspaceRoot: path.resolve("tests/fixtures"),
      }).create({
        runId: run.id,
        repository: { sourceUri: fixture },
        limits: {
          cpuCount: 1,
          memoryMb: 1024,
          pids: 128,
          timeoutMs: 120_000,
          networkEnabled: false,
        },
      }),
  });
}

const step = (id: string, name: string, input: unknown) =>
  fakeModelResponse({ toolCalls: [{ id, name, input }] });

describe.skipIf(!enabled)("autonomous executor in Docker", () => {
  it("revises in the same session after host verification fails, then delivers a verified diff", async () => {
    const memory = memoryDatabase(runRecord());
    const model = new FakeLanguageModel([
      step("1", "bash", { command: "cat src/calculator.js" }),
      step("2", "edit_file", {
        path: "/workspace/src/calculator.js",
        old_text: BUG,
        new_text: BUG.replace("left + right", "left * right"),
      }),
      step("3", "submit", { summary: "first attempt" }),
      async (request: ModelRequest) => {
        const feedback = request.messages.at(-1);
        expect(feedback).toMatchObject({ role: "USER" });
        expect(String(feedback?.content)).toContain("test failed");
        return step("4", "edit_file", {
          path: "src/calculator.js",
          old_text: "return left * right;",
          new_text: "return left - right;",
        });
      },
      step("5", "submit", { summary: "subtract now subtracts" }),
    ]);
    const result = (await executor(memory.database, model).execute(
      memory.current(),
      AbortSignal.timeout(300_000),
    )) as RunResult;

    expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
    expect(result.summary).toContain("Independent host verification passed");
    expect(result.metrics.modelCalls).toBe(5);
    const tests = memory.events.filter((e) => e.type === "TEST_RESULT");
    expect(tests.map((e) => (e.payload as { passed: boolean }).passed)).toEqual([false, true]);
    const diff = memory.artifacts.find((a) => a.kind === "DIFF")?.content ?? "";
    expect(diff).toContain("+  return left - right;");
    expect(memory.current().currentStage).toBe("GENERATE_DIFF");
    expect(memory.events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "RUN_STARTED",
        "LLM_REQUEST",
        "LLM_RESPONSE",
        "TOOL_RESULT",
        "DIFF_GENERATED",
      ]),
    );
  }, 300_000);

  it("resumes from its checkpoint after an interrupted dispatch, keeping workspace, transcript and spending", async () => {
    const initial = runRecord();
    // The second turn's request event fails as if the database dropped mid-run.
    const memory = memoryDatabase(
      initial,
      (event) => event.type === "LLM_REQUEST" && (event.payload as { turn: number }).turn === 2,
    );
    const first = new FakeLanguageModel([
      step("1", "edit_file", {
        path: "src/calculator.js",
        old_text: BUG,
        new_text: BUG.replace("left + right", "left - right"),
      }),
    ]);
    await expect(
      executor(memory.database, first).execute(memory.current(), AbortSignal.timeout(300_000)),
    ).rejects.toMatchObject({ code: "DATABASE_FAILED" });
    expect(memory.artifacts.some((a) => a.name === AUTONOMOUS_CHECKPOINT_ARTIFACT)).toBe(true);

    const second = new FakeLanguageModel([
      async (request: ModelRequest) => {
        // The resumed transcript still holds the first dispatch's edit.
        expect(JSON.stringify(request.messages)).toContain("left - right");
        return step("2", "bash", { command: "git diff --stat" });
      },
      step("3", "submit", { summary: "resumed and submitted" }),
    ]);
    const result = (await executor(memory.database, second).execute(
      memory.current(),
      AbortSignal.timeout(300_000),
    )) as RunResult;

    expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
    // One settled call from the interrupted dispatch plus two after resuming.
    expect(result.metrics.modelCalls).toBe(3);
    const started = memory.events.filter((e) => e.type === "RUN_STARTED");
    expect((started.at(-1)!.payload as { resumed: boolean }).resumed).toBe(true);
    expect(memory.artifacts.find((a) => a.kind === "DIFF")?.content).toContain(
      "+  return left - right;",
    );
  }, 300_000);
});
