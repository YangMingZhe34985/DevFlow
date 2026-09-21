import { z } from "zod";

import {
  GitHubPullRequestRequestSchema,
  GitHubPullRequestResultSchema,
  GitHubRepositoryTreeRequestSchema,
  GitHubRepositoryTreeSchema,
  GitHubResolveBaseRequestSchema,
  GitHubResolvedBaseSchema,
  GitHubPushRequestSchema,
  GitHubPushResultSchema,
  type GitHubCredentialSource,
  type GitHubProvider,
  GitHubProviderError,
  type GitHubProviderErrorCode,
  type GitHubPullRequestRequest,
  type GitHubPullRequestResult,
  type GitHubRepositoryTree,
  type GitHubRepositoryTreeRequest,
  type GitHubResolveBaseRequest,
  type GitHubResolvedBase,
  type GitHubPushRequest,
  type GitHubPushResult,
  type GitHubRepository,
} from "./contracts.js";
import { safeProviderMessage } from "./redaction.js";

const API_VERSION = "2022-11-28";
const OPERATION_TRAILER = "DevFlow-Operation";
const GitHubTreeResponseSchema = z
  .object({
    tree: z
      .array(
        z
          .object({
            path: z.string().min(1),
            mode: z.string().min(1),
            type: z.enum(["blob", "tree", "commit"]),
            size: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .max(100_000),
    truncated: z.boolean(),
  })
  .passthrough();

export interface GitHubRestProviderOptions {
  credentials: GitHubCredentialSource;
  apiBaseUrl?: string;
  webBaseUrl?: string;
  userAgent?: string;
  fetch?: typeof fetch;
}

/**
 * Platform-owned REST adapter. The credential source is deliberately absent from
 * every public operation request and result so Agent/LLM state cannot receive it.
 */
export class GitHubRestProvider implements GitHubProvider {
  private readonly apiBaseUrl: string;
  private readonly webBaseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitHubRestProviderOptions) {
    this.apiBaseUrl = secureBaseUrl(options.apiBaseUrl ?? "https://api.github.com");
    this.webBaseUrl = secureBaseUrl(options.webBaseUrl ?? "https://github.com");
    this.userAgent = options.userAgent ?? "devflow-github-adapter";
    this.fetchImpl = options.fetch ?? fetch;
  }

  async resolveBaseCommit(
    input: GitHubResolveBaseRequest,
    signal?: AbortSignal,
  ): Promise<GitHubResolvedBase> {
    const request = GitHubResolveBaseRequestSchema.parse(input);
    const baseRef =
      request.baseRef ??
      (await this.readRequest<{ default_branch: string }>(request.repository, "", signal))
        .default_branch;
    const commit = await this.readRequest<{ sha: string }>(
      request.repository,
      `/commits/${encodeURIComponent(baseRef)}`,
      signal,
    );
    return GitHubResolvedBaseSchema.parse({ baseRef, baseCommitSha: commit.sha });
  }

  async readRepositoryTree(
    input: GitHubRepositoryTreeRequest,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryTree> {
    const request = GitHubRepositoryTreeRequestSchema.parse(input);
    const response = GitHubTreeResponseSchema.parse(
      await this.readRequest<unknown>(
        request.repository,
        `/git/trees/${encodeURIComponent(request.baseCommitSha)}?recursive=1`,
        signal,
      ),
    );
    return GitHubRepositoryTreeSchema.parse({
      entries: response.tree.map((entry) => ({
        path: entry.path,
        kind:
          entry.type === "tree" || entry.type === "commit"
            ? "DIRECTORY"
            : entry.mode === "120000"
              ? "SYMLINK"
              : "FILE",
        ...(entry.size === undefined ? {} : { sizeBytes: entry.size }),
      })),
      truncated: response.truncated,
    });
  }

  async pushBranch(input: GitHubPushRequest, signal?: AbortSignal): Promise<GitHubPushResult> {
    const request = GitHubPushRequestSchema.parse(input);
    const marker = operationMarker(request.operationKey);
    const existing = await this.findBranch(request.repository, request.branchName, signal);
    if (existing !== null) {
      return await this.existingPushResult(request, existing, marker, signal);
    }

    const base = await this.getCommit(request.repository, request.baseCommit, signal);
    const tree = await this.createTree(request, base.tree.sha, signal);
    const commit = await this.request<GitCommit>(
      request.repository,
      "POST",
      "/git/commits",
      {
        message: `${request.commitMessage}\n\n${marker}`,
        tree: tree.sha,
        parents: [request.baseCommit],
      },
      signal,
    );

    try {
      await this.request(
        request.repository,
        "POST",
        "/git/refs",
        { ref: `refs/heads/${request.branchName}`, sha: commit.sha },
        signal,
      );
    } catch (error) {
      if (!(error instanceof GitHubProviderError) || error.code !== "CONFLICT") throw error;
      // A duplicate queue delivery can race after creating the commit but before
      // observing the ref. Re-read and accept only our operation marker.
      const raced = await this.findBranch(request.repository, request.branchName, signal);
      if (raced === null) throw error;
      return await this.existingPushResult(request, raced, marker, signal);
    }

    return GitHubPushResultSchema.parse({
      branchName: request.branchName,
      commitSha: commit.sha,
      remoteUrl: this.branchUrl(request.repository, request.branchName),
      idempotent: false,
    });
  }

  async createPullRequest(
    input: GitHubPullRequestRequest,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestResult> {
    const request = GitHubPullRequestRequestSchema.parse(input);
    const marker = operationMarker(request.operationKey);
    const existing = await this.findPullRequest(request, marker, signal);
    if (existing !== null) return pullRequestResult(existing, true);

    try {
      const created = await this.request<PullRequestResponse>(
        request.repository,
        "POST",
        "/pulls",
        {
          title: request.title,
          head: request.branchName,
          base: request.baseBranch,
          body: `${request.body}\n\n<!-- ${marker} -->`,
        },
        signal,
      );
      return pullRequestResult(created, false);
    } catch (error) {
      if (!(error instanceof GitHubProviderError) || error.code !== "CONFLICT") throw error;
      const raced = await this.findPullRequest(request, marker, signal);
      if (raced === null) throw error;
      return pullRequestResult(raced, true);
    }
  }

  private async createTree(
    request: GitHubPushRequest,
    baseTree: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string }> {
    const tree: Array<{
      path: string;
      mode: "100644" | "100755" | "120000";
      type: "blob";
      sha: string | null;
    }> = [];
    for (const change of request.changes) {
      if (change.kind === "DELETE") {
        tree.push({ path: change.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const blob = await this.request<{ sha: string }>(
        request.repository,
        "POST",
        "/git/blobs",
        { content: change.contentBase64, encoding: "base64" },
        signal,
      );
      tree.push({ path: change.path, mode: change.mode, type: "blob", sha: blob.sha });
    }
    return await this.request(
      request.repository,
      "POST",
      "/git/trees",
      { base_tree: baseTree, tree },
      signal,
    );
  }

  private async existingPushResult(
    request: GitHubPushRequest,
    ref: GitReference,
    marker: string,
    signal?: AbortSignal,
  ): Promise<GitHubPushResult> {
    const commit = await this.getCommit(request.repository, ref.object.sha, signal);
    if (!commit.message.includes(marker)) {
      throw new GitHubProviderError(
        "CONFLICT",
        `Remote branch '${request.branchName}' already exists and belongs to another operation.`,
        false,
        409,
      );
    }
    return GitHubPushResultSchema.parse({
      branchName: request.branchName,
      commitSha: ref.object.sha,
      remoteUrl: this.branchUrl(request.repository, request.branchName),
      idempotent: true,
    });
  }

  private async findBranch(
    repository: GitHubRepository,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GitReference | null> {
    return await this.request<GitReference>(
      repository,
      "GET",
      `/git/ref/heads/${encodeURIComponent(branch)}`,
      undefined,
      signal,
      true,
    );
  }

  private async getCommit(
    repository: GitHubRepository,
    sha: string,
    signal?: AbortSignal,
  ): Promise<GitCommit> {
    return await this.request(repository, "GET", `/git/commits/${sha}`, undefined, signal);
  }

  private async findPullRequest(
    request: GitHubPullRequestRequest,
    marker: string,
    signal?: AbortSignal,
  ): Promise<PullRequestResponse | null> {
    const query = new URLSearchParams({
      state: "all",
      head: `${request.repository.owner}:${request.branchName}`,
      base: request.baseBranch,
      per_page: "100",
    });
    const candidates = await this.request<PullRequestResponse[]>(
      request.repository,
      "GET",
      `/pulls?${query.toString()}`,
      undefined,
      signal,
    );
    const matchingBranch = candidates.find(
      (candidate) =>
        candidate.head.ref === request.branchName && candidate.base.ref === request.baseBranch,
    );
    if (matchingBranch === undefined) return null;
    if (!(matchingBranch.body ?? "").includes(marker)) {
      throw new GitHubProviderError(
        "CONFLICT",
        `A pull request already exists for branch '${request.branchName}' under another operation.`,
        false,
        409,
      );
    }
    return matchingBranch;
  }

  private async request<T>(
    repository: GitHubRepository,
    method: "GET" | "POST",
    suffix: string,
    body?: unknown,
    signal?: AbortSignal,
    returnNullOnNotFound?: false,
  ): Promise<T>;
  private async request<T>(
    repository: GitHubRepository,
    method: "GET" | "POST",
    suffix: string,
    body: unknown,
    signal: AbortSignal | undefined,
    returnNullOnNotFound: true,
  ): Promise<T | null>;
  private async request<T>(
    repository: GitHubRepository,
    method: "GET" | "POST",
    suffix: string,
    body?: unknown,
    signal?: AbortSignal,
    returnNullOnNotFound = false,
  ): Promise<T | null> {
    let token = "";
    try {
      token = await this.options.credentials.getToken(signal);
      if (token.trim().length === 0) {
        throw new GitHubProviderError(
          "AUTHENTICATION_FAILED",
          "GitHub credential source returned an empty token.",
          false,
        );
      }
      const response = await this.fetchImpl(this.repositoryUrl(repository, suffix), {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": this.userAgent,
          "X-GitHub-Api-Version": API_VERSION,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (returnNullOnNotFound && response.status === 404) return null;
      const text = await response.text();
      if (!response.ok) {
        const providerMessage = parseProviderMessage(text);
        throw providerHttpError(response.status, providerMessage, [token]);
      }
      if (text.length === 0) return undefined as T;
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof GitHubProviderError) throw error;
      throw new GitHubProviderError(
        "NETWORK_FAILED",
        `GitHub request failed: ${safeProviderMessage(error, [token])}`,
        signal?.aborted !== true,
        undefined,
        { cause: error },
      );
    }
  }

  /**
   * Read-only repository discovery may run anonymously for public repositories.
   * If a platform token is configured it is still consumed only inside this adapter.
   */
  private async readRequest<T>(
    repository: GitHubRepository,
    suffix: string,
    signal?: AbortSignal,
  ): Promise<T> {
    let token = "";
    try {
      token = await this.options.credentials.getToken(signal);
    } catch (error) {
      if (!(error instanceof GitHubProviderError) || error.code !== "AUTHENTICATION_FAILED") {
        throw error;
      }
    }
    try {
      const response = await this.fetchImpl(this.repositoryUrl(repository, suffix), {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          ...(token.length === 0 ? {} : { Authorization: `Bearer ${token}` }),
          "User-Agent": this.userAgent,
          "X-GitHub-Api-Version": API_VERSION,
        },
        ...(signal === undefined ? {} : { signal }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw providerHttpError(response.status, parseProviderMessage(text), [token]);
      }
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof GitHubProviderError) throw error;
      throw new GitHubProviderError(
        "NETWORK_FAILED",
        `GitHub request failed: ${safeProviderMessage(error, [token])}`,
        signal?.aborted !== true,
        undefined,
        { cause: error },
      );
    }
  }

  private repositoryUrl(repository: GitHubRepository, suffix: string): string {
    return `${this.apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${suffix}`;
  }

  private branchUrl(repository: GitHubRepository, branch: string): string {
    return `${this.webBaseUrl}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/tree/${encodeURIComponent(branch)}`;
  }
}

export class EnvironmentGitHubCredentialSource implements GitHubCredentialSource {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly variableName = "GITHUB_TOKEN",
  ) {}

  async getToken(): Promise<string> {
    const token = this.environment[this.variableName];
    if (token === undefined || token.trim().length === 0) {
      throw new GitHubProviderError(
        "AUTHENTICATION_FAILED",
        `Platform GitHub credential '${this.variableName}' is not configured.`,
        false,
      );
    }
    return token;
  }
}

interface GitReference {
  ref: string;
  object: { sha: string; type: string; url: string };
}

interface GitCommit {
  sha: string;
  message: string;
  tree: { sha: string };
}

interface PullRequestResponse {
  number: number;
  html_url: string;
  state: "open" | "closed";
  body: string | null;
  head: { ref: string };
  base: { ref: string };
}

function operationMarker(operationKey: string): string {
  return `${OPERATION_TRAILER}: ${operationKey}`;
}

function pullRequestResult(
  response: PullRequestResponse,
  idempotent: boolean,
): GitHubPullRequestResult {
  return GitHubPullRequestResultSchema.parse({
    number: response.number,
    url: response.html_url,
    state: response.state,
    idempotent,
  });
}

function parseProviderMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : "GitHub API request failed.";
  } catch {
    return "GitHub API request failed.";
  }
}

function providerHttpError(
  status: number,
  providerMessage: string,
  secrets: readonly string[],
): GitHubProviderError {
  const mapping: { code: GitHubProviderErrorCode; retryable: boolean } =
    status === 401
      ? { code: "AUTHENTICATION_FAILED", retryable: false }
      : status === 403
        ? { code: "AUTHORIZATION_FAILED", retryable: false }
        : status === 404
          ? { code: "NOT_FOUND", retryable: false }
          : status === 409 || status === 422
            ? { code: "CONFLICT", retryable: false }
            : status === 429
              ? { code: "RATE_LIMITED", retryable: true }
              : status >= 500
                ? { code: "PROVIDER_FAILED", retryable: true }
                : { code: "INVALID_REQUEST", retryable: false };
  return new GitHubProviderError(
    mapping.code,
    `GitHub API request failed (${String(status)}): ${safeProviderMessage(providerMessage, secrets)}`,
    mapping.retryable,
    status,
  );
}

function secureBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("GitHub provider base URLs must use HTTPS.");
  }
  return url.toString().replace(/\/$/u, "");
}
