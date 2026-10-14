import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import {
  GitHubBranchSchema,
  branchNameForRun,
  operationKeyForRun,
  type GitHubChange,
} from "@devflow/github";
import { DevflowError, type JsonValue, type RunMetrics } from "@devflow/shared";

import { parseGitHubRepositoryUri } from "./github-changeset.js";
import type { WaitingGitHubApprovalResult } from "./run-execution.js";

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
