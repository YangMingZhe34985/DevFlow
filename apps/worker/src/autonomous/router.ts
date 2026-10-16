import type { RunExecutionRecord } from "@devflow/database";
import { DevflowError, type RunResult } from "@devflow/shared";

import type { RunExecutionOutcome, RunExecutionPort } from "../runs/run-execution.js";

/**
 * Sends Runs to the autonomous executor. GitHub publication (PUSH/CREATE_PR after a human
 * approval) does not depend on how the candidate was produced, so it has its own executor.
 * Runs persisted under the retired workflow/team/single modes stay readable but cannot run.
 */
export class ExecutionModeRouter implements RunExecutionPort {
  constructor(
    private readonly autonomous: RunExecutionPort,
    private readonly delivery: RunExecutionPort,
  ) {}

  async execute(run: RunExecutionRecord, signal: AbortSignal): Promise<RunExecutionOutcome> {
    return await this.select(run).execute(run, signal);
  }

  async observedMetrics(run: RunExecutionRecord): Promise<RunResult["metrics"]> {
    const target =
      this.publishing(run) || run.executionMode === "autonomous" ? this.select(run) : undefined;
    return (await target?.observedMetrics?.(run)) ?? run.result?.metrics ?? emptyMetrics();
  }

  private select(run: RunExecutionRecord): RunExecutionPort {
    if (this.publishing(run)) return this.delivery;
    if (run.executionMode === "autonomous") return this.autonomous;
    throw new DevflowError({
      code: "CONFLICT",
      message: `Execution mode ${String(run.executionMode)} was retired in DevFlow v4; create a new autonomous Run.`,
    });
  }

  private publishing(run: RunExecutionRecord): boolean {
    return run.currentStage === "PUSH" || run.currentStage === "CREATE_PR";
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
