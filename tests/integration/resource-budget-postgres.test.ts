import { randomUUID } from "node:crypto";

import { PrismaDatabaseAdapter } from "@devflow/database";
import { describe, expect, it } from "vitest";

import {
  ResourceBudgetScheduler,
  type ResourceBudgetOperationPlan,
} from "../../apps/worker/src/runs/resource-budget-scheduler.js";

const enabled = process.env.DEVFLOW_RESOURCE_BUDGET_INTEGRATION === "1";

describe.skipIf(!enabled)("PostgreSQL resource ledger", () => {
  it("serializes reservation and settlement from independent database connections", async () => {
    await withDatabases(async (a, b) => {
      const run = await createRun(a);
      const parameters = {
        runId: run.id,
        limits: { tokens: 1_000, logicalToolCalls: 75, steps: 25 },
        startedAt: 1_000,
        deadlineAt: 1_501_000,
        clock: () => 1_000,
      };
      const [first, second] = await Promise.all([
        ResourceBudgetScheduler.open({ ...parameters, store: a.budgetLedgers }),
        ResourceBudgetScheduler.open({ ...parameters, store: b.budgetLedgers }),
      ]);
      const competing = await Promise.all([
        first.reserve("request-a", operation("model-a", 600)),
        second.reserve("request-b", operation("model-b", 600)),
      ]);
      expect(competing.filter((entry) => entry.reserved)).toHaveLength(1);
      const winner = competing[0]!.reserved ? "request-a" : "request-b";
      const admitted = await Promise.all([first.admit(winner), second.admit(winner)]);
      expect(admitted.filter((entry) => entry.admitted)).toHaveLength(1);
      await Promise.all([
        first.settle(winner, { tokens: 500 }),
        second.settle(winner, { tokens: 500 }),
      ]);
      const ledger = await first.snapshot();
      expect(ledger.consumed.tokens).toBe(500);
      expect(ledger.reservations[winner]?.status).toBe("SETTLED");
      expect((await a.budgetLedgers.get(run.id))?.revision).toBeGreaterThanOrEqual(3);
    });
  });

  it("retains inflight holds, consumption and original deadline through a real PLAN approval and new connection", async () => {
    await withDatabases(async (a, b) => {
      const run = await createRun(a);
      const owner = `resource-ledger-${randomUUID()}`;
      expect(await a.runs.claim(run.id, owner, 60_000)).not.toBeNull();
      const options = {
        runId: run.id,
        limits: { tokens: 1_000, logicalToolCalls: 75, steps: 25 },
        startedAt: 1_000,
        deadlineAt: 1_501_000,
        clock: () => 1_000,
      };
      const scheduler = await ResourceBudgetScheduler.open({ ...options, store: a.budgetLedgers });
      await scheduler.reconcileObservation("legacy-usage", {
        tokens: 100,
        steps: 2,
        logicalToolCalls: 5,
      });
      await scheduler.reserve("unknown-provider-request", operation("provider", 700));
      await scheduler.admit("unknown-provider-request");
      await scheduler.markUncertain(
        "unknown-provider-request",
        { timeMs: 100 },
        "local transport ended; provider usage unknown",
      );
      const paused = await a.runs.pauseForApproval(run.id, owner, {
        summary: "Extend the approved implementation scope",
        steps: [
          {
            id: "edit",
            title: "Update implementation",
            description: "Implement the approved behavior.",
          },
        ],
      });
      const resolution = await b.approvals.resolveForWorkflow(paused.approval.id, {
        status: "APPROVED",
      });
      expect(resolution.shouldEnqueue).toBe(true);
      const resumed = await ResourceBudgetScheduler.open({
        ...options,
        store: b.budgetLedgers,
        startedAt: 2_000,
        deadlineAt: 1_502_000,
        initialConsumed: {},
      });
      expect(await resumed.snapshot()).toMatchObject({
        deadlineAt: 1_501_000,
        consumed: { tokens: 100, steps: 2, logicalToolCalls: 5 },
      });
      expect((await resumed.quote(operation("too-large", 201))).fits).toBe(false);
      expect((await resumed.admit("unknown-provider-request")).reason).toBe("ALREADY_ADMITTED");
      await resumed.settle("unknown-provider-request", { tokens: 300 });
      expect((await scheduler.snapshot()).consumed).toMatchObject({ tokens: 400, timeMs: 100 });
    });
  });
});

function operation(id: string, tokens: number): ResourceBudgetOperationPlan {
  return {
    kind: "OPERATION",
    id,
    requirement: "REQUIRED",
    state: "PENDING",
    resources: { tokens },
  };
}

async function createRun(database: PrismaDatabaseAdapter) {
  const repository = await database.repositories.create({
    name: `budget-${randomUUID()}`,
    sourceKind: "GIT",
    sourceUri: "https://github.com/devflow/public-fixture.git",
  });
  const task = await database.tasks.create({
    repositoryId: repository.id,
    title: "Resource scheduling fixture",
    description: "Exercise atomic resource accounting.",
  });
  return (await database.runs.create({ taskId: task.id })).run;
}

async function withDatabases(
  execute: (a: PrismaDatabaseAdapter, b: PrismaDatabaseAdapter) => Promise<void>,
): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined) throw new Error("TEST_DATABASE_URL is required.");
  const a = PrismaDatabaseAdapter.fromConnectionString(url);
  const b = PrismaDatabaseAdapter.fromConnectionString(url);
  await Promise.all([a.connect(), b.connect()]);
  try {
    await execute(a, b);
  } finally {
    await Promise.all([a.disconnect(), b.disconnect()]);
  }
}
