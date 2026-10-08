import {
  estimateModelInput,
  type CodingBudgetOperation,
  type ModelMessage,
  type ModelToolDescriptor,
} from "@devflow/agent";
import { repairContinuationReserve } from "./repair-reserve.js";
import { estimatePlanOutputRecoveryReserve } from "./plan-agent.js";
import { estimatePlanRequest } from "./plan-agent-context.js";
import { PlanProposalSchema } from "@devflow/shared";
import { PROPOSAL_PROMPT } from "./plan-proposal.js";
import {
  estimateOperationPlan,
  normalizeResources,
  resourceShortfalls,
  type ResourceBudgetOperationPlan,
  type ResourceVector,
} from "./resource-budget-scheduler.js";

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
  /** A handoff only needs final validation. A returned scope conflict is admitted separately. */
  operation?: CodingBudgetOperation;
}) {
  const shared = capacity(input.sharedFinal);
  const continuing = capacity(input.continuing);
  const replanning = input.replanning && capacity(input.replanning);
  if (input.selectedBranch === "REPLAN" && !replanning)
    throw new Error("A selected REPLAN branch requires its operation projection.");
  const selectedBranch = input.operation === "SUBMIT_CURRENT" ? "CONTINUE" : input.selectedBranch;
  const selected =
    selectedBranch === "CONTINUE"
      ? capacityOperation("coding:continue", continuing)
      : selectedBranch === "REPLAN"
        ? capacityOperation("coding:replan", replanning!)
        : undefined;
  const sharedOperation = capacityOperation("coding:final-validation-review", shared);
  const operationPlan: ResourceBudgetOperationPlan = selected
    ? {
        kind: "SEQUENCE",
        id: "coding:selected-continuation",
        operations: [sharedOperation, selected],
      }
    : {
        kind: "EXCLUSIVE",
        id: "coding:continuation-frontier",
        exclusivityKey: "coding-result:continue-or-scope-replan",
        shared: sharedOperation,
        branches: [
          capacityOperation("coding:continue", continuing),
          ...(replanning ? [capacityOperation("coding:replan", replanning)] : []),
        ],
      };
  const required = toCapacity(estimateOperationPlan(operationPlan).resources);
  const selectedCapacity = {
    tokens: required.tokens - shared.tokens,
    steps: required.steps - shared.steps,
    tools: required.tools - shared.tools,
    timeMs: required.timeMs - shared.timeMs,
  };
  return {
    accounting: "RESERVE_ONLY_RECHECK_ACTUAL_REQUEST" as const,
    operation: input.operation ?? "CODING",
    selectedBranch: selectedBranch ?? "UNDECIDED",
    sharedFinal: shared,
    continuing,
    ...(replanning ? { replanning } : {}),
    required,
    operationPlan,
    released: {
      tokens: Math.max(0, (replanning?.tokens ?? 0) - selectedCapacity.tokens),
      steps: Math.max(0, (replanning?.steps ?? 0) - selectedCapacity.steps),
      tools: Math.max(0, (replanning?.tools ?? 0) - selectedCapacity.tools),
      timeMs: Math.max(0, (replanning?.timeMs ?? 0) - selectedCapacity.timeMs),
    },
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
  const operationPlan: ResourceBudgetOperationPlan = {
    kind: "OPERATION",
    id: "coding:projected-request",
    requirement: "REQUIRED",
    state: "PENDING",
    resources: {
      inputTokens: estimatedInputTokens + inputGrowthTokens,
      outputTokens: configuredOutputTokens,
      steps: 1,
      modelCalls: 1,
      timeMs: integer(input.timeoutMs, "timeoutMs", 1),
    },
    reason: "Current projected messages and configured output; explicit evidence growth allowance",
  };
  return {
    estimatedInputTokens,
    configuredOutputTokens,
    inputGrowthTokens,
    operationPlan,
    required: toCapacity(estimateOperationPlan(operationPlan).resources),
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
  const operationPlan: ResourceBudgetOperationPlan = {
    kind: "SEQUENCE",
    id: "coding:replan-then-resume",
    operations: [
      {
        kind: "OPERATION",
        id: "planner:current-projection-and-recovery",
        requirement: "REQUIRED",
        state: "PENDING",
        resources: {
          tokens:
            plannerInputTokens +
            plannerInputGrowthTokens +
            plannerOutputTokens +
            plannerRecoveryTokens,
          steps: 2,
          modelCalls: 2,
          timeMs: integer(input.plannerTimeoutMs, "plannerTimeoutMs", 1),
        },
        reason: "Current Planner projection and one existing recovery share the phase deadline",
      },
      coding.operationPlan,
    ],
  };
  return {
    kind: "MINIMUM_REPLAN_BRANCH" as const,
    accounting: "RESERVE_ONLY_RECHECK_ACTUAL_REQUEST" as const,
    plannerInputTokens,
    plannerInputGrowthTokens,
    plannerOutputTokens,
    plannerRecoveryTokens,
    coding,
    operationPlan,
    required: toCapacity(estimateOperationPlan(operationPlan).resources),
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
  source: unknown;
  patch?: unknown;
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
    operationPlan: legacy.operationPlan,
    accounting: legacy.accounting,
  };
}

/** Remaining workflow capacity after the selected continuation, not a fresh quota. */
export function codingPlannerTokenLease(input: {
  remainingTokens: number;
  downstreamTokens: number;
  configuredMaximumTokens: number;
  /** Already consumed by this same planning attempt; a projection is not a fresh lease. */
  consumedTokens?: number;
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
  const consumedTokens = integer(input.consumedTokens ?? 0, "consumedTokens");
  const availableTokens = Math.max(0, remainingTokens - downstreamTokens);
  const remainingPhaseTokens = Math.max(0, configuredMaximumTokens - consumedTokens);
  const maxTotalTokens = consumedTokens + Math.min(remainingPhaseTokens, availableTokens);
  const requiredRequestTokens = integer(input.requiredRequestTokens ?? 0, "requiredRequestTokens");
  const sequentialRequirement = estimateOperationPlan({
    kind: "SEQUENCE",
    id: "planner:request-and-downstream",
    operations: [
      capacityOperation("planner:request", {
        tokens: requiredRequestTokens,
        steps: 0,
        tools: 0,
        timeMs: 0,
      }),
      capacityOperation("planner:downstream", {
        tokens: downstreamTokens,
        steps: 0,
        tools: 0,
        timeMs: 0,
      }),
    ],
  }).resources;
  const missingTokens = Math.max(
    resourceShortfalls(sequentialRequirement, { tokens: remainingTokens }).tokens ?? 0,
    resourceShortfalls(normalizeResources({ tokens: requiredRequestTokens }), {
      tokens: remainingPhaseTokens,
    }).tokens ?? 0,
  );
  return {
    remainingTokens,
    downstreamTokens,
    availableTokens,
    configuredMaximumTokens,
    consumedTokens,
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

function capacityOperation(id: string, value: CodingCapacity): ResourceBudgetOperationPlan {
  return {
    kind: "OPERATION",
    id,
    requirement: "REQUIRED",
    state: "PENDING",
    resources: {
      tokens: value.tokens,
      steps: value.steps,
      logicalToolCalls: value.tools,
      timeMs: value.timeMs,
    },
  };
}

function toCapacity(value: ResourceVector): CodingCapacity {
  return {
    tokens: value.tokens,
    steps: value.steps,
    tools: value.logicalToolCalls,
    timeMs: value.timeMs,
  };
}
