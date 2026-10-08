import { estimateModelInput } from "@devflow/agent";
import {
  estimateOperationPlan,
  type ResourceBudgetOperationPlan,
} from "./resource-budget-scheduler.js";

/** A projection, not consumption. Actual serialized requests are rechecked at dispatch. */
export function repairContinuationReserve(input: {
  title: string;
  description: string;
  plan: unknown;
  diagnostics: unknown;
  source: unknown;
  patch?: unknown;
  repairOutput: number;
  reviewOutput: number;
  includeRepair: boolean;
  reviewRecoveryAvailable: boolean;
}) {
  const task = { title: input.title, description: input.description, plan: input.plan };
  const estimate = (body: unknown) =>
    estimateModelInput([{ role: "USER", content: JSON.stringify(body) }], []);
  // Reserve whole future records, including request envelope/instructions and changed-code growth.
  // Current observations replace the former unrelated fixed 64 KiB input for each future request.
  const reviewInput =
    estimate({
      task,
      publicDiagnostics: input.diagnostics,
      currentSource: input.source,
      baselineSource: input.source,
      cumulativePatch: input.patch ?? "",
    }) + 4096;
  const recoveryInput =
    estimate({
      task,
      publicDiagnostics: input.diagnostics,
      necessarySource: input.source,
      cumulativePatch: input.patch ?? "",
    }) + 3072;
  const repairInput =
    estimate({ task, diagnosticTasks: input.diagnostics, currentSource: input.source }) + 3072;
  const projectedRequest = (
    id: string,
    inputTokens: number,
    outputTokens: number,
    enabled = true,
  ): ResourceBudgetOperationPlan => ({
    kind: "OPERATION",
    id,
    requirement: "REQUIRED",
    state: enabled ? "PENDING" : "COMPLETED",
    resources: { inputTokens, outputTokens, modelCalls: 1, steps: 1 },
  });
  const reviewOperation = projectedRequest(
    "review:current-projection",
    reviewInput,
    input.reviewOutput,
  );
  const recoveryOperation = projectedRequest(
    "review:bounded-recovery",
    recoveryInput,
    input.reviewOutput,
    input.reviewRecoveryAvailable,
  );
  // Legacy field names remain readable. This is a decision in the existing Coding Session.
  const codingOperation = projectedRequest(
    "coding:resumed-decision",
    repairInput,
    input.repairOutput,
    input.includeRepair,
  );
  const operationPlan: ResourceBudgetOperationPlan = {
    kind: "SEQUENCE",
    id: "coding:downstream-continuation",
    operations: [codingOperation, reviewOperation, recoveryOperation],
  };
  const review = estimateOperationPlan(reviewOperation).resources.tokens;
  const recovery = estimateOperationPlan(recoveryOperation).resources.tokens;
  const repair = estimateOperationPlan(codingOperation).resources.tokens;
  return {
    kind: "DOWNSTREAM_ESTIMATE" as const,
    branch: input.includeRepair ? "REPLAN_THEN_REPAIR" : "CURRENT_REPAIR",
    reviewInput,
    recoveryInput,
    repairInput,
    configuredRepairOutput: input.repairOutput,
    configuredReviewOutput: input.reviewOutput,
    review,
    recovery,
    repair,
    total: estimateOperationPlan(operationPlan).resources.tokens,
    operationPlan,
    accounting: "RESERVE_ONLY_RECHECK_ACTUAL_REQUEST" as const,
  };
}
