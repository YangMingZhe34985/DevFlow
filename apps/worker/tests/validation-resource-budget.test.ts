import { describe, expect, it, vi } from "vitest";

import {
  InMemoryBudgetLedgerStore,
  type DatabaseAdapter,
  type RunExecutionRecord,
} from "@devflow/database";
import type { SandboxSession } from "@devflow/sandbox";

import { loadWorkerEnvironment } from "../src/config/env.js";
import { ApprovalWorkflowRunExecutor } from "../src/runs/approval-workflow-run-executor.js";
import { ResourceBudgetScheduler } from "../src/runs/resource-budget-scheduler.js";
import {
  resourceBudgetContext,
  ResourceBudgetRuntime,
} from "../src/runs/resource-budget-runtime.js";
import { createWorkflowMetrics, recordToolWork } from "../src/runs/workflow-metrics.js";

const command = { program: "npm", args: ["test"], cwd: ".", environment: {} };
const result = {
  exitCode: 0,
  stdout: "passed",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  outputTruncated: false,
};

async function fixture(toolLimit = 75) {
  const store = new InMemoryBudgetLedgerStore();
  const now = Date.now();
  const scheduler = await ResourceBudgetScheduler.open({
    runId: "validation-run",
    store,
    limits: { logicalToolCalls: toolLimit },
    startedAt: now,
    deadlineAt: now + 1_500_000,
  });
  const runtime = new ResourceBudgetRuntime(scheduler, async () => {});
  const database = {
    budgetLedgers: store,
    runs: { transition: vi.fn(async () => ({})) },
    artifacts: { create: vi.fn(async () => ({})) },
    events: { append: vi.fn(async () => {}) },
  } as unknown as DatabaseAdapter;
  const worker = new ApprovalWorkflowRunExecutor(
    database,
    loadWorkerEnvironment({ DATABASE_URL: "unused" }),
  );
  return { store, scheduler, runtime, worker, run: { id: "validation-run" } as RunExecutionRecord };
}

describe("Worker validation resource admission", () => {
  it("persists discovery and every public check before dispatch, then updates legacy metrics without double charging", async () => {
    const f = await fixture();
    const observed: number[] = [];
    const observe = async () => {
      observed.push((await f.scheduler.snapshot()).consumed.logicalToolCalls);
    };
    const sandbox = {
      listFiles: async () => {
        await observe();
        return { entries: [{ path: "package.json" }] };
      },
      readFile: async () => {
        await observe();
        return { content: JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }) };
      },
      exec: async () => {
        await observe();
        return result;
      },
    } as unknown as SandboxSession;
    await resourceBudgetContext.run(f.runtime, async () => {
      const tested = await f.worker["runTests"](
        f.run,
        sandbox,
        AbortSignal.timeout(10_000),
        0,
        { detected: false },
        "EXECUTE",
      );
      expect(tested).toMatchObject({ exitCode: 0, toolExecutions: 4, logicalWorkAccounted: true });
      const metrics = createWorkflowMetrics();
      recordToolWork(metrics, "TEST", {
        calls: tested.toolExecutions,
        executions: tested.toolExecutions,
        alreadyAccounted: tested.logicalWorkAccounted,
      });
      await f.runtime.flush();
      expect(metrics.toolCalls).toBe(4);
      expect((await f.scheduler.snapshot()).consumed.logicalToolCalls).toBe(4);
    });
    expect(observed).toEqual([1, 2, 3, 4]);
  });

  it("stops before the first command that cannot be admitted and preserves completed checks", async () => {
    const f = await fixture(1);
    const exec = vi.fn(async () => result);
    const profile = {
      version: 1 as const,
      checks: ["build", "test"].map((kind) => ({
        kind: kind as "build" | "test",
        source: "public package scripts",
        command,
      })),
    };
    const tested = await resourceBudgetContext.run(f.runtime, () =>
      f.worker["runTests"](
        f.run,
        { exec } as unknown as SandboxSession,
        AbortSignal.timeout(10_000),
        0,
        { detected: true, profile },
        "EXECUTE",
      ),
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(
      tested.publicVerification?.checks
        .filter((check) => check.status !== "NOT_CONFIGURED")
        .map((check) => check.status),
    ).toEqual(["PASS", "NOT_RUN"]);
    expect(tested.exitCode).not.toBe(0);
    expect((await f.scheduler.snapshot()).consumed.logicalToolCalls).toBe(1);
  });

  it("uses the same pre-command admission for legacy single-command validation", async () => {
    const f = await fixture();
    const exec = vi.fn(async () => {
      expect((await f.scheduler.snapshot()).consumed.logicalToolCalls).toBe(1);
      return result;
    });
    const tested = await resourceBudgetContext.run(f.runtime, () =>
      f.worker["runTests"](
        f.run,
        { exec } as unknown as SandboxSession,
        AbortSignal.timeout(10_000),
        0,
        { detected: true, command },
        "EXECUTE",
      ),
    );
    expect(tested.exitCode).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("retains a command's debit after transport failure and cannot replay its identity on resume", async () => {
    const f = await fixture();
    const exec = vi.fn(async () => {
      throw new Error("sandbox disconnected during public check");
    });
    const invoke = (runtime: ResourceBudgetRuntime) =>
      resourceBudgetContext.run(runtime, () =>
        f.worker["runTests"](
          f.run,
          { exec } as unknown as SandboxSession,
          AbortSignal.timeout(10_000),
          0,
          { detected: true, command },
          "EXECUTE",
        ),
      );
    expect((await invoke(f.runtime)).exitCode).not.toBe(0);
    const resumed = new ResourceBudgetRuntime(f.scheduler, async () => {});
    expect((await invoke(resumed)).exitCode).not.toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect((await f.scheduler.snapshot()).consumed.logicalToolCalls).toBe(1);
  });

  it("admits a new Review repair retest without reusing the preceding Test repair identity", async () => {
    const f = await fixture();
    const exec = vi.fn(async () => result);
    const invoke = (cycle: string) =>
      resourceBudgetContext.run(f.runtime, () =>
        f.worker["runTests"](
          f.run,
          { exec } as unknown as SandboxSession,
          AbortSignal.timeout(10_000),
          1,
          { detected: true, command },
          "FIX",
          undefined,
          cycle,
        ),
      );
    expect((await invoke("test:1:review:0:coding-step:3")).exitCode).toBe(0);
    expect((await invoke("test:1:review:1:coding-step:4")).exitCode).toBe(0);
    // Re-entering that same persisted Review cycle cannot issue another command.
    expect((await invoke("test:1:review:1:coding-step:4")).exitCode).not.toBe(0);
    expect(exec).toHaveBeenCalledTimes(2);
    expect((await f.scheduler.snapshot()).consumed.logicalToolCalls).toBe(2);
  });
});
