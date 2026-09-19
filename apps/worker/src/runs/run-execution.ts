import type { RunExecutionRecord } from "@devflow/database";
import type { AgentPlan, RunResult } from "@devflow/shared";

export interface WaitingApprovalResult {
  status: "WAITING_APPROVAL";
  plan: AgentPlan;
}

export type RunExecutionOutcome = RunResult | WaitingApprovalResult;

export interface RunExecutionPort {
  execute(run: RunExecutionRecord, signal: AbortSignal): Promise<RunExecutionOutcome>;
}
