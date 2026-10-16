import type { RunExecutionRecord } from "@devflow/database";
import type { RunResult } from "@devflow/shared";

import type { RunExecutionOutcome, RunExecutionPort } from "../runs/run-execution.js";

/**
 * Sends executionMode=autonomous Runs to the autonomous executor and the rest to the
 * legacy executor. GitHub publication (PUSH/CREATE_PR after a human approval) does not
 * depend on how the candidate was produced, so every mode uses the delivery executor.
 */
export class ExecutionModeRouter implements RunExecutionPort {
  constructor(
    private readonly legacy: RunExecutionPort,
    private readonly autonomous: RunExecutionPort,
    private readonly delivery: RunExecutionPort,
  ) {}

  async execute(run: RunExecutionRecord, signal: AbortSignal): Promise<RunExecutionOutcome> {
    return await this.select(run).execute(run, signal);
  }

  async observedMetrics(run: RunExecutionRecord): Promise<RunResult["metrics"]> {
    const target = this.select(run);
    return (await target.observedMetrics?.(run)) ?? run.result?.metrics ?? emptyMetrics();
  }

  private select(run: RunExecutionRecord): RunExecutionPort {
    if (run.currentStage === "PUSH" || run.currentStage === "CREATE_PR") return this.delivery;
    return run.executionMode === "autonomous" ? this.autonomous : this.legacy;
  }
}

function emptyMetrics(): RunResult["metrics"] {
  return {
    durationMs: 0,
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    retries: 0,
    modelLatencyMs: 0,
    toolLatencyMs: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}
