import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeLanguageModel, fakeModelResponse, type ModelRequest } from "@devflow/agent";
import {
  PrismaDatabaseAdapter,
  type ArtifactRecord,
  type CreateArtifactInput,
  type DatabaseAdapter,
  type RunExecutionRecord,
  type RunTransitionInput,
} from "@devflow/database";
import { DockerSandboxManager } from "@devflow/sandbox";
import { DevflowError, type AgentEvent, type NewAgentEvent, type RunResult } from "@devflow/shared";

import {
  AUTONOMOUS_CHECKPOINT_ARTIFACT,
  AutonomousRunExecutor,
} from "../../apps/worker/src/autonomous/executor.js";
import { loadWorkerEnvironment } from "../../apps/worker/src/config/env.js";
import { RunProcessor } from "../../apps/worker/src/runs/run.processor.js";

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

function executor(
  database: DatabaseAdapter,
  model: FakeLanguageModel,
  reviewer = new FakeLanguageModel([
    step("review", "submit_review", {
      verdict: "PASS",
      findings: [],
      summary: "Fixture behaviour verified.",
    }),
  ]),
  created: string[] = [],
) {
  const environment = loadWorkerEnvironment({
    DATABASE_URL: "postgresql://devflow:devflow@localhost:5432/devflow",
    DEVFLOW_AUTONOMOUS_CHECKPOINT_TURNS: "1",
  });
  return new AutonomousRunExecutor(database, environment, {
    modelFactory: () => ({ model, settings: {}, bindingHash: "fake-binding" }),
    reviewModelFactory: () => ({
      model: reviewer,
      settings: {},
      bindingHash: "fake-review-binding",
    }),
    sandboxFactory: async (run) => {
      const session = await new DockerSandboxManager({
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
      });
      created.push(session.id);
      return session;
    },
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
    expect(result.metrics.modelCalls).toBe(6);
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
    // One settled call before interruption, two resumed solver calls and one review.
    expect(result.metrics.modelCalls).toBe(4);
    const started = memory.events.filter((e) => e.type === "RUN_STARTED");
    expect((started.at(-1)!.payload as { resumed: boolean }).resumed).toBe(true);
    expect(memory.artifacts.find((a) => a.kind === "DIFF")?.content).toContain(
      "+  return left - right;",
    );
  }, 300_000);

  it("sends Review FAIL to the same solver conversation, revises, verifies and reviews again to PASS", async () => {
    const memory = memoryDatabase(runRecord());
    const partialFix = "left === 7 && right === 4 ? left - right : left + right";
    const model = new FakeLanguageModel([
      step("1", "edit_file", {
        path: "src/calculator.js",
        old_text: BUG,
        new_text: BUG.replace("left + right", partialFix),
      }),
      step("2", "submit", { summary: "arithmetic corrected" }),
      async (request) => {
        expect(JSON.stringify(request.messages)).toContain("arithmetic corrected");
        expect(String(request.messages.at(-1)?.content)).toContain("subtract(5, 3) still adds");
        return step("3", "edit_file", {
          path: "src/calculator.js",
          old_text: partialFix,
          new_text: "left - right",
        });
      },
      step("4", "submit", { summary: "all operands now subtract" }),
    ]);
    const reviewer = new FakeLanguageModel([
      step("r1", "bash", {
        command:
          "node --input-type=module -e 'import { subtract } from \"./src/calculator.js\"; console.log(subtract(5, 3))'",
      }),
      step("r2", "submit_review", {
        verdict: "FAIL",
        findings: [
          {
            severity: "blocking",
            file: "src/calculator.js",
            line: 7,
            description: "subtract(5, 3) still adds",
            evidence: "node --input-type=module reproduction printed 8; Issue expects 2",
          },
        ],
        summary: "Scripted blocking feedback to exercise revision.",
      }),
      step("r3", "submit_review", { verdict: "PASS", findings: [], summary: "Revision verified." }),
    ]);
    const created: string[] = [];
    const result = (await executor(memory.database, model, reviewer, created).execute(
      memory.current(),
      AbortSignal.timeout(300_000),
    )) as RunResult;
    expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
    expect(created).toHaveLength(1);
    expect(
      memory.events
        .filter((event) => event.type === "REVIEW_RESULT")
        .map((event) => (event.payload as { verdict: string }).verdict),
    ).toEqual(["FAIL", "PASS"]);
    expect(memory.events.filter((event) => event.type === "TEST_RESULT")).toHaveLength(2);
    expect(memory.artifacts.filter((artifact) => artifact.kind === "REVIEW_REPORT")).toHaveLength(
      2,
    );
    expect(result.summary).toContain("Independent review: PASS");
  }, 300_000);

  it("uses a new sandbox after exhausted host revisions and delivers only the second attempt", async () => {
    const memory = memoryDatabase(runRecord());
    const model = new FakeLanguageModel([
      step("1", "edit_file", {
        path: "src/calculator.js",
        old_text: BUG,
        new_text: BUG.replace("left + right", "left * right"),
      }),
      step("2", "submit", { summary: "first attempt with wrong arithmetic" }),
      step("3", "submit", { summary: "first revision still wrong" }),
      step("4", "submit", { summary: "second revision still wrong" }),
      async (request) => {
        expect(request.messages).toHaveLength(2);
        expect(String(request.messages.at(-1)?.content)).toContain("Previous failed attempt");
        expect(JSON.stringify(request.messages)).not.toContain("left * right");
        return step("5", "edit_file", {
          path: "src/calculator.js",
          old_text: BUG,
          new_text: BUG.replace("left + right", "left - right"),
        });
      },
      step("6", "submit", { summary: "independent second attempt subtracts correctly" }),
    ]);
    const created: string[] = [];
    const result = (await executor(memory.database, model, undefined, created).execute(
      memory.current(),
      AbortSignal.timeout(300_000),
    )) as RunResult;
    expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
    expect(created).toHaveLength(2);
    expect(created[0]).not.toBe(created[1]);
    expect(result.summary).toContain("Selected attempt 2 of 2");
    const diff = memory.artifacts.find((artifact) => artifact.kind === "DIFF")!.content!;
    expect(diff).toContain("+  return left - right;");
    expect(diff).not.toContain("+  return left * right;");
    expect(memory.artifacts.map((artifact) => artifact.name)).toEqual(
      expect.arrayContaining([
        "autonomous-transcript-attempt-1.json",
        "autonomous-transcript-attempt-2.json",
      ]),
    );
    const checkpoint = JSON.parse(
      memory.artifacts
        .filter((artifact) => artifact.name === AUTONOMOUS_CHECKPOINT_ARTIFACT)
        .at(-1)!.content!,
    );
    expect(checkpoint.attempt).toBe(2);
  }, 300_000);
});

describe.skipIf(
  !process.env.TEST_DATABASE_URL || process.env.DEVFLOW_RESOURCE_BUDGET_INTEGRATION !== "1",
)("autonomous run through RunProcessor and PostgreSQL", () => {
  it("claims, executes in a LOCAL snapshot sandbox, persists events and artifacts, and completes", async () => {
    const database = PrismaDatabaseAdapter.fromConnectionString(process.env.TEST_DATABASE_URL!);
    await database.connect();
    try {
      const repository = await database.repositories.create({
        name: `autonomous-${randomUUID()}`,
        sourceKind: "LOCAL",
        sourceUri: fixture,
      });
      const task = await database.tasks.create({
        repositoryId: repository.id,
        title: "subtract adds instead of subtracting",
        description: "subtract(5, 3) returns 8; it should return 2.",
      });
      const run = (await database.runs.create({ taskId: task.id, executionMode: "autonomous" }))
        .run;
      expect(run.executionMode).toBe("autonomous");
      const model = new FakeLanguageModel([
        step("1", "edit_file", {
          path: "src/calculator.js",
          old_text: BUG,
          new_text: BUG.replace("left + right", "left - right"),
        }),
        step("2", "bash", { command: "npm test 2>&1 | tail -5" }),
        step("3", "submit", { summary: "subtract now subtracts" }),
      ]);
      const environment = loadWorkerEnvironment({
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
        DEVFLOW_SANDBOX_IMAGE: "devflow-sandbox:local",
      });
      const processor = new RunProcessor(
        database.runs,
        new AutonomousRunExecutor(database, environment, {
          modelFactory: () => ({ model, settings: {}, bindingHash: "fake-binding" }),
          reviewModelFactory: () => ({
            model: new FakeLanguageModel([
              step("review", "submit_review", {
                verdict: "PASS",
                findings: [],
                summary: "Fixture verified.",
              }),
            ]),
            settings: {},
            bindingHash: "fake-review-binding",
          }),
        }),
        { workerId: "autonomous-test", leaseMs: 60_000, cancellationPollMs: 1_000 },
      );
      const outcome = await processor.process({
        id: "job-autonomous",
        data: { version: 1, runId: run.id, dispatchRevision: run.dispatchRevision },
        opts: { attempts: 1 },
        attemptsMade: 0,
        timestamp: Date.now(),
      } as never);

      expect(outcome).toMatchObject({ outcome: "COMPLETED", status: "SUCCEEDED" });
      const stored = await database.runs.findById(run.id);
      expect(stored?.status).toBe("SUCCEEDED");
      expect(stored?.result?.metrics.modelCalls).toBe(4);
      const types = (await database.events.list(run.id)).map((e) => e.type);
      expect(types).toEqual(
        expect.arrayContaining([
          "RUN_STARTED",
          "LLM_REQUEST",
          "LLM_RESPONSE",
          "TOOL_RESULT",
          "TEST_RESULT",
          "DIFF_GENERATED",
          "RUN_COMPLETED",
        ]),
      );
      const artifacts = await database.artifacts.list(run.id);
      expect(artifacts.find((a) => a.kind === "DIFF")?.content).toContain(
        "+  return left - right;",
      );
      expect(artifacts.map((a) => a.name)).toEqual(
        expect.arrayContaining(["autonomous-transcript.json", "autonomous-verification.json"]),
      );
    } finally {
      await database.disconnect();
    }
  }, 300_000);
});
