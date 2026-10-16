import type { PauseForGitHubApprovalInput, RunExecutionRecord } from "@devflow/database";
import type { RunResult } from "@devflow/shared";

export interface WaitingGitHubApprovalResult {
  status: "WAITING_APPROVAL";
  approvalKind: "GITHUB";
  approval: PauseForGitHubApprovalInput;
}

export type RunExecutionOutcome = RunResult | WaitingGitHubApprovalResult;

export interface RunExecutionPort {
  execute(run: RunExecutionRecord, signal: AbortSignal): Promise<RunExecutionOutcome>;
  observedMetrics?(run: RunExecutionRecord): Promise<RunResult["metrics"]>;
}
