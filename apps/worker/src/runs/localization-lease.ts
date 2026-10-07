import { estimateModelInput } from "@devflow/agent";
import { repairContinuationReserve } from "./repair-reserve.js";

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
    repairOutput: input.outputs.repair,
    reviewOutput: input.outputs.review,
    includeRepair: true,
    reviewRecoveryAvailable: true,
  });
  const planner = 2 * (requestInput + input.outputs.planner);
  const execute = 2 * (requestInput + input.outputs.execute);
  const downstream = planner + execute + continuation.total;
  const perRequest = requestInput + input.outputs.localization;
  const desired = 4 * perRequest;
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
    accounting: "RESERVE_ONLY_RECHECK_ACTUAL_REQUEST" as const,
  };
}
