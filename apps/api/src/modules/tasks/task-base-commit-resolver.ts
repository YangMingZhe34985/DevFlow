import { fileURLToPath } from "node:url";

import { Inject, Injectable } from "@nestjs/common";

import type { RepositoryRecord } from "@devflow/database";
import {
  GitHubProviderError,
  parseGitHubRepositoryUri,
  type GitHubProvider,
} from "@devflow/github";
import { resolveLocalFilesystemPath, resolveLocalRepositoryBase } from "@devflow/sandbox";
import { DevflowError } from "@devflow/shared";

import { GITHUB_PROVIDER } from "../../infrastructure/tokens.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

export interface ResolvedTaskBase {
  baseRef: string;
  baseCommitSha: string;
}

@Injectable()
export class TaskBaseCommitResolver {
  constructor(@Inject(GITHUB_PROVIDER) private readonly github: GitHubProvider) {}

  async resolve(
    repository: RepositoryRecord,
    requestedBaseRef?: string,
  ): Promise<ResolvedTaskBase> {
    if (repository.sourceKind === "LOCAL") {
      const sourcePath = resolveLocalFilesystemPath(repository.sourceUri, PROJECT_ROOT);
      const configuredRoot = process.env.DEVFLOW_LOCAL_REPOSITORY_ROOT;
      return await resolveLocalRepositoryBase({
        sourceUri: repository.sourceUri,
        workspaceRoot:
          configuredRoot === undefined || configuredRoot.trim().length === 0
            ? sourcePath
            : resolveLocalFilesystemPath(configuredRoot, PROJECT_ROOT),
        ...(requestedBaseRef === undefined ? {} : { baseRef: requestedBaseRef }),
      });
    }

    const baseRef = requestedBaseRef ?? repository.defaultBranch;
    try {
      return await this.github.resolveBaseCommit({
        repository: parseGitHubRepositoryUri(repository.sourceUri),
        ...(baseRef === undefined ? {} : { baseRef }),
      });
    } catch (error) {
      if (error instanceof DevflowError) throw error;
      if (!(error instanceof GitHubProviderError)) {
        throw new DevflowError({
          code: "GITHUB_FAILED",
          message: "GitHub returned invalid base commit metadata.",
          details: {
            sourceKind: "GIT",
            ...(baseRef === undefined ? {} : { baseRef }),
          },
          cause: error,
        });
      }
      throw new DevflowError({
        code: error.code === "NOT_FOUND" ? "NOT_FOUND" : "GITHUB_FAILED",
        message:
          error.code === "NOT_FOUND"
            ? `GitHub repository base ref '${baseRef ?? "<default branch>"}' could not be resolved.`
            : `GitHub base commit resolution failed: ${error.message}`,
        retryable: error.retryable,
        details: {
          sourceKind: "GIT",
          ...(baseRef === undefined ? {} : { baseRef }),
          providerCode: error.code,
        },
      });
    }
  }
}
