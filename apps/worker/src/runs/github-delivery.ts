import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import {
  EnvironmentGitHubCredentialSource,
  GitHubBranchSchema,
  GitHubChangeSchema,
  GitHubProviderError,
  GitHubPublicationCoordinator,
  GitHubRestProvider,
  branchNameForRun,
  operationKeyForRun,
  redactGitHubSecrets,
  type GitHubApprovalGrant,
  type GitHubChange,
  type GitHubProvider,
  type GitHubPublicationRecord,
} from "@devflow/github";
import {
  DevflowError,
  RunMetricsSchema,
  type JsonValue,
  type RunMetrics,
  type RunResult,
} from "@devflow/shared";

import type { WorkerEnvironment } from "../config/env.js";
import { parseGitHubRepositoryUri } from "./github-changeset.js";
import type {
  RunExecutionOutcome,
  RunExecutionPort,
  WaitingGitHubApprovalResult,
} from "./run-execution.js";

export type GitHubProviderFactory = (run: RunExecutionRecord) => GitHubProvider;

/**
 * Publishes an approved change set: PUSH, then (after a second approval) CREATE_PR.
 * Independent of how the candidate was produced, so every execution mode shares it.
 */
export class GitHubDeliveryExecutor implements RunExecutionPort {
  constructor(
    private readonly database: DatabaseAdapter,
    private readonly environment: WorkerEnvironment,
    private readonly providerFactory?: GitHubProviderFactory,
  ) {}

  async execute(run: RunExecutionRecord, signal: AbortSignal): Promise<RunExecutionOutcome> {
    if (run.currentStage === "PUSH") return await this.push(run, signal);
    if (run.currentStage === "CREATE_PR") return await this.createPullRequest(run, signal);
    throw new DevflowError({
      code: "CONFLICT",
      message: `Run ${run.id} cannot publish from stage ${run.currentStage}.`,
    });
  }

  private async push(run: RunExecutionRecord, signal: AbortSignal): Promise<RunExecutionOutcome> {
    const publication = await this.publication(run.id);
    const approval = await this.approval(run.id, "GITHUB_PUSH");
    const changeSet = await this.changeSet(run.id, publication);
    const coordinator = new GitHubPublicationCoordinator(
      this.provider(run),
      this.database.githubPublications,
    );
    const pushed = await this.operation(
      run.id,
      "PUSH",
      async () =>
        await coordinator.pushApproved(
          run.id,
          approval,
          {
            operationKey: publication.pushOperationKey,
            repository: publication.repository,
            baseCommit: publication.baseCommit,
            baseBranch: publication.baseBranch,
            branchName: publication.branchName,
            commitMessage: `DevFlow: ${run.task.title}`,
            changes: changeSet.changes,
          },
          signal,
        ),
    );
    return {
      status: "WAITING_APPROVAL",
      approvalKind: "GITHUB",
      approval: {
        kind: "GITHUB_PULL_REQUEST",
        request: {
          operationKey: operationKeyForRun(run.id, "pull-request"),
          repository: publication.repository,
          branchName: publication.branchName,
          baseBranch: publication.baseBranch,
          commitSha: pushed.commitSha,
          title: changeSet.pullRequest.title,
        },
      },
    };
  }

  private async createPullRequest(
    run: RunExecutionRecord,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const publication = await this.publication(run.id);
    const approval = await this.approval(run.id, "GITHUB_PULL_REQUEST");
    const changeSet = await this.changeSet(run.id, publication);
    if (publication.commitSha === undefined) {
      throw new DevflowError({
        code: "CONFLICT",
        message: "GitHub publication has no persisted pushed commit.",
      });
    }
    const coordinator = new GitHubPublicationCoordinator(
      this.provider(run),
      this.database.githubPublications,
    );
    const pullRequest = await this.operation(
      run.id,
      "CREATE_PR",
      async () =>
        await coordinator.createPullRequestApproved(
          run.id,
          approval,
          {
            operationKey: operationKeyForRun(run.id, "pull-request"),
            repository: publication.repository,
            branchName: publication.branchName,
            baseBranch: publication.baseBranch,
            title: changeSet.pullRequest.title,
            body: changeSet.pullRequest.body,
          },
          signal,
        ),
    );
    return {
      runId: run.id,
      status: "SUCCEEDED",
      summary: `${changeSet.summary} Pull request #${String(pullRequest.number)}: ${pullRequest.url}`,
      metrics: changeSet.metrics,
    };
  }

  private async publication(runId: string): Promise<GitHubPublicationRecord> {
    const publication = await this.database.githubPublications.findByRunId(runId);
    if (publication === null) {
      throw new DevflowError({
        code: "NOT_FOUND",
        message: "GitHub publication metadata was not found for this run.",
      });
    }
    return publication;
  }

  private async approval(
    runId: string,
    kind: GitHubApprovalGrant["kind"],
  ): Promise<GitHubApprovalGrant> {
    const approval = [...(await this.database.approvals.list(runId))]
      .reverse()
      .find((candidate) => candidate.kind === kind && candidate.status === "APPROVED");
    if (
      approval === undefined ||
      (approval.kind !== "GITHUB_PUSH" && approval.kind !== "GITHUB_PULL_REQUEST")
    ) {
      throw new DevflowError({
        code: "APPROVAL_REQUIRED",
        message: `An approved ${kind} approval is required.`,
      });
    }
    return { id: approval.id, runId: approval.runId, kind: approval.kind, status: approval.status };
  }

  private async changeSet(
    runId: string,
    publication: GitHubPublicationRecord,
  ): Promise<GitHubRunChangeSet> {
    if (publication.changesArtifactId === undefined) {
      throw new DevflowError({
        code: "NOT_FOUND",
        message: "GitHub publication does not reference a persisted change set.",
      });
    }
    const artifact = (await this.database.artifacts.list(runId)).find(
      (candidate) => candidate.id === publication.changesArtifactId,
    );
    if (artifact?.content === undefined) {
      throw new DevflowError({
        code: "NOT_FOUND",
        message: "Persisted GitHub change set was not found.",
      });
    }
    return parseGitHubRunChangeSet(artifact.content);
  }

  private provider(run: RunExecutionRecord): GitHubProvider {
    if (this.providerFactory !== undefined) return this.providerFactory(run);
    if (!this.environment.DEVFLOW_GITHUB_WRITE_ENABLED) {
      throw new DevflowError({
        code: "GITHUB_FAILED",
        message:
          "GitHub writes are disabled. Set DEVFLOW_GITHUB_WRITE_ENABLED=true at the Worker platform boundary after configuring credentials.",
      });
    }
    return new GitHubRestProvider({
      credentials: new EnvironmentGitHubCredentialSource(),
      apiBaseUrl: this.environment.DEVFLOW_GITHUB_API_BASE_URL,
      webBaseUrl: this.environment.DEVFLOW_GITHUB_WEB_BASE_URL,
    });
  }

  private async operation<T>(
    runId: string,
    operation: "PUSH" | "CREATE_PR",
    execute: () => Promise<T>,
  ): Promise<T> {
    try {
      return await execute();
    } catch (error) {
      const providerError =
        error instanceof GitHubProviderError
          ? error
          : new GitHubProviderError(
              "PROVIDER_FAILED",
              redactGitHubSecrets(error instanceof Error ? error.message : String(error)),
              // The provider may already have completed the remote operation before a
              // transient persistence error. Retrying is safe because both push and PR
              // operations carry stable remote markers.
              true,
            );
      await this.database.events.append({
        runId,
        type: "GITHUB_OPERATION_FAILED",
        level: "ERROR",
        occurredAt: new Date().toISOString(),
        payload: { operation, error: providerError.toJSON() },
      });
      throw new DevflowError({
        code: "GITHUB_FAILED",
        message: providerError.message,
        retryable: providerError.retryable,
        details: { operation, provider: providerError.toJSON() },
        cause: error,
      });
    }
  }
}

interface GitHubRunChangeSet {
  changes: GitHubChange[];
  summary: string;
  metrics: RunMetrics;
  pullRequest: { title: string; body: string };
}

function parseGitHubRunChangeSet(content: string): GitHubRunChangeSet {
  try {
    const record = recordValue(JSON.parse(content) as unknown);
    const pullRequest = recordValue(record.pullRequest);
    if (
      record.version !== 1 ||
      !Array.isArray(record.changes) ||
      typeof record.summary !== "string" ||
      record.summary.length === 0 ||
      typeof pullRequest.title !== "string" ||
      pullRequest.title.length === 0 ||
      typeof pullRequest.body !== "string"
    ) {
      throw new Error("Change set fields are invalid.");
    }
    return {
      changes: record.changes.map((change) => GitHubChangeSchema.parse(change)),
      summary: record.summary,
      metrics: RunMetricsSchema.parse(record.metrics),
      pullRequest: { title: pullRequest.title, body: pullRequest.body },
    };
  } catch (error) {
    throw new DevflowError({
      code: "GITHUB_FAILED",
      message: "Persisted GitHub change set is invalid.",
      cause: error,
    });
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Persists the candidate change set and returns the pause that asks a human to approve the
 * push. Shared by every execution mode; the PUSH/CREATE_PR stages then publish it.
 */
export async function prepareGitHubPushApproval(
  database: DatabaseAdapter,
  run: RunExecutionRecord,
  changes: readonly GitHubChange[],
  summary: string,
  metrics: RunMetrics,
): Promise<WaitingGitHubApprovalResult> {
  const repository = parseGitHubRepositoryUri(run.repository.sourceUri);
  const baseCommit = requireFullCommit(run.task.baseCommitSha);
  const baseBranch = GitHubBranchSchema.parse(
    run.task.baseRef ?? run.repository.defaultBranch ?? "main",
  );
  const branchName = branchNameForRun(run.id);
  const pushOperationKey = operationKeyForRun(run.id, "push");
  const artifact = await database.artifacts.create({
    runId: run.id,
    kind: "GITHUB_CHANGESET",
    name: "github-changeset.json",
    mimeType: "application/json",
    content: JSON.stringify(
      {
        version: 1,
        changes,
        summary,
        metrics,
        pullRequest: {
          title: run.task.title,
          body: `${summary}\n\nCreated by DevFlow run ${run.id}.`,
        },
      },
      null,
      2,
    ),
    metadata: JSON.parse(
      JSON.stringify({
        repository,
        baseCommit,
        baseBranch,
        branchName,
        filesChanged: changes.length,
      }),
    ) as JsonValue,
  });
  return {
    status: "WAITING_APPROVAL",
    approvalKind: "GITHUB",
    approval: {
      kind: "GITHUB_PUSH",
      request: {
        operationKey: pushOperationKey,
        repository,
        baseCommit,
        baseBranch,
        branchName,
        filesChanged: changes.length,
      },
      publication: {
        repository,
        baseCommit,
        baseBranch,
        branchName,
        pushOperationKey,
        changesArtifactId: artifact.id,
      },
    },
  };
}

export function requireFullCommit(value: string | undefined): string {
  if (value === undefined || !/^[0-9a-f]{40}$/iu.test(value)) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "GitHub publication requires a fixed 40-character task base commit SHA.",
    });
  }
  return value.toLowerCase();
}
