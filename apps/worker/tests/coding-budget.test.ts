import { expect, it } from "vitest";
import {
  codingBranchFrontier,
  codingContinuationReserve,
  codingPlannerTokenLease,
  codingReplanReserve,
  codingRequestReserve,
} from "../src/runs/coding-budget.js";
import { allocateCodingBudget, planAdaptiveBudget } from "../src/runs/workflow-budget.js";
import { PlanAgent } from "../src/runs/plan-agent.js";

const continuation = {
  title: "Preserve execution state",
  description: "Persist and restore the public completion status.",
  plan: { summary: "Update the serializer and its consumer." },
  diagnostics: [{ path: "src/state.test.ts", message: "Expected SKIPPED, received SUCCESS" }],
  source: "export function decode(status: string) { return status; }",
  codingOutput: 8192,
  reviewOutput: 16384,
  reviewRecoveryAvailable: true,
};

it("shares one coding decision pool across test failure without reserving a fresh Repair agent", () => {
  const active = codingContinuationReserve({ ...continuation, resumeCoding: false });
  const approval = codingContinuationReserve({ ...continuation, resumeCoding: true });
  expect(active.coding).toBe(0);
  expect(active.total).toBe(active.review + active.recovery);
  expect(approval.total - active.total).toBe(approval.codingInput + 8192);
  expect(approval.branch).toBe("REPLAN_THEN_CODING");
  const recovered = codingContinuationReserve({
    ...continuation,
    resumeCoding: false,
    reviewRecoveryAvailable: false,
  });
  expect(recovered.total).toBe(active.review);
});

it("reserves shared final validation once across mutually exclusive normal and replan paths", () => {
  const sharedFinal = { tokens: 52000, steps: 2, tools: 5, timeMs: 480000 };
  const continuing = { tokens: 25000, steps: 2, tools: 4, timeMs: 120000 };
  const replanning = { tokens: 60000, steps: 3, tools: 11, timeMs: 240000 };
  const frontier = codingBranchFrontier({ sharedFinal, continuing, replanning });
  expect(frontier.required).toEqual({ tokens: 112000, steps: 5, tools: 16, timeMs: 720000 });
  expect(frontier.accounting).toBe("RESERVE_ONLY_RECHECK_ACTUAL_REQUEST");
  expect(
    codingBranchFrontier({ sharedFinal, continuing, replanning, selectedBranch: "CONTINUE" })
      .required,
  ).toEqual({ tokens: 77000, steps: 4, tools: 9, timeMs: 600000 });
  expect(
    codingBranchFrontier({ sharedFinal, continuing, replanning, selectedBranch: "REPLAN" })
      .required,
  ).toEqual(frontier.required);
  expect(() =>
    codingBranchFrontier({ sharedFinal, continuing, selectedBranch: "REPLAN" }),
  ).toThrow();
});

it("preserves configured output and accounts for constructible input and explicit growth", () => {
  const request = {
    messages: [{ role: "USER" as const, content: "Current source and diagnostics" }],
    tools: [],
  };
  const reserve = codingRequestReserve({ ...request, maxOutputTokens: 16384, timeoutMs: 120000 });
  const larger = codingRequestReserve({
    ...request,
    maxOutputTokens: 32768,
    timeoutMs: 120000,
    additionalInputTokens: 3000,
  });
  expect(larger.required.tokens - reserve.required.tokens).toBe(16384 + 3000);
  expect(reserve.configuredOutputTokens).toBe(16384);
  expect(reserve.required.steps).toBe(1);
});

it("admits the E07 submission boundary without promising the unselected replan branch", () => {
  const sharedFinal = { tokens: 43574, steps: 2, tools: 15, timeMs: 780000 };
  const replanning = { tokens: 52054, steps: 3, tools: 26, timeMs: 240000 };
  const common = {
    sharedFinal,
    continuing: { tokens: 0, steps: 0, tools: 0, timeMs: 0 },
    replanning,
  };
  const coding = codingBranchFrontier({ ...common, operation: "CODING" });
  const submission = codingBranchFrontier({ ...common, operation: "SUBMIT_CURRENT" });
  expect(32838 + coding.required.tokens - 125638).toBe(2828);
  expect(submission.required).toEqual(sharedFinal);
  expect(32838 + submission.required.tokens).toBe(76412);
  expect(submission.released).toEqual(replanning);
  // A later actual conflict is still separately admitted from whatever capacity remains.
  expect(
    codingPlannerTokenLease({
      remainingTokens: 50000,
      downstreamTokens: sharedFinal.tokens,
      configuredMaximumTokens: 60000,
      requiredRequestTokens: 2671 + 2048 + 8192 + 25078,
    }),
  ).toMatchObject({ permitted: false, requestIssued: false });
  expect(codingBranchFrontier({ ...common, operation: "CODING" })).toEqual(coding);
});

it("early replan includes the same full output recovery used by actual Planner preparation", async () => {
  const prepared = await new PlanAgent().prepare({
    title: continuation.title,
    description: continuation.description,
    repositoryId: "budget-fixture",
    baseCommitSha: "a".repeat(40),
    workspaceRevision: 0,
    source: {
      manifest: async () => ({ entries: [], incomplete: false }),
      read: async () => {
        throw new Error("No source IO expected");
      },
    },
    signal: new AbortController().signal,
    limits: { maxTotalTokens: 60000, maxModelCalls: 2, finalOutputTokens: 8192 },
  });
  expect(prepared.status).toBe("READY");
  const reserve = codingReplanReserve({
    plannerContext: {
      title: continuation.title,
      issue: continuation.description,
      source: continuation.source,
    },
    plannerOutputTokens: 8192,
    plannerInputGrowthTokens: 3072,
    plannerTimeoutMs: 120000,
    codingMessages: [{ role: "USER", content: JSON.stringify(continuation) }],
    codingTools: [],
    codingOutputTokens: 8192,
    codingInputGrowthTokens: 1024,
    codingTimeoutMs: 60000,
  });
  expect(reserve.plannerRecoveryTokens).toBe(prepared.attempt.preflight!.repairReserveTokens);
  expect(reserve.plannerRecoveryTokens).toBeGreaterThan(8192 * 3);
  expect(reserve.required.tokens).toBe(
    reserve.plannerInputTokens +
      3072 +
      8192 +
      prepared.attempt.preflight!.repairReserveTokens +
      reserve.coding.required.tokens,
  );
  expect(reserve.required.steps).toBe(3);
  expect(reserve.required.timeMs).toBe(180000);
});

it("leases Planner from the selected global frontier and reports exact insufficiency without dispatch", () => {
  const blocked = codingPlannerTokenLease({
    remainingTokens: 133070,
    downstreamTokens: 105826,
    configuredMaximumTokens: 60000,
    requiredRequestTokens: 9664 + 8192 + 25078,
  });
  expect(blocked).toMatchObject({
    maxTotalTokens: 27244,
    missingTokens: 15690,
    permitted: false,
    requestIssued: false,
  });
  // A newly projected continuation can release redundant capacity. The old
  // downstream need is never silently ignored merely to force admission.
  expect(
    codingPlannerTokenLease({
      remainingTokens: 133070,
      downstreamTokens: 76000,
      configuredMaximumTokens: 60000,
      requiredRequestTokens: 42934,
    }),
  ).toMatchObject({
    maxTotalTokens: 57070,
    missingTokens: 0,
    permitted: true,
    requestIssued: false,
  });
  expect(
    codingPlannerTokenLease({
      remainingTokens: 50000,
      downstreamTokens: 60000,
      configuredMaximumTokens: 60000,
    }),
  ).toMatchObject({ maxTotalTokens: 0, missingTokens: 10000, permitted: false });
  expect(
    codingPlannerTokenLease({
      remainingTokens: 50000,
      downstreamTokens: 60000,
      configuredMaximumTokens: 60000,
      requiredRequestTokens: 42934,
    }),
  ).toMatchObject({ maxTotalTokens: 0, missingTokens: 52934, permitted: false });
});

it("keeps structured source records unescaped and retains both Review source sides and recovery", () => {
  const source = [
    {
      path: "src/state.ts",
      sha256: "a".repeat(64),
      snippet: 'export const value = "pending";\n'.repeat(80),
    },
  ];
  const structured = codingContinuationReserve({ ...continuation, source, resumeCoding: true });
  const nested = codingContinuationReserve({
    ...continuation,
    source: JSON.stringify(source),
    resumeCoding: true,
  });
  expect(structured.total).toBeLessThan(nested.total);
  expect(structured.reviewInput).toBeGreaterThan(structured.recoveryInput);
  expect(structured.configuredCodingOutput).toBe(8192);
  expect(structured.configuredReviewOutput).toBe(16384);
  expect(structured.recovery).toBe(structured.recoveryInput + 16384);
});

it("reconciles a prepared lease without refunding the same attempt's consumed tokens", () => {
  expect(
    codingPlannerTokenLease({
      remainingTokens: 80000,
      downstreamTokens: 30000,
      configuredMaximumTokens: 60000,
      consumedTokens: 20000,
      requiredRequestTokens: 41000,
    }),
  ).toMatchObject({ maxTotalTokens: 60000, missingTokens: 1000, permitted: false });
  expect(
    codingPlannerTokenLease({
      remainingTokens: 50000,
      downstreamTokens: 30000,
      configuredMaximumTokens: 60000,
      consumedTokens: 20000,
      requiredRequestTokens: 20000,
    }),
  ).toMatchObject({ maxTotalTokens: 40000, missingTokens: 0, permitted: true });
});

it("keeps final Review capacity and monotonic hard ceilings over test and approval resumptions", () => {
  const budget = planAdaptiveBudget({
    complexity: "COMPLEX",
    estimatedSteps: 12,
    confidence: 0.8,
    hardLimit: 25,
  });
  expect(allocateCodingBudget({ budget, consumedSteps: 4 })).toMatchObject({
    initialSteps: 19,
    maximumSteps: 19,
    repairReserve: 0,
    mandatoryDownstreamSteps: 2,
  });
  expect(allocateCodingBudget({ budget, consumedSteps: 10 })).toMatchObject({
    initialSteps: 13,
    maximumSteps: 13,
    repairReserve: 0,
  });
  expect(allocateCodingBudget({ budget, consumedSteps: 24 })).toMatchObject({
    initialSteps: 0,
    maximumSteps: 0,
    mandatoryDownstreamSteps: 1,
  });
  expect(
    allocateCodingBudget({ budget, consumedSteps: 22, remainingReviewRequests: 1 }),
  ).toMatchObject({ initialSteps: 2, maximumSteps: 2, mandatoryDownstreamSteps: 1 });
  expect(() => allocateCodingBudget({ budget, consumedSteps: 26 })).toThrow();
});
