import { estimateModelInput, type ModelMessage, type ModelToolDescriptor } from "@devflow/agent";
import { repairContinuationReserve } from "./repair-reserve.js";
import { estimatePlanOutputRecoveryReserve } from "./plan-agent.js";
import { estimatePlanRequest } from "./plan-agent-context.js";
import { PlanProposalSchema } from "@devflow/shared";
import { PROPOSAL_PROMPT } from "./plan-proposal.js";

/** Capacity reserved for a reachable branch, never added to consumed metrics. */
export interface CodingCapacity {
  tokens: number;
  steps: number;
  tools: number;
  timeMs: number;
}

export type CodingBudgetBranch = "CONTINUE" | "REPLAN";

/**
 * Final Validation and Independent Review belong to both branches. Reserve them
 * once, then the larger reachable alternative in each resource dimension.
 * Selecting a branch transfers the reservation instead of charging it again.
 */
export function codingBranchFrontier(input: {
  sharedFinal: CodingCapacity;
  continuing: CodingCapacity;
  replanning?: CodingCapacity;
  selectedBranch?: CodingBudgetBranch;
}) {
  const shared = capacity(input.sharedFinal);
  const continuing = capacity(input.continuing);
  const replanning = input.replanning && capacity(input.replanning);
  if (input.selectedBranch === "REPLAN" && !replanning)
    throw new Error("A selected REPLAN branch requires its operation projection.");
  const selected =
    input.selectedBranch === "CONTINUE"
      ? continuing
      : input.selectedBranch === "REPLAN"
        ? replanning!
        : maximum(continuing, replanning ?? zero());
  return {
    accounting: "RESERVE_ONLY_RECHECK_ACTUAL_REQUEST" as const,
    selectedBranch: input.selectedBranch ?? "UNDECIDED",
    sharedFinal: shared,
    continuing,
    ...(replanning ? { replanning } : {}),
    required: add(shared, selected),
  };
}

/** Estimates the exact currently constructible request, retaining its output cap. */
export function codingRequestReserve(input: {
  messages: readonly ModelMessage[];
  tools: readonly ModelToolDescriptor[];
  maxOutputTokens: number;
  timeoutMs: number;
  /** Explicit allowance for future source/diagnostic growth, not hidden input. */
  additionalInputTokens?: number;
}) {
  const estimatedInputTokens = estimateModelInput(input.messages, input.tools);
  const configuredOutputTokens = integer(input.maxOutputTokens, "maxOutputTokens", 1);
  const inputGrowthTokens = integer(input.additionalInputTokens ?? 0, "additionalInputTokens");
  return {
    estimatedInputTokens,
    configuredOutputTokens,
    inputGrowthTokens,
    required: {
      tokens: estimatedInputTokens + configuredOutputTokens + inputGrowthTokens,
      steps: 1,
      tools: 0,
      timeMs: integer(input.timeoutMs, "timeoutMs", 1),
    },
  };
}

/**
 * Minimal reachable replan: current planning evidence, its configured output and
 * exact existing format recovery, followed by one compact Coding decision.
 * Final Validation/Review and the active correction credit are shared by the
 * outer frontier; they must not be added to this mutually exclusive branch.
 * Unknown new targets can enlarge input, so an explicit growth allowance is
 * retained and the actual prepared Planner request is preflighted again.
 */
export function codingReplanReserve(input: {
  plannerContext: unknown;
  plannerOutputTokens: number;
  plannerFormatRepairOutputTokens?: number;
  plannerInputGrowthTokens: number;
  plannerTimeoutMs: number;
  codingMessages: readonly ModelMessage[];
  codingTools: readonly ModelToolDescriptor[];
  codingOutputTokens: number;
  codingInputGrowthTokens: number;
  codingTimeoutMs: number;
}) {
  const plannerOutputTokens = integer(input.plannerOutputTokens, "plannerOutputTokens", 1);
  const plannerFormatRepairOutputTokens = integer(
    input.plannerFormatRepairOutputTokens ?? plannerOutputTokens,
    "plannerFormatRepairOutputTokens",
    1,
  );
  const plannerInputGrowthTokens = integer(
    input.plannerInputGrowthTokens,
    "plannerInputGrowthTokens",
  );
  const plannerInputTokens = estimatePlanRequest({
    messages: [
      { role: "SYSTEM", content: PROPOSAL_PROMPT },
      { role: "USER", content: JSON.stringify(input.plannerContext) },
    ],
    tools: [],
    output: {
      name: "plan_proposal",
      description: "A concise, safe and testable software implementation plan.",
      schema: PlanProposalSchema,
    },
    settings: { maxOutputTokens: plannerOutputTokens },
  }).estimatedInputTokens;
  const plannerRecoveryTokens = estimatePlanOutputRecoveryReserve({
    finalOutputTokens: plannerOutputTokens,
    formatRepairOutputTokens: plannerFormatRepairOutputTokens,
  });
  const coding = codingRequestReserve({
    messages: input.codingMessages,
    tools: input.codingTools,
    maxOutputTokens: input.codingOutputTokens,
    timeoutMs: input.codingTimeoutMs,
    additionalInputTokens: input.codingInputGrowthTokens,
  });
  return {
    kind: "MINIMUM_REPLAN_BRANCH" as const,
    accounting: "RESERVE_ONLY_RECHECK_ACTUAL_REQUEST" as const,
    plannerInputTokens,
    plannerInputGrowthTokens,
    plannerOutputTokens,
    plannerRecoveryTokens,
    coding,
    required: {
      tokens:
        plannerInputTokens +
        plannerInputGrowthTokens +
        plannerOutputTokens +
        plannerRecoveryTokens +
        coding.required.tokens,
      steps: 3,
      tools: 0,
      timeMs: integer(input.plannerTimeoutMs, "plannerTimeoutMs", 1) + coding.required.timeMs,
    },
  };
}

/**
 * During the active Coding session only final Review is downstream. Test failure
 * returns to that same session and must not reserve a second Repair agent.
 * When paused for a new approval, reserve one resumed Coding decision explicitly.
 */
export function codingContinuationReserve(input: {
  title: string;
  description: string;
  plan: unknown;
  diagnostics: unknown;
  source: string;
  patch?: string;
  codingOutput: number;
  reviewOutput: number;
  resumeCoding: boolean;
  reviewRecoveryAvailable: boolean;
}) {
  const legacy = repairContinuationReserve({
    ...input,
    repairOutput: integer(input.codingOutput, "codingOutput", 1),
    reviewOutput: integer(input.reviewOutput, "reviewOutput", 1),
    includeRepair: input.resumeCoding,
  });
  return {
    kind: "CODING_CONTINUATION_ESTIMATE" as const,
    branch: input.resumeCoding ? "REPLAN_THEN_CODING" : "ACTIVE_CODING",
    reviewInput: legacy.reviewInput,
    recoveryInput: legacy.recoveryInput,
    codingInput: legacy.repairInput,
    configuredCodingOutput: input.codingOutput,
    configuredReviewOutput: input.reviewOutput,
    review: legacy.review,
    recovery: legacy.recovery,
    coding: legacy.repair,
    total: legacy.total,
    accounting: legacy.accounting,
  };
}

/** Remaining workflow capacity after the selected continuation, not a fresh quota. */
export function codingPlannerTokenLease(input: {
  remainingTokens: number;
  downstreamTokens: number;
  configuredMaximumTokens: number;
  /** Includes the Planner request and its still-available recovery. */
  requiredRequestTokens?: number;
}) {
  const remainingTokens = integer(input.remainingTokens, "remainingTokens");
  const downstreamTokens = integer(input.downstreamTokens, "downstreamTokens");
  const configuredMaximumTokens = integer(
    input.configuredMaximumTokens,
    "configuredMaximumTokens",
    1,
  );
  const availableTokens = Math.max(0, remainingTokens - downstreamTokens);
  const maxTotalTokens = Math.min(configuredMaximumTokens, availableTokens);
  const requiredRequestTokens = integer(input.requiredRequestTokens ?? 0, "requiredRequestTokens");
  const missingTokens = Math.max(
    0,
    downstreamTokens + requiredRequestTokens - remainingTokens,
    requiredRequestTokens - configuredMaximumTokens,
  );
  return {
    remainingTokens,
    downstreamTokens,
    availableTokens,
    configuredMaximumTokens,
    maxTotalTokens,
    requiredRequestTokens,
    missingTokens,
    permitted: missingTokens === 0,
    requestIssued: false as const,
    accounting: "RESERVE_ONLY_RECHECK_ACTUAL_REQUEST" as const,
  };
}

function integer(value: number, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name} must be a safe integer >= ${minimum}.`);
  return value;
}

function capacity(value: CodingCapacity): CodingCapacity {
  return {
    tokens: integer(value.tokens, "tokens"),
    steps: integer(value.steps, "steps"),
    tools: integer(value.tools, "tools"),
    timeMs: integer(value.timeMs, "timeMs"),
  };
}

function zero(): CodingCapacity {
  return { tokens: 0, steps: 0, tools: 0, timeMs: 0 };
}

function maximum(a: CodingCapacity, b: CodingCapacity): CodingCapacity {
  return {
    tokens: Math.max(a.tokens, b.tokens),
    steps: Math.max(a.steps, b.steps),
    tools: Math.max(a.tools, b.tools),
    timeMs: Math.max(a.timeMs, b.timeMs),
  };
}

function add(a: CodingCapacity, b: CodingCapacity): CodingCapacity {
  return capacity({
    tokens: a.tokens + b.tokens,
    steps: a.steps + b.steps,
    tools: a.tools + b.tools,
    timeMs: a.timeMs + b.timeMs,
  });
}
