import type { PauseForGitHubApprovalInput, RunExecutionRecord } from "@devflow/database";
import type { AgentPlan, RunResult } from "@devflow/shared";

export interface WaitingApprovalResult {
  status: "WAITING_APPROVAL";
  approvalKind?: "PLAN";
  plan: AgentPlan;
}

export interface WaitingGitHubApprovalResult {
  status: "WAITING_APPROVAL";
  approvalKind: "GITHUB";
  approval: PauseForGitHubApprovalInput;
}

export type RunExecutionOutcome = RunResult | WaitingApprovalResult | WaitingGitHubApprovalResult;

export interface RunExecutionPort {
  execute(run: RunExecutionRecord, signal: AbortSignal): Promise<RunExecutionOutcome>;
}
