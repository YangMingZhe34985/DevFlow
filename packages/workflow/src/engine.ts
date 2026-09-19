import type { AgentRuntime } from "@devflow/agent";
import { DevflowError } from "@devflow/shared";

import type { WorkflowState } from "./state.js";
import { cancelWorkflow } from "./transition.js";

export interface WorkflowEngine {
  resume(state: WorkflowState, signal: AbortSignal): Promise<WorkflowState>;
}

export class DefaultWorkflowEngine implements WorkflowEngine {
  constructor(private readonly agent: AgentRuntime) {}

  async resume(state: WorkflowState, signal: AbortSignal): Promise<WorkflowState> {
    if (signal.aborted) return cancelWorkflow(state);
    if (state.stage === "DONE" || state.stage === "FAILED" || state.stage === "CANCELLED") {
      return state;
    }
    void this.agent;
    throw new DevflowError({
      code: "NOT_IMPLEMENTED",
      message:
        "Workflow orchestration is not implemented. Persist checkpoints before enabling execution.",
    });
  }
}

// TODO(P8-workflow): translate persisted events into pure transitions and
// idempotent commands, including approval/replan, test/fix and review/fix loops.
