import { expect, it } from "vitest";
import { InMemoryBudgetLedgerStore } from "@devflow/database";
import { projectTeamRequest } from "../src/team/context.js";
import { teamDigest, type TeamDecisionView } from "../src/team/engine.js";
import { ResourceBudgetScheduler } from "../src/runs/resource-budget-scheduler.js";
import { priceModelOperationPlan } from "../src/runs/resource-budget-runtime.js";
import { estimatePlanRequest, type PlanRequestEstimate } from "../src/runs/plan-agent-context.js";

const model = {
  generate: async () => {
    throw Error("Projection must not dispatch");
  },
};
function input(): TeamDecisionView {
  const evidence = (id: string, content: string) => ({
    id,
    runId: "run",
    repositoryId: "repo",
    sourceIdentity: "base",
    kind: "SOURCE_OBSERVATION" as const,
    path: id,
    fileSha256: "a".repeat(64),
    startLine: 1,
    endLine: 1,
    content,
    contentSha256: teamDigest(content),
    sourceOperationId: "read",
    supports: [],
    valid: true,
  });
  return {
    runId: "run",
    sourceIdentity: "base",
    agentId: "agent",
    role: "COORDINATOR",
    task: {
      title: "Preserve public behavior",
      description: "An explicit counterexample must remain visible",
    },
    assignments: [],
    board: [],
    inbox: [],
    history: [],
    limits: { concurrency: 2, maxInvestigators: 4, maxTasks: 12, maxMessages: 64 },
    evidence: [
      evidence("background", "optional context ".repeat(1600)),
      evidence("counter", "assert(actual === expected)"),
    ],
    counterevidence: [
      {
        id: "message",
        sequence: 1,
        from: "peer",
        to: "agent",
        taskId: "task",
        type: "CHALLENGE",
        body: "The current hypothesis is contradicted",
        evidenceIds: ["counter"],
        idempotencyKey: "message",
        sourceIdentity: "base",
      },
    ],
  };
}
const operation = (estimate: PlanRequestEstimate, priced = true) =>
  priceModelOperationPlan(
    {
      kind: "OPERATION",
      id: "decision",
      requirement: "REQUIRED",
      state: "PENDING",
      resources: {
        inputTokens: estimate.estimatedInputTokens,
        outputTokens: 8192,
        modelCalls: 1,
        steps: 1,
      },
    },
    () =>
      priced
        ? { inputMicrosPerMillionTokens: 8000000, outputMicrosPerMillionTokens: 28000000 }
        : undefined,
  );
async function scheduler(costMicros = 1400000) {
  const result = await ResourceBudgetScheduler.open({
    runId: "run",
    store: new InMemoryBudgetLedgerStore(),
    limits: { tokens: 320000, steps: 32, costMicros },
    startedAt: 0,
    deadlineAt: 1500000,
    clock: () => 0,
  });
  await result.replaceHold("downstream", {
    kind: "OPERATION",
    id: "validation-review",
    state: "PENDING",
    requirement: "REQUIRED",
    resources: { costMicros: 1100000, tokens: 70000, steps: 3 },
  });
  return result;
}
const capacity = { bytes: 96000, tokens: 32000, outputTokens: 8192 };

it("fits exact request cost by removing optional complete records without consuming shared reservations", async () => {
  const budget = await scheduler();
  const before = await projectTeamRequest(input(), model, AbortSignal.timeout(3000), capacity);
  expect((await budget.quote(operation(estimatePlanRequest(before.request)))).fits).toBe(false);
  const snapshot = await budget.snapshot();
  const after = await projectTeamRequest(input(), model, AbortSignal.timeout(3000), {
    ...capacity,
    quote: (e) => budget.quote(operation(e)),
  });
  expect(after.omitted).toEqual(["background"]);
  expect(after.shown.map((e) => e.id)).toEqual(["counter"]);
  expect(JSON.stringify(after.request)).toContain("assert(actual === expected)");
  expect(after.request.settings?.maxOutputTokens).toBe(8192);
  expect(after.audit.resourceTrimmed).toBe(true);
  expect(after.audit.resourceQuote?.fits).toBe(true);
  expect(await budget.snapshot()).toEqual(snapshot);
  const reserve = await budget.reserve(
    "actual-decision",
    operation(estimatePlanRequest(after.request)),
  );
  expect(reserve.reserved).toBe(true);
  expect(reserve.quote.planDigest).toBe(after.audit.resourceQuote?.planDigest);
  expect((await budget.admit("actual-decision")).admitted).toBe(true);
  expect((await budget.snapshot()).reservations.downstream?.status).toBe("RESERVED");
});

it("blocks mandatory evidence/output shortfalls before dispatch and preserves the deficit", async () => {
  const budget = await scheduler(1320000);
  await expect(
    projectTeamRequest(input(), model, AbortSignal.timeout(3000), {
      ...capacity,
      quote: (e) => budget.quote(operation(e)),
    }),
  ).rejects.toMatchObject({
    code: "EXECUTION_BUDGET_EXCEEDED",
    details: {
      requestIssued: false,
      stopReason: "RESOURCE_CAPACITY",
      requiredEvidenceIds: ["counter"],
      quote: { fits: false },
    },
  });
  expect((await budget.snapshot()).consumed.modelCalls).toBe(0);
});

it("does not remove evidence to conceal missing prices or bypass concurrent admission", async () => {
  const budget = await scheduler();
  await expect(
    projectTeamRequest(input(), model, AbortSignal.timeout(3000), {
      ...capacity,
      quote: (e) => budget.quote(operation(e, false)),
    }),
  ).rejects.toMatchObject({
    code: "EXECUTION_BUDGET_EXCEEDED",
    details: { omittedEvidenceIds: [], quote: { reason: "COST_UNKNOWN" } },
  });
  const after = await projectTeamRequest(input(), model, AbortSignal.timeout(3000), {
    ...capacity,
    quote: (e) => budget.quote(operation(e)),
  });
  await budget.reserve("sibling", {
    kind: "OPERATION",
    id: "sibling",
    requirement: "REQUIRED",
    state: "PENDING",
    resources: { costMicros: 100000 },
  });
  expect(
    (await budget.reserve("decision", operation(estimatePlanRequest(after.request)))).reserved,
  ).toBe(false);
});
