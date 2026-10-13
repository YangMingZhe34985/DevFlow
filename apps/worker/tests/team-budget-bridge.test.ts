import { expect, it } from "vitest";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import type {
  BudgetLedgerRecord,
  BudgetLedgerStore,
  DatabaseAdapter,
  RunExecutionRecord,
  TeamStore,
} from "@devflow/database";
import type { TeamSnapshot } from "@devflow/shared";
import { loadWorkerEnvironment } from "../src/config/env.js";
import type { EvidencePack } from "../src/localization/contracts.js";
import {
  ResourceBudgetRuntime,
  resourceBudgetContext,
} from "../src/runs/resource-budget-runtime.js";
import { ResourceBudgetScheduler } from "../src/runs/resource-budget-scheduler.js";
import { createWorkflowMetrics } from "../src/runs/workflow-metrics.js";
import { investigateWithTeam } from "../src/team/workflow-bridge.js";

it("production bridge protects and transfers a current Coordinator projection, with one shared downstream reservation", async () => {
  // Deliberately in-memory transactional port; PostgreSQL lease/fencing is covered separately.
  let team: TeamSnapshot | null = null,
    ledger: BudgetLedgerRecord | null = null;
  const budgets: BudgetLedgerStore = {
    get: async () => structuredClone(ledger),
    compareAndSwap: async (_run, expected, value) => {
      if ((ledger?.revision ?? null) !== expected) return false;
      ledger = { revision: (expected ?? -1) + 1, value: structuredClone(value) };
      return true;
    },
  };
  const teams: TeamStore = {
    load: async () => structuredClone(team),
    compareAndSwap: async (_run, expected, next, _lease, budget) => {
      if (
        (team?.revision ?? null) !== expected ||
        (budget && ledger?.revision !== budget.expectedRevision)
      )
        return false;
      team = structuredClone(next);
      if (budget)
        ledger = { revision: budget.expectedRevision + 1, value: structuredClone(budget.value) };
      return true;
    },
  };
  const database = {
    teams,
    budgetLedgers: budgets,
    events: { append: async () => {} },
    artifacts: { create: async () => ({ id: "artifact" }) },
  } as unknown as DatabaseAdapter;
  const env = loadWorkerEnvironment({
    DATABASE_URL: "postgresql://offline.invalid/test",
    DEVFLOW_TEAM_ENABLED: "true",
    DEVFLOW_PLAN_AGENT_TIMEOUT_MS: "180000",
    LLM_PROVIDER: "openai-compatible",
    LLM_BASE_URL: "https://offline.invalid/v1",
    LLM_API_KEY: "offline-only",
    LLM_MODEL: "solver-fixture",
    LLM_LOCALIZATION_MAX_OUTPUT_TOKENS: "8192",
    LLM_PLANNER_MAX_OUTPUT_TOKENS: "8192",
    LLM_EXECUTE_MAX_OUTPUT_TOKENS: "8192",
    LLM_REVIEW_MAX_OUTPUT_TOKENS: "16384",
    DEVFLOW_MODEL_PRICES_JSON: JSON.stringify({
      "openai-compatible:solver-fixture": {
        inputMicrosPerMillionTokens: 8000000,
        outputMicrosPerMillionTokens: 28000000,
      },
    }),
  });
  const scheduler = await ResourceBudgetScheduler.open({
    runId: "run",
    store: budgets,
    startedAt: Date.now(),
    deadlineAt: Date.now() + 1400000,
    limits: { tokens: 320000, steps: 32, logicalToolCalls: 75, costMicros: 4000000 },
  });
  const runtime = new ResourceBudgetRuntime(scheduler, async () => {});
  let coordinatorCalls = 0,
    investigatorCalls = 0;
  const coordinator = new FakeLanguageModel([
    async () => {
      coordinatorCalls++;
      return fakeModelResponse({
        toolCalls: [],
        output: {
          summary: "Inspect evidence",
          actions: [
            {
              type: "DELEGATE",
              key: "behavior",
              goal: "Verify current public behavior",
              evidenceIds: [],
              dependsOn: [],
            },
          ],
        },
      });
    },
    async () => {
      coordinatorCalls++;
      const held = (await scheduler.snapshot()).reservations["team:shared-downstream"]!;
      expect(held.quote.operations.some((o) => o.id.startsWith("coordinator:"))).toBe(false);
      expect(held.quote.operations.some((o) => o.id === "review:bounded-recovery")).toBe(true);
      return fakeModelResponse({
        toolCalls: [],
        output: {
          summary: "Submit public evidence",
          actions: [
            {
              type: "PROPOSE_PLAN",
              evidenceIds: [],
              missing: ["Implementation remains a hypothesis"],
            },
          ],
        },
      });
    },
  ]);
  const investigator = new FakeLanguageModel([
    async () => {
      investigatorCalls++;
      const held = (await scheduler.snapshot()).reservations["team:shared-downstream"]!;
      expect(
        held.quote.operations.filter((o) => o.id === "coordinator:closing-current-projection"),
      ).toHaveLength(1);
      expect(
        held.quote.operations.find((o) => o.id === "coordinator:closing-current-projection")
          ?.resources.outputTokens,
      ).toBe(8192);
      return fakeModelResponse({
        toolCalls: [],
        output: {
          summary: "Report bounded uncertainty",
          actions: [
            {
              type: "RESULT",
              evidenceIds: [],
              hypotheses: [],
              missing: ["No source currently needed"],
            },
          ],
        },
      });
    },
  ]);
  const run = {
    id: "run",
    executionOwner: "worker",
    dispatchRevision: 0,
    maxSteps: 32,
    executionMode: "team",
    localizationMode: "prg",
    task: {
      title: "Public task",
      description: "Check whether current behavior matches the public requirement",
    },
    repository: { id: "repo" },
  } as RunExecutionRecord;
  await resourceBudgetContext.run(runtime, () =>
    investigateWithTeam({
      database,
      run,
      environment: env,
      source: {
        identity: "base",
        manifest: async () => ({ entries: [], incomplete: false }),
        read: async () => {
          throw new Error("Unexpected IO");
        },
      },
      baseCommit: "a".repeat(40),
      evidence: {
        evidence: [],
        missingInformation: [],
        viewRevision: "base",
      } as unknown as EvidencePack,
      signal: new AbortController().signal,
      metrics: createWorkflowMetrics(),
      roleModelFactory: (role) => (role === "INVESTIGATOR" ? investigator : coordinator),
    }),
  );
  expect(coordinatorCalls).toBe(2);
  expect(investigatorCalls).toBe(1);
  const final = await scheduler.snapshot();
  expect(final.reservations["team:shared-downstream"]?.status).toBe("RELEASED");
  expect(final.consumed.modelCalls).toBe(3);
  expect(final.consumed.steps).toBe(3);
  expect((await teams.load("run"))?.status).toBe("READY_FOR_PLAN");
});
