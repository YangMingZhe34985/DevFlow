import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createConfiguredLanguageModel,
  DefaultAgentRuntime,
  JsonFileAgentStateStore,
  type LanguageModelPort,
  type ModelToolDescriptor,
  type SupportedLlmProvider,
} from "@devflow/agent";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import { SandboxGitService } from "@devflow/git";
import {
  DockerSandboxManager,
  resolveLocalFilesystemPath,
  type SandboxSession,
} from "@devflow/sandbox";
import { DevflowError, type RunResult } from "@devflow/shared";
import {
  DefaultToolExecutor,
  ExplicitToolPolicy,
  registerCoreTools,
  ToolRegistry,
  type ToolExecutionRequest,
} from "@devflow/tools";
import {
  cancelWorkflow,
  failWorkflow,
  transitionStage,
  type WorkflowState,
} from "@devflow/workflow";

import type { WorkerEnvironment } from "../config/env.js";
import type { RunExecutionPort } from "./run-execution.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export type LanguageModelFactory = (run: RunExecutionRecord) => LanguageModelPort;

export class DockerAgentRunExecutor implements RunExecutionPort {
  constructor(
    private readonly database: DatabaseAdapter,
    private readonly environment: WorkerEnvironment,
    private readonly modelFactory?: LanguageModelFactory,
  ) {}

  async execute(run: RunExecutionRecord, signal: AbortSignal): Promise<RunResult> {
    const sourceUri = run.repository.sourceUri;
    const workspaceRoot =
      run.repository.sourceKind === "LOCAL" ? localSourcePath(sourceUri) : PROJECT_ROOT;
    const manager = new DockerSandboxManager({
      image: this.environment.DEVFLOW_SANDBOX_IMAGE,
      workspaceRoot,
    });
    let sandbox: SandboxSession | undefined;
    try {
      sandbox = await manager.create(
        {
          runId: run.id,
          repository: {
            sourceUri,
            ...(run.task.baseRef === undefined ? {} : { baseRef: run.task.baseRef }),
            ...(run.task.baseCommitSha === undefined ? {} : { baseCommit: run.task.baseCommitSha }),
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
      const registry = new ToolRegistry();
      registerCoreTools(registry, git);
      const executor = new DefaultToolExecutor(
        registry,
        new ExplicitToolPolicy(["READ", "WRITE", "EXECUTE", "GIT"]),
      );
      const tools: ModelToolDescriptor[] = registry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      const runtime = new DefaultAgentRuntime(this.createModel(run));
      const stateStore = new JsonFileAgentStateStore(resolveStateDirectory(this.environment));
      const currentSandbox = sandbox;
      await this.database.events.append({
        runId: run.id,
        type: "RUN_STARTED",
        occurredAt: new Date().toISOString(),
        payload: { workflow: "legacy", resumed: run.retryCount > 0 },
      });
      const result = await runtime.run(
        {
          maxSteps: run.maxSteps,
          timeoutMs: this.environment.DEVFLOW_TIMEOUT_MS,
          maxRetries: this.environment.DEVFLOW_MAX_RETRIES,
          emitRunLifecycle: false,
        },
        {
          runId: run.id,
          task: {
            taskId: run.task.id,
            repositoryId: run.repository.id,
            title: run.task.title,
            description: run.task.description,
            ...(run.task.baseCommitSha === undefined
              ? {}
              : { baseCommitSha: run.task.baseCommitSha }),
          },
          signal,
          tools,
          stateStore,
          emit: async (event) => {
            await this.database.events.append(event);
          },
          executeTool: async (stepId, request: ToolExecutionRequest, toolSignal = signal) =>
            await executor.execute(request, {
              runId: run.id,
              stepId,
              sandbox: currentSandbox,
              signal: toolSignal,
              emit: async (event) => {
                await this.database.events.append(event);
              },
            }),
        },
      );
      validateWorkflowResult(run, result);
      return result;
    } finally {
      await sandbox?.dispose();
    }
  }

  private createModel(run: RunExecutionRecord): LanguageModelPort {
    if (this.modelFactory !== undefined) return this.modelFactory(run);
    const provider = run.modelProvider ?? this.environment.LLM_PROVIDER;
    const model = run.modelName ?? this.environment.LLM_MODEL;
    const apiKey = this.environment.LLM_API_KEY;
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
      ...(this.environment.LLM_BASE_URL === undefined
        ? {}
        : { baseUrl: this.environment.LLM_BASE_URL }),
      ...(this.environment.LLM_PROVIDER_NAME === undefined
        ? {}
        : { providerName: this.environment.LLM_PROVIDER_NAME }),
      structuredOutputMode: this.environment.LLM_STRUCTURED_OUTPUT_MODE,
    });
  }
}

function localSourcePath(sourceUri: string): string {
  return resolveLocalFilesystemPath(sourceUri, PROJECT_ROOT);
}

function resolveStateDirectory(environment: WorkerEnvironment): string {
  return path.isAbsolute(environment.DEVFLOW_STATE_DIR)
    ? environment.DEVFLOW_STATE_DIR
    : path.resolve(PROJECT_ROOT, environment.DEVFLOW_STATE_DIR);
}

function validateWorkflowResult(run: RunExecutionRecord, result: RunResult): WorkflowState {
  let state: WorkflowState = {
    runId: run.id,
    stage: "EXECUTE",
    status: "RUNNING",
    testAttempt: 0,
    reviewAttempt: 0,
    maxTestRetries: run.maxTestRetries,
    maxReviewRetries: 1,
  };
  if (result.status === "CANCELLED") return cancelWorkflow(state);
  if (result.status !== "SUCCEEDED") {
    return failWorkflow(
      state,
      result.error ?? {
        code: "INTERNAL_ERROR",
        message: "Agent run failed without an error payload.",
        retryable: false,
      },
    );
  }
  for (const stage of ["TEST", "REVIEW", "GENERATE_DIFF", "DONE"] as const) {
    state = transitionStage(state, stage);
  }
  return state;
}
