import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createConfiguredLanguageModel,
  DefaultAgentRuntime,
  type LanguageModelPort,
  type ModelToolDescriptor,
  type SupportedLlmProvider,
} from "@devflow/agent";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import { SandboxGitService } from "@devflow/git";
import { DockerSandboxManager, type CommandResult, type SandboxSession } from "@devflow/sandbox";
import {
  AgentPlanSchema,
  DevflowError,
  ReviewResultSchema,
  toDevflowError,
  type AgentPlan,
  type JsonValue,
  type ReviewResult,
  type RunMetrics,
  type RunResult,
} from "@devflow/shared";
import {
  DefaultToolExecutor,
  ExplicitToolPolicy,
  registerCoreTools,
  ToolRegistry,
  type ToolExecutionRequest,
} from "@devflow/tools";

import type { WorkerEnvironment } from "../config/env.js";
import type { RunExecutionOutcome, RunExecutionPort } from "./run-execution.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export type WorkflowLanguageModelFactory = (run: RunExecutionRecord) => LanguageModelPort;

/**
 * Production P6-P9 orchestration. Planning deliberately happens before a sandbox
 * is created; only a persisted PLAN approval can resume the run into execution.
 */
export class ApprovalWorkflowRunExecutor implements RunExecutionPort {
  constructor(
    private readonly database: DatabaseAdapter,
    private readonly environment: WorkerEnvironment,
    private readonly modelFactory?: WorkflowLanguageModelFactory,
    private readonly reviewerFactory?: WorkflowLanguageModelFactory,
  ) {}

  async execute(run: RunExecutionRecord, signal: AbortSignal): Promise<RunExecutionOutcome> {
    if (run.currentStage === "START" || run.currentStage === "GENERATE_PLAN") {
      return await this.generatePlan(run, signal);
    }
    if (run.currentStage !== "EXECUTE") {
      throw new DevflowError({
        code: "CONFLICT",
        message: `Run ${run.id} cannot execute from workflow stage ${run.currentStage}.`,
      });
    }
    return await this.executeApprovedPlan(run, signal);
  }

  private async generatePlan(
    run: RunExecutionRecord,
    signal: AbortSignal,
  ): Promise<RunExecutionOutcome> {
    if (run.currentStage === "START") {
      await this.database.events.append({
        runId: run.id,
        type: "RUN_STARTED",
        occurredAt: new Date().toISOString(),
        payload: { workflow: "approval", resumed: false },
      });
    }
    const previous = (await this.database.approvals.list(run.id)).find(
      (approval) => approval.kind === "PLAN" && approval.status === "REJECTED",
    );
    const feedback = previous?.comment ?? previous?.resolution;
    const model = this.createModel(run);
    await this.database.events.append({
      runId: run.id,
      type: "LLM_REQUEST",
      occurredAt: new Date().toISOString(),
      payload: { purpose: "PLAN", replanning: previous !== undefined },
    });
    const response = await model.generate(
      {
        tools: [],
        messages: [
          {
            role: "SYSTEM",
            content:
              "You are the planning phase of a software engineering workflow. Return only JSON with shape {summary:string,steps:[{id:string,title:string,description:string}]}. Do not edit files and do not claim work was executed.",
          },
          {
            role: "USER",
            content: [
              run.task.title,
              run.task.description,
              feedback === undefined
                ? "Create a safe, testable implementation plan."
                : `The previous plan was rejected. Replan using this feedback:\n${stringify(feedback)}`,
            ].join("\n\n"),
          },
        ],
      },
      { signal },
    );
    const plan = parseModelJson(response.text, AgentPlanSchema, "Agent plan");
    await this.database.events.append({
      runId: run.id,
      type: "LLM_RESPONSE",
      occurredAt: new Date().toISOString(),
      payload: {
        purpose: "PLAN",
        finishReason: response.finishReason,
        latencyMs: response.latencyMs,
      },
    });
    await this.database.runs.transition({
      runId: run.id,
      expectedStatus: "RUNNING",
      status: "RUNNING",
      currentStage: "GENERATE_PLAN",
      event: {
        runId: run.id,
        type: "PLAN_GENERATED",
        occurredAt: new Date().toISOString(),
        payload: asJson({ plan, replannedFromApprovalId: previous?.id }),
      },
    });
    return { status: "WAITING_APPROVAL", plan };
  }

  private async executeApprovedPlan(
    run: RunExecutionRecord,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const approved = (await this.database.approvals.list(run.id)).find(
      (approval) => approval.kind === "PLAN" && approval.status === "APPROVED",
    );
    const plan = extractPlan(approved?.request);
    if (plan === undefined) {
      throw new DevflowError({
        code: "APPROVAL_REQUIRED",
        message: "An approved persisted plan is required before execution.",
      });
    }

    const startedAt = Date.now();
    const metrics = emptyMetrics();
    const manager = new DockerSandboxManager({
      image: this.environment.DEVFLOW_SANDBOX_IMAGE,
      workspaceRoot:
        run.repository.sourceKind === "LOCAL"
          ? localSourcePath(run.repository.sourceUri)
          : PROJECT_ROOT,
    });
    let sandbox: SandboxSession | undefined;
    try {
      sandbox = await manager.create(
        {
          runId: run.id,
          repository: {
            sourceUri: run.repository.sourceUri,
            ...(run.task.baseRef === undefined ? {} : { baseRef: run.task.baseRef }),
            ...(run.task.baseCommit === undefined ? {} : { baseCommit: run.task.baseCommit }),
          },
          limits: {
            cpuCount: this.environment.DEVFLOW_SANDBOX_CPUS,
            memoryMb: this.environment.DEVFLOW_SANDBOX_MEMORY_MB,
            pids: this.environment.DEVFLOW_SANDBOX_PIDS,
            timeoutMs: this.environment.DEVFLOW_TIMEOUT_MS,
            networkEnabled:
              run.repository.sourceKind === "GIT" &&
              this.environment.DEVFLOW_SANDBOX_NETWORK_ENABLED,
          },
        },
        signal,
      );
      const git = new SandboxGitService();
      const { executor, tools } = createTools(git);
      const implementationModel = this.createModel(run);

      const implementation = await this.runAgentPhase({
        run,
        plan,
        sandbox,
        signal,
        executor,
        tools,
        model: implementationModel,
        purpose: "IMPLEMENTATION",
        additionalContext: "Implement the approved plan. Do not skip verification.",
      });
      mergeMetrics(metrics, implementation.metrics);
      if (implementation.status !== "SUCCEEDED") return implementation;

      let test = await this.runTests(run, sandbox, signal, 0);
      metrics.toolCalls += 1;
      metrics.toolLatencyMs += test.durationMs;
      let repairAttempt = 0;
      while (test.exitCode !== 0 && repairAttempt < run.maxTestRetries) {
        repairAttempt += 1;
        metrics.retries += 1;
        await this.database.runs.transition({
          runId: run.id,
          expectedStatus: "RUNNING",
          status: "RUNNING",
          currentStage: "FIX",
          event: {
            runId: run.id,
            type: "REPAIR_STARTED",
            occurredAt: new Date().toISOString(),
            payload: { attempt: repairAttempt, reason: "TEST_FAILED" },
          },
        });
        const repair = await this.runAgentPhase({
          run,
          plan,
          sandbox,
          signal,
          executor,
          tools,
          model: implementationModel,
          purpose: "REPAIR",
          additionalContext: `Repair attempt ${String(repairAttempt)}. The independent test command failed:\n${testOutput(test)}`,
        });
        mergeMetrics(metrics, repair.metrics);
        if (repair.status !== "SUCCEEDED") return repair;
        await this.database.events.append({
          runId: run.id,
          type: "REPAIR_COMPLETED",
          occurredAt: new Date().toISOString(),
          payload: { attempt: repairAttempt },
        });
        test = await this.runTests(run, sandbox, signal, repairAttempt);
        metrics.toolCalls += 1;
        metrics.toolLatencyMs += test.durationMs;
      }
      if (test.exitCode !== 0) {
        return await this.failedResult(
          run,
          metrics,
          startedAt,
          "TEST_FAILED",
          `Tests still fail after ${String(run.maxTestRetries)} repair attempts.`,
        );
      }

      let reviewAttempt = 0;
      let review: ReviewResult;
      let diff = await git.diff(sandbox, { maxBytes: 300_000 }, signal);
      do {
        review = await this.review(run, plan, diff.patch, test, signal, reviewAttempt);
        metrics.modelCalls += 1;
        reviewAttempt += 1;
        if (review.approved) break;
        if (reviewAttempt > run.maxReviewRetries) {
          return await this.failedResult(
            run,
            metrics,
            startedAt,
            "REVIEW_FAILED",
            `Independent review rejected the implementation after ${String(reviewAttempt)} review attempts.`,
          );
        }
        metrics.retries += 1;
        await this.database.runs.transition({
          runId: run.id,
          expectedStatus: "RUNNING",
          status: "RUNNING",
          currentStage: "FIX",
          event: {
            runId: run.id,
            type: "REPAIR_STARTED",
            occurredAt: new Date().toISOString(),
            payload: { attempt: reviewAttempt, reason: "REVIEW_REJECTED" },
          },
        });
        const repair = await this.runAgentPhase({
          run,
          plan,
          sandbox,
          signal,
          executor,
          tools,
          model: implementationModel,
          purpose: "REVIEW_REPAIR",
          additionalContext: `Address these independent review findings:\n${JSON.stringify(review.findings, null, 2)}`,
        });
        mergeMetrics(metrics, repair.metrics);
        if (repair.status !== "SUCCEEDED") return repair;
        test = await this.runTests(run, sandbox, signal, repairAttempt);
        metrics.toolCalls += 1;
        metrics.toolLatencyMs += test.durationMs;
        if (test.exitCode !== 0) {
          return await this.failedResult(
            run,
            metrics,
            startedAt,
            "TEST_FAILED",
            "Tests failed after applying independent review feedback.",
          );
        }
        diff = await git.diff(sandbox, { maxBytes: 300_000 }, signal);
      } while (!review.approved);

      await this.database.runs.transition({
        runId: run.id,
        expectedStatus: "RUNNING",
        status: "RUNNING",
        currentStage: "GENERATE_DIFF",
        event: {
          runId: run.id,
          type: "DIFF_GENERATED",
          occurredAt: new Date().toISOString(),
          payload: asJson({
            filesChanged: diff.filesChanged,
            additions: diff.additions,
            deletions: diff.deletions,
            truncated: diff.truncated,
          }),
        },
      });
      await this.database.artifacts.create({
        runId: run.id,
        kind: "DIFF",
        name: "changes.diff",
        mimeType: "text/x-diff",
        content: diff.patch || "No textual diff was produced.",
        metadata: asJson({
          filesChanged: diff.filesChanged,
          additions: diff.additions,
          deletions: diff.deletions,
          truncated: diff.truncated,
        }),
      });

      metrics.durationMs = Math.max(0, Date.now() - startedAt);
      const summary = `${implementation.summary ?? "Implementation completed."} Independent review approved: ${review.summary}`;
      const result: RunResult = { runId: run.id, status: "SUCCEEDED", summary, metrics };
      await this.database.events.append({
        runId: run.id,
        type: "RUN_COMPLETED",
        occurredAt: new Date().toISOString(),
        payload: asJson({ summary, metrics }),
      });
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      throw error;
    } finally {
      await sandbox?.dispose();
    }
  }

  private async runAgentPhase(input: {
    run: RunExecutionRecord;
    plan: AgentPlan;
    sandbox: SandboxSession;
    signal: AbortSignal;
    executor: DefaultToolExecutor;
    tools: readonly ModelToolDescriptor[];
    model: LanguageModelPort;
    purpose: string;
    additionalContext: string;
  }): Promise<RunResult> {
    const runtime = new DefaultAgentRuntime(input.model);
    return await runtime.run(
      {
        approvedPlan: input.plan,
        maxSteps: input.run.maxSteps,
        timeoutMs: this.environment.DEVFLOW_TIMEOUT_MS,
        maxRetries: this.environment.DEVFLOW_MAX_RETRIES,
        emitRunLifecycle: false,
        systemPrompt:
          "You are the implementation and repair role. Use only provided tools, make concrete repository changes, and report concisely. Do not perform the independent review role.",
        additionalContext: input.additionalContext,
      },
      {
        runId: input.run.id,
        task: {
          taskId: input.run.task.id,
          repositoryId: input.run.repository.id,
          title: input.run.task.title,
          description: input.run.task.description,
          ...(input.run.task.baseCommit === undefined
            ? {}
            : { baseCommit: input.run.task.baseCommit }),
        },
        signal: input.signal,
        tools: input.tools,
        emit: async (event) => {
          await this.database.events.append(event);
        },
        executeTool: async (stepId, request: ToolExecutionRequest, toolSignal = input.signal) =>
          await input.executor.execute(request, {
            runId: input.run.id,
            stepId,
            sandbox: input.sandbox,
            signal: toolSignal,
            emit: async (event) => {
              await this.database.events.append(event);
            },
          }),
      },
    );
  }

  private async runTests(
    run: RunExecutionRecord,
    sandbox: SandboxSession,
    signal: AbortSignal,
    attempt: number,
  ): Promise<CommandResult> {
    await this.database.runs.transition({
      runId: run.id,
      expectedStatus: "RUNNING",
      status: "RUNNING",
      currentStage: "TEST",
      event: {
        runId: run.id,
        type: "TEST_STARTED",
        occurredAt: new Date().toISOString(),
        payload: { attempt },
      },
    });
    const command = await detectTestCommand(sandbox, signal);
    const result =
      command === undefined
        ? noTestsDetected()
        : await sandbox.exec(
            {
              ...command,
              timeoutMs: Math.min(this.environment.DEVFLOW_TIMEOUT_MS, 300_000),
              maxOutputBytes: 500_000,
            },
            signal,
          );
    await this.database.events.append({
      runId: run.id,
      type: "TEST_RESULT",
      level: result.exitCode === 0 ? "INFO" : "ERROR",
      occurredAt: new Date().toISOString(),
      payload: asJson({
        attempt,
        command,
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: truncate(result.stdout),
        stderr: truncate(result.stderr),
      }),
    });
    await this.database.artifacts.create({
      runId: run.id,
      kind: "TEST_REPORT",
      name: `test-attempt-${String(attempt + 1)}.txt`,
      mimeType: "text/plain",
      content: testOutput(result),
      metadata: asJson({ attempt, exitCode: result.exitCode, command }),
    });
    return result;
  }

  private async review(
    run: RunExecutionRecord,
    plan: AgentPlan,
    diff: string,
    test: CommandResult,
    signal: AbortSignal,
    attempt: number,
  ): Promise<ReviewResult> {
    await this.database.runs.transition({
      runId: run.id,
      expectedStatus: "RUNNING",
      status: "RUNNING",
      currentStage: "REVIEW",
      event: {
        runId: run.id,
        type: "REVIEW_STARTED",
        occurredAt: new Date().toISOString(),
        payload: { attempt: attempt + 1, independent: true },
      },
    });
    const reviewer = this.createReviewer(run);
    const response = await reviewer.generate(
      {
        tools: [],
        messages: [
          {
            role: "SYSTEM",
            content:
              "You are an independent code reviewer. You did not implement the change. Assess correctness, scope, safety and tests. Return only JSON: {approved:boolean,summary:string,findings:[{severity:'INFO'|'WARNING'|'ERROR',message:string,path?:string}]}",
          },
          {
            role: "USER",
            content: `Task:\n${run.task.title}\n${run.task.description}\n\nApproved plan:\n${JSON.stringify(plan, null, 2)}\n\nTest result:\n${testOutput(test)}\n\nDiff:\n${truncate(diff, 200_000)}`,
          },
        ],
      },
      { signal },
    );
    const review = parseModelJson(response.text, ReviewResultSchema, "Review result");
    await this.database.events.append({
      runId: run.id,
      type: "REVIEW_RESULT",
      level: review.approved ? "INFO" : "WARN",
      occurredAt: new Date().toISOString(),
      payload: asJson({ ...review, attempt: attempt + 1, independent: true }),
    });
    await this.database.artifacts.create({
      runId: run.id,
      kind: "REVIEW_REPORT",
      name: `review-attempt-${String(attempt + 1)}.json`,
      mimeType: "application/json",
      content: JSON.stringify(review, null, 2),
      metadata: { attempt: attempt + 1, independent: true },
    });
    return review;
  }

  private async failedResult(
    run: RunExecutionRecord,
    metrics: RunMetrics,
    startedAt: number,
    code: string,
    message: string,
  ): Promise<RunResult> {
    metrics.durationMs = Math.max(0, Date.now() - startedAt);
    const error = new DevflowError({
      code: "TOOL_FAILED",
      message,
      details: { workflowCode: code },
    });
    const result: RunResult = { runId: run.id, status: "FAILED", metrics, error: error.toJSON() };
    await this.database.events.append({
      runId: run.id,
      type: "RUN_FAILED",
      level: "ERROR",
      occurredAt: new Date().toISOString(),
      payload: asJson({ code, message, metrics }),
    });
    return result;
  }

  private createModel(run: RunExecutionRecord): LanguageModelPort {
    return this.modelFactory?.(run) ?? createEnvironmentModel(run, this.environment);
  }

  private createReviewer(run: RunExecutionRecord): LanguageModelPort {
    return this.reviewerFactory?.(run) ?? createEnvironmentModel(run, this.environment);
  }
}

function createTools(git: SandboxGitService): {
  executor: DefaultToolExecutor;
  tools: readonly ModelToolDescriptor[];
} {
  const registry = new ToolRegistry();
  registerCoreTools(registry, git);
  return {
    executor: new DefaultToolExecutor(
      registry,
      new ExplicitToolPolicy(["READ", "WRITE", "EXECUTE", "GIT"]),
    ),
    tools: registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

function createEnvironmentModel(
  run: RunExecutionRecord,
  environment: WorkerEnvironment,
): LanguageModelPort {
  const provider = run.modelProvider ?? environment.LLM_PROVIDER;
  const model = run.modelName ?? environment.LLM_MODEL;
  const apiKey = environment.LLM_API_KEY;
  if (
    (provider !== "openai" && provider !== "openai-compatible") ||
    model === undefined ||
    apiKey === undefined
  ) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Worker LLM_PROVIDER, LLM_MODEL and LLM_API_KEY must be configured.",
    });
  }
  return createConfiguredLanguageModel({
    provider: provider satisfies SupportedLlmProvider,
    model,
    apiKey,
    ...(environment.LLM_BASE_URL === undefined ? {} : { baseUrl: environment.LLM_BASE_URL }),
    ...(environment.LLM_PROVIDER_NAME === undefined
      ? {}
      : { providerName: environment.LLM_PROVIDER_NAME }),
  });
}

function extractPlan(request: unknown): AgentPlan | undefined {
  const direct = AgentPlanSchema.safeParse(request);
  if (direct.success) return direct.data;
  if (typeof request !== "object" || request === null || !("plan" in request)) return undefined;
  const nested = AgentPlanSchema.safeParse((request as { plan?: unknown }).plan);
  return nested.success ? nested.data : undefined;
}

function parseModelJson<T>(
  text: string | undefined,
  schema: { parse(input: unknown): T },
  label: string,
): T {
  const raw = text?.trim();
  if (raw === undefined || raw.length === 0) {
    throw new DevflowError({ code: "LLM_FAILED", message: `${label} was empty.` });
  }
  const unfenced = raw.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    return schema.parse(JSON.parse(unfenced));
  } catch (error) {
    throw new DevflowError({
      code: "LLM_FAILED",
      message: `${label} was not valid JSON.`,
      cause: error,
    });
  }
}

async function detectTestCommand(
  sandbox: SandboxSession,
  signal: AbortSignal,
): Promise<{ program: string; args: string[]; cwd: string } | undefined> {
  const entries = await sandbox.listFiles({ path: ".", recursive: false, maxEntries: 200 }, signal);
  const names = new Set(entries.entries.map((entry) => entry.path.replace(/^\.\//u, "")));
  if (names.has("package.json")) {
    const file = await sandbox.readFile({ path: "package.json", maxBytes: 200_000 }, signal);
    try {
      const manifest = JSON.parse(file.content) as { scripts?: Record<string, unknown> };
      if (typeof manifest.scripts?.test === "string") {
        return { program: "npm", args: ["test"], cwd: "." };
      }
    } catch {
      // The implementation agent will surface malformed package.json via its own tools.
    }
  }
  if (["pyproject.toml", "pytest.ini", "setup.cfg"].some((name) => names.has(name))) {
    return { program: "python", args: ["-m", "pytest"], cwd: "." };
  }
  if (names.has("Cargo.toml")) return { program: "cargo", args: ["test"], cwd: "." };
  if (names.has("go.mod")) return { program: "go", args: ["test", "./..."], cwd: "." };
  return undefined;
}

function noTestsDetected(): CommandResult {
  return {
    exitCode: 0,
    stdout: "No supported project test command was detected.",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    outputTruncated: false,
  };
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

function mergeMetrics(target: RunMetrics, source: RunMetrics): void {
  target.steps += source.steps;
  target.modelCalls += source.modelCalls;
  target.toolCalls += source.toolCalls;
  target.retries += source.retries;
  target.modelLatencyMs += source.modelLatencyMs;
  target.toolLatencyMs += source.toolLatencyMs;
  target.tokenUsage.inputTokens += source.tokenUsage.inputTokens;
  target.tokenUsage.outputTokens += source.tokenUsage.outputTokens;
  target.tokenUsage.totalTokens += source.tokenUsage.totalTokens;
}

function localSourcePath(sourceUri: string): string {
  return path.resolve(sourceUri.startsWith("file:") ? fileURLToPath(sourceUri) : sourceUri);
}

function testOutput(result: CommandResult): string {
  return `exitCode=${String(result.exitCode)} durationMs=${String(result.durationMs)}\nstdout:\n${truncate(result.stdout)}\nstderr:\n${truncate(result.stderr)}`;
}

function truncate(value: string, max = 50_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function asJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch (error) {
    return {
      error: toDevflowError(error, {
        code: "INTERNAL_ERROR",
        message: "Could not serialize workflow payload.",
      }).message,
    };
  }
}
