import { estimateModelInput } from "@devflow/agent";

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
  const review = reviewInput + input.reviewOutput;
  const recovery = input.reviewRecoveryAvailable ? recoveryInput + input.reviewOutput : 0;
  const repair = input.includeRepair ? repairInput + input.repairOutput : 0;
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
    total: review + recovery + repair,
    accounting: "RESERVE_ONLY_RECHECK_ACTUAL_REQUEST" as const,
  };
}
