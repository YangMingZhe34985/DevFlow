import {
  GitHubPullRequestRequestSchema,
  GitHubPushRequestSchema,
  type GitHubApprovalGrant,
  type GitHubProvider,
  type GitHubPublicationStore,
  type GitHubPullRequestRequest,
  type GitHubPullRequestResult,
  type GitHubPushRequest,
  type GitHubPushResult,
} from "./contracts.js";
import { GitHubProviderError } from "./contracts.js";

const DEFAULT_RECONCILIATION_TIMEOUT_MS = 30_000;
const DEFAULT_RECONCILIATION_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 25;

export interface GitHubPublicationCoordinatorOptions {
  /**
   * Bounds the platform-owned reconciliation zone after a remote write starts.
   * User cancellation is intentionally not linked to this signal: once GitHub
   * may have accepted a write, the stable operation marker must be reconciled
   * and durably recorded before control returns to the workflow.
   */
  reconciliationTimeoutMs?: number;
  reconciliationAttempts?: number;
  retryDelayMs?: number;
}

export class GitHubPublicationCoordinator {
  private readonly reconciliationTimeoutMs: number;
  private readonly reconciliationAttempts: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly provider: GitHubProvider,
    private readonly store: GitHubPublicationStore,
    options: GitHubPublicationCoordinatorOptions = {},
  ) {
    this.reconciliationTimeoutMs = positiveInteger(
      options.reconciliationTimeoutMs ?? DEFAULT_RECONCILIATION_TIMEOUT_MS,
      "reconciliationTimeoutMs",
    );
    this.reconciliationAttempts = positiveInteger(
      options.reconciliationAttempts ?? DEFAULT_RECONCILIATION_ATTEMPTS,
      "reconciliationAttempts",
    );
    this.retryDelayMs = nonnegativeInteger(
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      "retryDelayMs",
    );
  }

  async pushApproved(
    runId: string,
    approval: GitHubApprovalGrant,
    request: GitHubPushRequest,
    signal?: AbortSignal,
  ): Promise<GitHubPushResult> {
    requireApproval(runId, approval, "GITHUB_PUSH");
    const parsed = GitHubPushRequestSchema.parse(request);
    const publication = await this.store.findByRunId(runId);
    if (publication?.commitSha !== undefined) {
      if (publication.pushOperationKey !== parsed.operationKey) {
        throw conflict("Run already has a push recorded under a different operation key.");
      }
      return {
        branchName: publication.branchName,
        commitSha: publication.commitSha,
        remoteUrl:
          publication.branchUrl ?? branchUrl(publication.repository, publication.branchName),
        idempotent: true,
      };
    }
    throwIfCancelledBeforeWrite(signal);
    return await this.reconcile(
      (reconciliationSignal) => this.provider.pushBranch(parsed, reconciliationSignal),
      async (result) => await this.store.recordPush(runId, parsed.operationKey, result),
    );
  }

  async createPullRequestApproved(
    runId: string,
    approval: GitHubApprovalGrant,
    request: GitHubPullRequestRequest,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestResult> {
    requireApproval(runId, approval, "GITHUB_PULL_REQUEST");
    const parsed = GitHubPullRequestRequestSchema.parse(request);
    const publication = await this.store.findByRunId(runId);
    if (publication?.commitSha === undefined) {
      throw conflict("A branch must be pushed before a pull request can be created.");
    }
    if (publication.branchName !== parsed.branchName) {
      throw conflict("Pull request head does not match the persisted run branch.");
    }
    if (publication.pullRequestNumber !== undefined && publication.pullRequestUrl !== undefined) {
      if (publication.pullRequestOperationKey !== parsed.operationKey) {
        throw conflict("Run already has a pull request under a different operation key.");
      }
      return {
        number: publication.pullRequestNumber,
        url: publication.pullRequestUrl,
        state: publication.pullRequestState ?? "open",
        idempotent: true,
      };
    }
    throwIfCancelledBeforeWrite(signal);
    return await this.reconcile(
      (reconciliationSignal) => this.provider.createPullRequest(parsed, reconciliationSignal),
      async (result) => await this.store.recordPullRequest(runId, parsed.operationKey, result),
    );
  }

  private async reconcile<T>(
    execute: (signal: AbortSignal) => Promise<T>,
    persist: (result: T) => Promise<void>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(
        new GitHubProviderError("NETWORK_FAILED", "GitHub reconciliation timed out.", false),
      );
    }, this.reconciliationTimeoutMs);

    let lastError: unknown;
    try {
      for (let attempt = 1; attempt <= this.reconciliationAttempts; attempt += 1) {
        try {
          const result = await withinReconciliationWindow(controller.signal, () =>
            execute(controller.signal),
          );
          await withinReconciliationWindow(controller.signal, async () => await persist(result));
          return result;
        } catch (error) {
          lastError = error;
          if (
            attempt === this.reconciliationAttempts ||
            controller.signal.aborted ||
            !isRetryableReconciliationFailure(error)
          ) {
            throw error;
          }
          await waitForRetry(this.retryDelayMs, controller.signal);
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    // The loop always returns or throws, but retaining the original failure here
    // makes the invariant explicit if its bounds are changed in the future.
    throw lastError;
  }
}

function throwIfCancelledBeforeWrite(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException("The GitHub operation was cancelled before it started.", "AbortError");
}

function isRetryableReconciliationFailure(error: unknown): boolean {
  if (error instanceof GitHubProviderError) return error.retryable;
  if (typeof error === "object" && error !== null && "retryable" in error) {
    return (error as { retryable?: unknown }).retryable === true;
  }
  // Store failures are ambiguous: the transaction may have committed before
  // the response was lost. Re-invoking the provider with the stable marker and
  // recording its idempotent result is the only safe recovery path.
  return true;
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  if (delayMs === 0) {
    await Promise.resolve();
    if (signal.aborted) throw signal.reason;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", aborted, { once: true });

    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolve();
    }

    function aborted(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
  });
}

async function withinReconciliationWindow<T>(
  signal: AbortSignal,
  execute: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    signal.addEventListener("abort", aborted, { once: true });
    void execute().then(completed, failed);

    function completed(value: T): void {
      signal.removeEventListener("abort", aborted);
      resolve(value);
    }

    function failed(error: unknown): void {
      signal.removeEventListener("abort", aborted);
      reject(error);
    }

    function aborted(): void {
      reject(signal.reason);
    }
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function requireApproval(
  runId: string,
  approval: GitHubApprovalGrant,
  expectedKind: GitHubApprovalGrant["kind"],
): void {
  if (
    approval.runId !== runId ||
    approval.kind !== expectedKind ||
    approval.status !== "APPROVED"
  ) {
    throw new GitHubProviderError(
      "AUTHORIZATION_FAILED",
      `An approved ${expectedKind} approval for this run is required.`,
      false,
    );
  }
}

function conflict(message: string): GitHubProviderError {
  return new GitHubProviderError("CONFLICT", message, false, 409);
}

function branchUrl(repository: { owner: string; name: string }, branch: string): string {
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/tree/${encodeURIComponent(branch)}`;
}
