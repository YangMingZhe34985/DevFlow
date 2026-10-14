import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createConfiguredLanguageModel,
  type KernelEvent,
  type KernelPrice,
  type KernelResume,
  type KernelUsage,
  type LanguageModelPort,
  type ModelGenerationSettings,
  type ModelMessage,
} from "@devflow/agent";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import {
  DockerSandboxManager,
  resolveLocalFilesystemPath,
  type SandboxSession,
} from "@devflow/sandbox";
import {
  DevflowError,
  toDevflowError,
  type AgentEventType,
  type DevflowErrorCode,
  type JsonValue,
  type RunMetrics,
  type RunResult,
} from "@devflow/shared";

import type { WorkerEnvironment } from "../config/env.js";
import { resolveStageModel } from "../config/stage-models.js";
import { prepareBenchmarkEvaluation } from "../runs/benchmark-evaluation.js";
import { captureGitHubChanges, isGitHubRepositoryUri } from "../runs/github-changeset.js";
import { prepareGitHubPushApproval, requireFullCommit } from "../runs/github-delivery.js";
import { ensureLocalRunSnapshot } from "../runs/local-run-snapshot.js";
import { discoverPublicVerification } from "../runs/public-verification.js";
import type { RunExecutionOutcome, RunExecutionPort } from "../runs/run-execution.js";
import {
  exportWorkspacePatch,
  readHead,
  runAutonomousSolve,
  type PublicCheck,
  type SolveResult,
} from "./solve.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const AUTONOMOUS_CHECKPOINT_ARTIFACT = "autonomous-checkpoint.json";
/** Without a benchmark configuration only repository plumbing is protected; tests may change. */
const DEFAULT_PROTECTED_PATHS = [".git/", ".github/workflows/"];

export interface AutonomousModel {
  model: LanguageModelPort;
  settings: ModelGenerationSettings;
  price?: KernelPrice | undefined;
  bindingHash: string;
}

export interface AutonomousRunExecutorOptions {
  /** Test seam; production uses the configured EXECUTE stage binding. */
  modelFactory?: (run: RunExecutionRecord) => AutonomousModel;
  /** Test seam; production creates a lease-fenced Docker sandbox. */
  sandboxFactory?: (run: RunExecutionRecord, signal: AbortSignal) => Promise<SandboxSession>;
}

interface Checkpoint {
  version: 1;
  bindingHash: string;
  turns: number;
  messages: ModelMessage[];
  /** Workspace diff at the checkpoint, applied to a fresh sandbox on resume. */
  patch: string;
}

/**
 * executionMode=autonomous: one agent with general tools solves the issue; the host
 * verifies independently, persists every step, and hands GitHub publication to the
 * existing approval-gated PUSH/CREATE_PR stages.
 */
export class AutonomousRunExecutor implements RunExecutionPort {
  constructor(
    private readonly database: DatabaseAdapter,
    private readonly environment: WorkerEnvironment,
    private readonly options: AutonomousRunExecutorOptions = {},
  ) {}

  async execute(run: RunExecutionRecord, signal: AbortSignal): Promise<RunExecutionOutcome> {
    const started = Date.now();
    const startedAt = run.startedAt ? Date.parse(run.startedAt) : started;
    const deadlineAt = startedAt + this.environment.DEVFLOW_TIMEOUT_MS;
    const binding = this.model(run);
    const prior = await this.priorUsage(run.id);
    const checkpoint = await this.loadCheckpoint(run.id, binding.bindingHash);
    const metrics = emptyMetrics();
    await this.database.runs.transition({
      runId: run.id,
      expectedStatus: "RUNNING",
      status: "RUNNING",
      currentStage: "EXECUTE",
      event: this.event(run.id, "RUN_STARTED", {
        mode: "autonomous",
        resumed: prior.usage.modelCalls > 0,
        checkpointTurns: checkpoint?.turns ?? null,
      }),
    });
    let sandbox: SandboxSession | undefined;
    try {
      sandbox = await (this.options.sandboxFactory ?? ((r, s) => this.createSandbox(r, s)))(
        run,
        signal,
      );
      const benchmark = await prepareBenchmarkEvaluation(this.database, run, sandbox, signal);
      const profile =
        benchmark?.configuration.runtime.publicVerificationProfile ??
        (await discoverPublicVerification(sandbox, signal)).profile;
      const protectedPaths = benchmark?.configuration.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
      const protectedPath = (path: string) =>
        matchesAny(path, protectedPaths)
          ? `${path} is protected (${benchmark ? "it grades the fix" : "repository plumbing"}); change other files instead. Put scratch scripts in /tmp.`
          : undefined;
      const baseCommit = await readHead(sandbox, signal);
      const resume = await this.restore(run.id, sandbox, checkpoint, prior, signal);
      const solve = await runAutonomousSolve({
        sandbox,
        baseCommit,
        issue: { title: run.task.title, body: run.task.description },
        checks: profile.checks as PublicCheck[],
        model: binding.model,
        settings: binding.settings,
        ...(binding.price ? { price: binding.price } : {}),
        limits: {
          maxTurns: this.environment.DEVFLOW_AUTONOMOUS_MAX_TURNS,
          ...(this.environment.DEVFLOW_MAX_COST_MICROS === undefined
            ? {}
            : { maxCostMicros: this.environment.DEVFLOW_MAX_COST_MICROS }),
          deadlineAt,
          maxInputTokens: this.environment.DEVFLOW_AUTONOMOUS_CONTEXT_TOKENS,
        },
        maxRevisions: this.environment.DEVFLOW_AUTONOMOUS_MAX_REVISIONS,
        protectedPath,
        protectedSummary: `Do not edit: ${protectedPaths.join(", ")}. Put scratch scripts in /tmp.`,
        ...(resume ? { resume } : {}),
        signal,
        onEvent: (event) => this.recordKernelEvent(run.id, event, metrics),
        onTurnEnd: (state) =>
          state.turns % this.environment.DEVFLOW_AUTONOMOUS_CHECKPOINT_TURNS === 0
            ? this.saveCheckpoint(run.id, sandbox!, baseCommit, binding.bindingHash, state, signal)
            : undefined,
        onVerification: async (verification, revision) => {
          await this.append(run.id, "TEST_RESULT", {
            revision,
            passed: verification.passed,
            protectedChanges: verification.protectedChanges,
            checks: verification.checks.map(({ output, ...check }) => ({
              ...check,
              outputTail: output.slice(-4000),
            })),
          });
        },
      });
      return await this.finish(
        run,
        sandbox,
        solve,
        metrics,
        started,
        profile.checks.length,
        signal,
      );
    } catch (error) {
      metrics.durationMs = Date.now() - started;
      const timedOut = Date.now() >= deadlineAt && !signal.aborted;
      const normalized = toDevflowError(error, {
        code: signal.aborted ? "CANCELLED" : timedOut ? "TIMEOUT" : "INTERNAL_ERROR",
        message: "Autonomous execution failed.",
        retryable: false,
      });
      // A lost lease or crash is retried by the queue and resumes from the checkpoint.
      if (normalized.code === "SANDBOX_LOST_OWNERSHIP" || normalized.retryable) throw error;
      return {
        runId: run.id,
        status: signal.aborted ? "CANCELLED" : timedOut ? "TIMED_OUT" : "FAILED",
        metrics,
        error: normalized.toJSON(),
      };
    } finally {
      await sandbox?.dispose().catch(() => undefined);
    }
  }

  private async finish(
    run: RunExecutionRecord,
    sandbox: SandboxSession,
    solve: SolveResult,
    metrics: RunMetrics,
    started: number,
    configuredChecks: number,
    signal: AbortSignal,
  ): Promise<RunExecutionOutcome> {
    const usage = solve.kernel.usage;
    Object.assign(metrics, {
      durationMs: Date.now() - started,
      steps: solve.kernel.turns,
      modelCalls: usage.modelCalls,
      reasoningTokens: usage.reasoningTokens,
      tokenUsage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedInputTokens: usage.cachedInputTokens,
      },
    } satisfies Partial<RunMetrics>);
    await this.database.artifacts.create({
      runId: run.id,
      kind: "OTHER",
      name: "autonomous-transcript.json",
      mimeType: "application/json",
      content: JSON.stringify({
        version: 1,
        stopReason: solve.kernel.stopReason,
        summary: solve.kernel.summary ?? null,
        revisions: solve.revisions,
        usage,
        messages: solve.kernel.messages,
      }),
    });
    const verification = solve.verification;
    if (verification)
      await this.database.artifacts.create({
        runId: run.id,
        kind: "TEST_REPORT",
        name: "autonomous-verification.json",
        mimeType: "application/json",
        content: JSON.stringify(verification, null, 2),
      });
    const passed = verification?.passed === true;
    const stopNote =
      solve.kernel.stopReason === "SUBMITTED"
        ? ""
        : ` The agent stopped (${solve.kernel.stopReason}) before submitting.`;
    if (!solve.patch)
      return this.failed(
        run.id,
        metrics,
        "NO_PROGRESS",
        `The agent produced no changes.${stopNote}`,
        solve,
      );
    const files = solve.changedFiles.length;
    await this.database.runs.transition({
      runId: run.id,
      expectedStatus: "RUNNING",
      status: "RUNNING",
      currentStage: "GENERATE_DIFF",
      event: this.event(run.id, "DIFF_GENERATED", {
        filesChanged: files,
        files: solve.changedFiles,
        verified: passed,
      }),
    });
    await this.database.artifacts.create({
      runId: run.id,
      kind: "DIFF",
      name: "changes.diff",
      mimeType: "text/x-diff",
      content: solve.patch,
      metadata: { filesChanged: files, verified: passed },
    });
    if (!passed) {
      const failedCheck = verification?.checks.find((check) => check.status !== "PASS");
      const reason = verification?.protectedChanges.length
        ? `protected files changed: ${verification.protectedChanges.join(", ")}`
        : `${failedCheck?.kind ?? "verification"} ${failedCheck?.status ?? "FAIL"}`;
      return this.failed(
        run.id,
        metrics,
        "PATCH_ATTEMPT_REJECTED",
        `Host verification failed (${reason}).${stopNote}`,
        solve,
      );
    }
    const summary = [
      solve.kernel.summary ?? "Changes produced by the autonomous agent.",
      configuredChecks
        ? "Independent host verification passed."
        : "No public checks are configured; the change is unverified by the host.",
      stopNote.trim(),
    ]
      .filter(Boolean)
      .join(" ");
    if (run.repository.sourceKind === "GIT" && isGitHubRepositoryUri(run.repository.sourceUri)) {
      const changes = await captureGitHubChanges(
        sandbox,
        requireFullCommit(run.task.baseCommitSha),
        signal,
      );
      if (changes.length > 0)
        return await prepareGitHubPushApproval(this.database, run, changes, summary, metrics);
    }
    return { runId: run.id, status: "SUCCEEDED", summary, metrics };
  }

  private failed(
    runId: string,
    metrics: RunMetrics,
    code: DevflowErrorCode,
    message: string,
    solve: SolveResult,
  ): RunResult {
    return {
      runId,
      status: "FAILED",
      summary: solve.kernel.summary ?? message,
      metrics,
      error: new DevflowError({
        code,
        message,
        details: { stopReason: solve.kernel.stopReason, revisions: solve.revisions },
      }).toJSON(),
    };
  }

  private async recordKernelEvent(runId: string, event: KernelEvent, metrics: RunMetrics) {
    if (event.type === "model_request") {
      await this.append(runId, "LLM_REQUEST", {
        turn: event.turn,
        worstCaseMicros: event.worstCaseMicros,
      });
    } else if (event.type === "model") {
      metrics.modelLatencyMs += Math.max(0, Math.round(event.response.latencyMs));
      await this.append(runId, "LLM_RESPONSE", {
        turn: event.turn,
        finishReason: event.response.finishReason,
        usage: event.response.usage,
        reasoningTokens: event.response.reasoningTokens ?? 0,
        costMicros: event.costMicros,
        latencyMs: event.response.latencyMs,
        text: (event.response.text ?? "").slice(0, 2000),
        toolCalls: event.response.toolCalls.map((call) => ({
          name: call.name,
          input: JSON.stringify(call.input).slice(0, 2000),
        })),
      });
    } else if (event.type === "tool") {
      metrics.toolCalls += 1;
      metrics.toolLatencyMs += Math.max(0, Math.round(event.durationMs));
      await this.append(runId, "TOOL_RESULT", {
        turn: event.turn,
        name: event.call.name,
        input: JSON.stringify(event.call.input).slice(0, 2000),
        ok: !event.isError,
        durationMs: event.durationMs,
        ...(event.isError
          ? { error: event.content.slice(0, 4000) }
          : { output: event.content.slice(0, 4000) }),
      });
    } else if (event.type === "model_error") {
      await this.append(runId, "WORKFLOW_CHECKPOINT", { modelError: event }, "WARN");
    } else {
      await this.append(runId, "WORKFLOW_CHECKPOINT", { contextElided: event });
    }
  }

  /** Usage already spent by earlier dispatches of this Run, from its own event log. */
  private async priorUsage(runId: string): Promise<{ usage: KernelUsage }> {
    return { usage: usageFromEvents(await this.database.events.list(runId)) };
  }

  private async loadCheckpoint(
    runId: string,
    bindingHash: string,
  ): Promise<Checkpoint | undefined> {
    const artifact = (await this.database.artifacts.list(runId))
      .filter((a) => a.name === AUTONOMOUS_CHECKPOINT_ARTIFACT && a.content)
      .at(-1);
    if (!artifact?.content) return undefined;
    const checkpoint = JSON.parse(artifact.content) as Checkpoint;
    if (checkpoint.version !== 1) return undefined;
    if (checkpoint.bindingHash !== bindingHash)
      throw new DevflowError({
        code: "CONFLICT",
        message: "AUTONOMOUS_MODEL_BINDING_CHANGED: the solver model changed since the checkpoint.",
      });
    return checkpoint;
  }

  private async restore(
    runId: string,
    sandbox: SandboxSession,
    checkpoint: Checkpoint | undefined,
    prior: { usage: KernelUsage },
    signal: AbortSignal,
  ): Promise<KernelResume | undefined> {
    if (prior.usage.modelCalls === 0 && !checkpoint) return undefined;
    // Turns after the checkpoint are redone, but their spending carries over from the log.
    const usage = prior.usage;
    if (checkpoint?.patch) {
      const applied = await sandbox.exec(
        {
          program: "git",
          args: ["apply", "--binary", "--whitespace=nowarn", "-"],
          stdin: checkpoint.patch,
          timeoutMs: 60_000,
          maxOutputBytes: 100_000,
        },
        signal,
      );
      if (applied.exitCode !== 0) {
        await this.append(
          runId,
          "WORKFLOW_CHECKPOINT",
          {
            checkpointRestore: "FAILED",
            detail: (applied.stderr || applied.stdout).slice(0, 2000),
          },
          "WARN",
        );
        return { messages: [], usage, turns: usage.modelCalls };
      }
    }
    if (!checkpoint) return { messages: [], usage, turns: usage.modelCalls };
    return { messages: checkpoint.messages, usage, turns: usage.modelCalls };
  }

  private async saveCheckpoint(
    runId: string,
    sandbox: SandboxSession,
    baseCommit: string,
    bindingHash: string,
    state: KernelResume,
    signal: AbortSignal,
  ): Promise<void> {
    const { patch } = await exportWorkspacePatch(sandbox, baseCommit, undefined, signal);
    const checkpoint: Checkpoint = {
      version: 1,
      bindingHash,
      turns: state.turns,
      messages: [...state.messages],
      patch,
    };
    await this.database.artifacts.create({
      runId,
      kind: "OTHER",
      name: AUTONOMOUS_CHECKPOINT_ARTIFACT,
      mimeType: "application/json",
      content: JSON.stringify(checkpoint),
      metadata: { turns: state.turns, patchBytes: patch.length },
    });
  }

  private model(run: RunExecutionRecord): AutonomousModel {
    if (this.options.modelFactory) return this.options.modelFactory(run);
    const binding = resolveStageModel("EXECUTE", this.environment, run);
    const { contextMaxBytes: _contextMaxBytes, ...config } = binding.config;
    const prices = JSON.parse(this.environment.DEVFLOW_MODEL_PRICES_JSON ?? "{}") as Record<
      string,
      KernelPrice
    >;
    const price = prices[`${binding.provenance.provider}:${binding.provenance.model}`];
    if (this.environment.DEVFLOW_MAX_COST_MICROS !== undefined && !price)
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: `A cost cap is configured but ${binding.provenance.provider}:${binding.provenance.model} has no price in DEVFLOW_MODEL_PRICES_JSON.`,
      });
    return {
      model: createConfiguredLanguageModel(config),
      settings: binding.settings,
      price,
      bindingHash: binding.provenance.configurationHash,
    };
  }

  private async createSandbox(run: RunExecutionRecord, signal: AbortSignal) {
    const snapshot = await ensureLocalRunSnapshot(this.database, run, signal);
    const manager = new DockerSandboxManager({
      image: this.environment.DEVFLOW_SANDBOX_IMAGE,
      workspaceRoot:
        run.repository.sourceKind === "LOCAL"
          ? resolveLocalFilesystemPath(run.repository.sourceUri, PROJECT_ROOT)
          : PROJECT_ROOT,
      assertOwnership: async () => {
        if (!run.executionOwner) return;
        const current = await this.database.runs.findById(run.id);
        if (
          !current ||
          current.status !== "RUNNING" ||
          current.executionOwner !== run.executionOwner ||
          current.dispatchRevision !== run.dispatchRevision ||
          !current.leaseExpiresAt ||
          Date.parse(current.leaseExpiresAt) <= Date.now()
        )
          throw new DevflowError({
            code: "SANDBOX_LOST_OWNERSHIP",
            message: "Sandbox dispatch no longer owns a live Run lease.",
          });
      },
    });
    return await manager.create(
      {
        runId: run.id,
        owner: {
          executionOwner: run.executionOwner ?? "standalone",
          dispatchRevision: run.dispatchRevision,
          segment: randomUUID(),
        },
        repository: {
          sourceUri: run.repository.sourceUri,
          ...(run.task.baseRef === undefined ? {} : { baseRef: run.task.baseRef }),
          ...(run.task.baseCommitSha === undefined ? {} : { baseCommit: run.task.baseCommitSha }),
          ...(snapshot === undefined ? {} : { snapshot }),
        },
        limits: {
          cpuCount: this.environment.DEVFLOW_SANDBOX_CPUS,
          memoryMb: this.environment.DEVFLOW_SANDBOX_MEMORY_MB,
          pids: this.environment.DEVFLOW_SANDBOX_PIDS,
          timeoutMs: this.environment.DEVFLOW_TIMEOUT_MS,
          networkEnabled:
            run.repository.sourceKind === "GIT" && this.environment.DEVFLOW_SANDBOX_NETWORK_ENABLED,
        },
      },
      signal,
    );
  }

  private event(runId: string, type: AgentEventType, payload: unknown, level?: "INFO" | "WARN") {
    return {
      runId,
      type,
      occurredAt: new Date().toISOString(),
      payload: JSON.parse(JSON.stringify(payload ?? null)) as JsonValue,
      ...(level ? { level } : {}),
    };
  }

  private async append(
    runId: string,
    type: AgentEventType,
    payload: unknown,
    level?: "INFO" | "WARN",
  ) {
    await this.database.events.append(this.event(runId, type, payload, level));
  }
}

/**
 * Spending recorded in a Run's event log. A request without a response may have been
 * billed before a crash, so its worst case counts as unconfirmed cost, never as zero.
 */
export function usageFromEvents(
  events: readonly { type: string; payload: unknown }[],
): KernelUsage {
  const usage: KernelUsage = {
    modelCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costMicros: 0,
    unconfirmedCostMicros: 0,
  };
  let pendingWorstCase = 0;
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === "LLM_REQUEST") {
      usage.unconfirmedCostMicros += pendingWorstCase;
      pendingWorstCase = Number(payload.worstCaseMicros ?? 0);
    } else if (event.type === "WORKFLOW_CHECKPOINT" && payload.modelError) {
      // A failed attempt inside a turn: its possible charge was recorded with the error.
      // A retry puts another attempt in flight; otherwise nothing remains pending.
      const failure = payload.modelError as Record<string, unknown>;
      usage.unconfirmedCostMicros += Number(failure.unconfirmedMicros ?? 0);
      if (failure.willRetry !== true) pendingWorstCase = 0;
    } else if (event.type === "LLM_RESPONSE") {
      pendingWorstCase = 0;
      const u = (payload.usage ?? {}) as Record<string, number | undefined>;
      usage.modelCalls += 1;
      usage.inputTokens += u.inputTokens ?? 0;
      usage.cachedInputTokens += u.cachedInputTokens ?? 0;
      usage.outputTokens += u.outputTokens ?? 0;
      usage.reasoningTokens += Number(payload.reasoningTokens ?? 0);
      usage.costMicros += Number(payload.costMicros ?? 0);
    }
  }
  // A request without a response may have been billed before a crash: never count it as zero.
  usage.unconfirmedCostMicros += pendingWorstCase;
  return usage;
}

function matchesAny(path: string, entries: readonly string[]): boolean {
  return entries.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry || path.startsWith(`${entry}/`),
  );
}

function emptyMetrics(): RunMetrics {
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
