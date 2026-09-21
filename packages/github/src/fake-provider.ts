import { createHash } from "node:crypto";

import {
  GitHubPullRequestRequestSchema,
  GitHubPushRequestSchema,
  GitHubRepositoryTreeRequestSchema,
  GitHubRepositoryTreeSchema,
  GitHubResolveBaseRequestSchema,
  GitHubResolvedBaseSchema,
  type GitHubProvider,
  type GitHubPublicationRecord,
  type GitHubPublicationStore,
  type GitHubPullRequestRequest,
  type GitHubPullRequestResult,
  type GitHubRepositoryTree,
  type GitHubRepositoryTreeRequest,
  type GitHubResolveBaseRequest,
  type GitHubResolvedBase,
  type GitHubPushRequest,
  type GitHubPushResult,
} from "./contracts.js";
import { GitHubProviderError } from "./contracts.js";

export interface FakeGitHubProviderOptions {
  failPushes?: number;
  failPullRequests?: number;
  defaultBranch?: string;
  baseCommitSha?: string;
  repositoryTree?: GitHubRepositoryTree;
}

export class MemoryGitHubPublicationStore implements GitHubPublicationStore {
  private readonly records = new Map<string, GitHubPublicationRecord>();

  constructor(records: readonly GitHubPublicationRecord[] = []) {
    for (const record of records) this.records.set(record.runId, structuredClone(record));
  }

  async findByRunId(runId: string): Promise<GitHubPublicationRecord | null> {
    const record = this.records.get(runId);
    return record === undefined ? null : structuredClone(record);
  }

  async recordPush(runId: string, operationKey: string, result: GitHubPushResult): Promise<void> {
    const current = this.required(runId);
    if (current.pushOperationKey !== operationKey) {
      throw new GitHubProviderError("CONFLICT", "Push operation key does not match.", false, 409);
    }
    if (current.commitSha !== undefined && current.commitSha !== result.commitSha) {
      throw new GitHubProviderError(
        "CONFLICT",
        "A different commit is already recorded.",
        false,
        409,
      );
    }
    this.records.set(runId, {
      ...current,
      commitSha: result.commitSha,
      branchUrl: result.remoteUrl,
    });
  }

  async recordPullRequest(
    runId: string,
    operationKey: string,
    result: GitHubPullRequestResult,
  ): Promise<void> {
    const current = this.required(runId);
    if (
      current.pullRequestOperationKey !== undefined &&
      current.pullRequestOperationKey !== operationKey
    ) {
      throw new GitHubProviderError(
        "CONFLICT",
        "Pull request operation key does not match.",
        false,
        409,
      );
    }
    if (current.pullRequestNumber !== undefined && current.pullRequestNumber !== result.number) {
      throw new GitHubProviderError(
        "CONFLICT",
        "A different pull request is already recorded.",
        false,
        409,
      );
    }
    this.records.set(runId, {
      ...current,
      pullRequestOperationKey: operationKey,
      pullRequestNumber: result.number,
      pullRequestUrl: result.url,
      pullRequestState: result.state,
    });
  }

  private required(runId: string): GitHubPublicationRecord {
    const record = this.records.get(runId);
    if (record === undefined) {
      throw new GitHubProviderError("NOT_FOUND", "GitHub publication was not initialized.", false);
    }
    return record;
  }
}

/** Deterministic provider for tests. It never performs network or credential access. */
export class FakeGitHubProvider implements GitHubProvider {
  readonly repositoryTreeCalls: GitHubRepositoryTreeRequest[] = [];
  readonly pushCalls: GitHubPushRequest[] = [];
  readonly pullRequestCalls: GitHubPullRequestRequest[] = [];
  readonly pushSideEffects: GitHubPushResult[] = [];
  readonly pullRequestSideEffects: GitHubPullRequestResult[] = [];
  private readonly pushes = new Map<string, GitHubPushResult>();
  private readonly pullRequests = new Map<string, GitHubPullRequestResult>();
  private failPushes: number;
  private failPullRequests: number;
  private readonly defaultBranch: string;
  private readonly baseCommitSha: string;
  private readonly repositoryTree: GitHubRepositoryTree;

  constructor(options: FakeGitHubProviderOptions = {}) {
    this.failPushes = options.failPushes ?? 0;
    this.failPullRequests = options.failPullRequests ?? 0;
    this.defaultBranch = options.defaultBranch ?? "main";
    this.baseCommitSha = options.baseCommitSha ?? "a".repeat(40);
    this.repositoryTree = GitHubRepositoryTreeSchema.parse(
      options.repositoryTree ?? { entries: [], truncated: false },
    );
  }

  async resolveBaseCommit(input: GitHubResolveBaseRequest): Promise<GitHubResolvedBase> {
    const parsed = GitHubResolveBaseRequestSchema.parse(input);
    return GitHubResolvedBaseSchema.parse({
      baseRef: parsed.baseRef ?? this.defaultBranch,
      baseCommitSha: this.baseCommitSha,
    });
  }

  async readRepositoryTree(input: GitHubRepositoryTreeRequest): Promise<GitHubRepositoryTree> {
    const parsed = GitHubRepositoryTreeRequestSchema.parse(input);
    this.repositoryTreeCalls.push(structuredClone(parsed));
    return structuredClone(this.repositoryTree);
  }

  async pushBranch(input: GitHubPushRequest): Promise<GitHubPushResult> {
    const parsed = GitHubPushRequestSchema.parse(input);
    this.pushCalls.push(structuredClone(parsed));
    const existing = this.pushes.get(parsed.operationKey);
    if (existing !== undefined) return { ...existing, idempotent: true };
    if (this.failPushes > 0) {
      this.failPushes -= 1;
      throw new GitHubProviderError("NETWORK_FAILED", "Simulated GitHub push failure.", true);
    }
    const commitSha = createHash("sha1").update(JSON.stringify(parsed)).digest("hex");
    const result: GitHubPushResult = {
      branchName: parsed.branchName,
      commitSha,
      remoteUrl: `https://github.test/${parsed.repository.owner}/${parsed.repository.name}/tree/${encodeURIComponent(parsed.branchName)}`,
      idempotent: false,
    };
    this.pushes.set(parsed.operationKey, result);
    this.pushSideEffects.push(result);
    return result;
  }

  async createPullRequest(input: GitHubPullRequestRequest): Promise<GitHubPullRequestResult> {
    const parsed = GitHubPullRequestRequestSchema.parse(input);
    this.pullRequestCalls.push(structuredClone(parsed));
    const existing = this.pullRequests.get(parsed.operationKey);
    if (existing !== undefined) return { ...existing, idempotent: true };
    if (this.failPullRequests > 0) {
      this.failPullRequests -= 1;
      throw new GitHubProviderError(
        "NETWORK_FAILED",
        "Simulated GitHub pull request failure.",
        true,
      );
    }
    const number = this.pullRequestSideEffects.length + 1;
    const result: GitHubPullRequestResult = {
      number,
      url: `https://github.test/${parsed.repository.owner}/${parsed.repository.name}/pull/${String(number)}`,
      state: "open",
      idempotent: false,
    };
    this.pullRequests.set(parsed.operationKey, result);
    this.pullRequestSideEffects.push(result);
    return result;
  }
}
