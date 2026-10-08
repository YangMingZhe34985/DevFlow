import { estimateModelInput } from "@devflow/agent";
import { repairContinuationReserve } from "./repair-reserve.js";
import {
  estimateOperationPlan,
  type ResourceBudgetOperationPlan,
} from "./resource-budget-scheduler.js";

/** Reservations are capacity, not charged tokens. Recheck at each stage boundary. */
export function localizationLease(input: {
  remainingTokens: number;
  title: string;
  description: string;
  evidence: readonly { snippet: string }[];
  outputs: {
    localization: number;
    planner: number;
    execute: number;
    repair: number;
    review: number;
  };
}) {
  const source = input.evidence.map((e) => e.snippet).join("\n");
  const serializedInput = estimateModelInput(
    [
      {
        role: "USER",
        content: JSON.stringify({
          title: input.title,
          description: input.description,
          evidence: input.evidence,
        }),
      },
    ],
    [],
  );
  // Explicit uncertainty allowance for instructions/envelopes and later evidence growth.
  const growthAllowance = 4096;
  const requestInput = serializedInput + growthAllowance;
  const continuation = repairContinuationReserve({
    ...input,
    source,
    plan: null,
    diagnostics: [],
    // Compatibility callers still provide `repair`; unified Coding resumes with Execute settings.
    repairOutput: input.outputs.execute,
    reviewOutput: input.outputs.review,
    includeRepair: false,
    reviewRecoveryAvailable: true,
  });
  const request = (id: string, outputTokens: number): ResourceBudgetOperationPlan => ({
    kind: "OPERATION",
    id,
    requirement: "REQUIRED",
    state: "PENDING",
    resources: { inputTokens: requestInput, outputTokens, modelCalls: 1, steps: 1 },
  });
  const sequence = (
    id: string,
    operations: ResourceBudgetOperationPlan[],
  ): ResourceBudgetOperationPlan => ({ kind: "SEQUENCE", id, operations });
  const plannerOperations = sequence("localization:downstream-planning", [
    request("planner:initial", input.outputs.planner),
    request("planner:existing-recovery", input.outputs.planner),
  ]);
  // One initial Coding decision and one necessary failure decision share the same session.
  // A third, separately reserved Repair Agent would charge the same continuation twice.
  const codingOperations = sequence("localization:downstream-coding", [
    request("coding:initial", input.outputs.execute),
    request("coding:failure-decision", input.outputs.execute),
  ]);
  const downstreamOperationPlan = sequence("localization:downstream", [
    plannerOperations,
    codingOperations,
    continuation.operationPlan,
  ]);
  const localizationOperationPlan = sequence("localization:four-request-ceiling", [
    request("localization:decision", input.outputs.localization),
    request("localization:exploration-decision", input.outputs.localization),
    request("localization:final", input.outputs.localization),
    request("localization:existing-recovery", input.outputs.localization),
  ]);
  const planner = estimateOperationPlan(plannerOperations).resources.tokens;
  const execute = estimateOperationPlan(codingOperations).resources.tokens;
  const downstream = estimateOperationPlan(downstreamOperationPlan).resources.tokens;
  const perRequest = estimateOperationPlan(
    request("localization:projected-request", input.outputs.localization),
  ).resources.tokens;
  const desired = estimateOperationPlan(localizationOperationPlan).resources.tokens;
  const available = Math.max(0, input.remainingTokens - downstream);
  return {
    maxTokens: Math.min(desired, available),
    downstream,
    planner,
    execute,
    continuation,
    serializedInput,
    growthAllowance,
    desired,
    finalAndRecovery: 2 * perRequest,
    oneExploration: perRequest,
    explorationAffordable: available >= 3 * perRequest,
    downstreamOperationPlan,
    localizationOperationPlan,
    accounting: "RESERVE_ONLY_RECHECK_ACTUAL_REQUEST" as const,
  };
}
