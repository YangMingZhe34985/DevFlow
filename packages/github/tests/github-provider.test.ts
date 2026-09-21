import { describe, expect, it } from "vitest";

import {
  EnvironmentGitHubCredentialSource,
  FakeGitHubProvider,
  GitHubProviderError,
  GitHubPublicationCoordinator,
  GitHubPushRequestSchema,
  MemoryGitHubPublicationStore,
  branchNameForRun,
  operationKeyForRun,
  type GitHubApprovalGrant,
  type GitHubProvider,
  type GitHubPublicationRecord,
  type GitHubPublicationStore,
  type GitHubPullRequestRequest,
  type GitHubPushRequest,
} from "../src/index.js";

const runId = "4b855580-d770-4f48-b2f4-5e4b2f646e9b";
const branchName = branchNameForRun(runId);
const pushOperationKey = operationKeyForRun(runId, "push");
const pullRequestOperationKey = operationKeyForRun(runId, "pull-request");

function pushRequest(): GitHubPushRequest {
  return {
    operationKey: pushOperationKey,
    repository: { owner: "devflow", name: "fixture" },
    baseCommit: "a".repeat(40),
    baseBranch: "main",
    branchName,
    commitMessage: "Fix the fixture",
    changes: [
      {
        kind: "UPSERT",
        path: "src/fix.ts",
        contentBase64: Buffer.from("export const fixed = true;\n").toString("base64"),
        mode: "100644",
      },
      { kind: "DELETE", path: "src/obsolete.ts" },
    ],
  };
}

function pullRequestRequest(): GitHubPullRequestRequest {
  return {
    operationKey: pullRequestOperationKey,
    repository: { owner: "devflow", name: "fixture" },
    branchName,
    baseBranch: "main",
    title: "Fix the fixture",
    body: "Automated change from DevFlow.",
  };
}

function publication(): GitHubPublicationRecord {
  return {
    runId,
    repository: { owner: "devflow", name: "fixture" },
    baseCommit: "a".repeat(40),
    baseBranch: "main",
    branchName,
    pushOperationKey,
    changesArtifactId: "github-changeset-artifact",
  };
}

function approval(
  kind: GitHubApprovalGrant["kind"],
  status: GitHubApprovalGrant["status"] = "APPROVED",
): GitHubApprovalGrant {
  return { id: `${kind}-approval`, runId, kind, status };
}

describe("GitHub provider safety and orchestration", () => {
  it("rejects protected/default branch pushes and unsafe repository paths", () => {
    expect(() => GitHubPushRequestSchema.parse({ ...pushRequest(), branchName: "main" })).toThrow(
      /default\/base branch/u,
    );
    expect(() =>
      GitHubPushRequestSchema.parse({
        ...pushRequest(),
        changes: [{ kind: "DELETE", path: ".git/config" }],
      }),
    ).toThrow(/repository-relative/u);
  });

  it.each(["PENDING", "REJECTED", "CANCELLED", "EXPIRED"] as const)(
    "does not push when approval is %s",
    async (status) => {
      const provider = new FakeGitHubProvider();
      const coordinator = new GitHubPublicationCoordinator(
        provider,
        new MemoryGitHubPublicationStore([publication()]),
      );
      await expect(
        coordinator.pushApproved(runId, approval("GITHUB_PUSH", status), pushRequest()),
      ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED", retryable: false });
      expect(provider.pushSideEffects).toHaveLength(0);
    },
  );

  it("performs each approved push and pull request side effect exactly once", async () => {
    const provider = new FakeGitHubProvider();
    const store = new MemoryGitHubPublicationStore([publication()]);
    const coordinator = new GitHubPublicationCoordinator(provider, store);

    const firstPush = await coordinator.pushApproved(runId, approval("GITHUB_PUSH"), pushRequest());
    const duplicatePush = await coordinator.pushApproved(
      runId,
      approval("GITHUB_PUSH"),
      pushRequest(),
    );
    expect(firstPush.idempotent).toBe(false);
    expect(duplicatePush).toMatchObject({ commitSha: firstPush.commitSha, idempotent: true });
    expect(provider.pushSideEffects).toHaveLength(1);

    await expect(
      coordinator.createPullRequestApproved(
        runId,
        approval("GITHUB_PULL_REQUEST", "REJECTED"),
        pullRequestRequest(),
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(provider.pullRequestSideEffects).toHaveLength(0);

    const firstPullRequest = await coordinator.createPullRequestApproved(
      runId,
      approval("GITHUB_PULL_REQUEST"),
      pullRequestRequest(),
    );
    const duplicatePullRequest = await coordinator.createPullRequestApproved(
      runId,
      approval("GITHUB_PULL_REQUEST"),
      pullRequestRequest(),
    );
    expect(firstPullRequest.idempotent).toBe(false);
    expect(duplicatePullRequest).toMatchObject({
      number: firstPullRequest.number,
      idempotent: true,
    });
    expect(provider.pullRequestSideEffects).toHaveLength(1);
  });

  it("surfaces retryable provider failures without recording a side effect", async () => {
    const provider = new FakeGitHubProvider({ failPushes: 1 });
    const store = new MemoryGitHubPublicationStore([publication()]);
    const coordinator = new GitHubPublicationCoordinator(provider, store, {
      reconciliationAttempts: 1,
    });

    await expect(
      coordinator.pushApproved(runId, approval("GITHUB_PUSH"), pushRequest()),
    ).rejects.toMatchObject({ code: "NETWORK_FAILED", retryable: true });
    expect((await store.findByRunId(runId))?.commitSha).toBeUndefined();
    expect(provider.pushSideEffects).toHaveLength(0);

    await coordinator.pushApproved(runId, approval("GITHUB_PUSH"), pushRequest());
    expect(provider.pushSideEffects).toHaveLength(1);
  });

  it("reconciles a remote push after persistence fails without duplicating the side effect", async () => {
    const provider = new FakeGitHubProvider();
    const durable = new MemoryGitHubPublicationStore([publication()]);
    let failRecord = true;
    const flakyStore: GitHubPublicationStore = {
      findByRunId: async (id) => await durable.findByRunId(id),
      recordPush: async (id, operationKey, result) => {
        if (failRecord) {
          failRecord = false;
          throw new Error("temporary database outage");
        }
        await durable.recordPush(id, operationKey, result);
      },
      recordPullRequest: async (id, operationKey, result) => {
        await durable.recordPullRequest(id, operationKey, result);
      },
    };
    const coordinator = new GitHubPublicationCoordinator(provider, flakyStore, {
      retryDelayMs: 0,
    });

    await expect(
      coordinator.pushApproved(runId, approval("GITHUB_PUSH"), pushRequest()),
    ).resolves.toMatchObject({ idempotent: true });
    expect(provider.pushCalls).toHaveLength(2);
    expect(provider.pushSideEffects).toHaveLength(1);
    expect((await durable.findByRunId(runId))?.commitSha).toBeDefined();
  });

  it("ignores user cancellation after a remote write starts and persists the result", async () => {
    const controller = new AbortController();
    const remote = new FakeGitHubProvider();
    const provider: GitHubProvider = {
      pushBranch: async (request, reconciliationSignal) => {
        const result = await remote.pushBranch(request, reconciliationSignal);
        controller.abort(new Error("user cancelled after GitHub accepted the ref"));
        expect(reconciliationSignal).not.toBe(controller.signal);
        expect(reconciliationSignal?.aborted).toBe(false);
        return result;
      },
      createPullRequest: async (request, reconciliationSignal) =>
        await remote.createPullRequest(request, reconciliationSignal),
    };
    const store = new MemoryGitHubPublicationStore([publication()]);
    const coordinator = new GitHubPublicationCoordinator(provider, store, { retryDelayMs: 0 });

    await expect(
      coordinator.pushApproved(runId, approval("GITHUB_PUSH"), pushRequest(), controller.signal),
    ).resolves.toMatchObject({ branchName, idempotent: false });
    expect(controller.signal.aborted).toBe(true);
    expect(remote.pushSideEffects).toHaveLength(1);
    expect(await store.findByRunId(runId)).toMatchObject({
      commitSha: remote.pushSideEffects[0]?.commitSha,
    });
  });

  it("reconciles ambiguous push and PR responses by stable marker without duplicate writes", async () => {
    const remote = new FakeGitHubProvider();
    let losePushResponse = true;
    let losePullRequestResponse = true;
    const provider: GitHubProvider = {
      pushBranch: async (request, signal) => {
        const result = await remote.pushBranch(request, signal);
        if (losePushResponse) {
          losePushResponse = false;
          throw new GitHubProviderError(
            "NETWORK_FAILED",
            "Connection closed after the branch ref was accepted.",
            true,
          );
        }
        return result;
      },
      createPullRequest: async (request, signal) => {
        const result = await remote.createPullRequest(request, signal);
        if (losePullRequestResponse) {
          losePullRequestResponse = false;
          throw new GitHubProviderError(
            "NETWORK_FAILED",
            "Connection closed after the pull request was accepted.",
            true,
          );
        }
        return result;
      },
    };
    const store = new MemoryGitHubPublicationStore([publication()]);
    const coordinator = new GitHubPublicationCoordinator(provider, store, { retryDelayMs: 0 });

    const pushed = await coordinator.pushApproved(runId, approval("GITHUB_PUSH"), pushRequest());
    const pullRequest = await coordinator.createPullRequestApproved(
      runId,
      approval("GITHUB_PULL_REQUEST"),
      pullRequestRequest(),
    );

    expect(pushed.idempotent).toBe(true);
    expect(pullRequest.idempotent).toBe(true);
    expect(remote.pushCalls).toHaveLength(2);
    expect(remote.pushSideEffects).toHaveLength(1);
    expect(remote.pullRequestCalls).toHaveLength(2);
    expect(remote.pullRequestSideEffects).toHaveLength(1);
    expect(await store.findByRunId(runId)).toMatchObject({
      commitSha: pushed.commitSha,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
    });
  });

  it("does not write push or PR side effects when cancellation happened before start", async () => {
    const remote = new FakeGitHubProvider();
    const pushStore = new MemoryGitHubPublicationStore([publication()]);
    const pushCoordinator = new GitHubPublicationCoordinator(remote, pushStore);
    const pushCancellation = new AbortController();
    pushCancellation.abort(new Error("cancelled before push"));

    await expect(
      pushCoordinator.pushApproved(
        runId,
        approval("GITHUB_PUSH"),
        pushRequest(),
        pushCancellation.signal,
      ),
    ).rejects.toThrow(/cancelled before push/u);

    const pullRequestStore = new MemoryGitHubPublicationStore([
      { ...publication(), commitSha: "b".repeat(40) },
    ]);
    const pullRequestCoordinator = new GitHubPublicationCoordinator(remote, pullRequestStore);
    const pullRequestCancellation = new AbortController();
    pullRequestCancellation.abort(new Error("cancelled before pull request"));
    await expect(
      pullRequestCoordinator.createPullRequestApproved(
        runId,
        approval("GITHUB_PULL_REQUEST"),
        pullRequestRequest(),
        pullRequestCancellation.signal,
      ),
    ).rejects.toThrow(/cancelled before pull request/u);

    expect(remote.pushCalls).toHaveLength(0);
    expect(remote.pushSideEffects).toHaveLength(0);
    expect(remote.pullRequestCalls).toHaveLength(0);
    expect(remote.pullRequestSideEffects).toHaveLength(0);
  });

  it("bounds reconciliation even when a provider ignores its abort signal", async () => {
    const provider: GitHubProvider = {
      pushBranch: async () => await new Promise<never>(() => undefined),
      createPullRequest: async () => await new Promise<never>(() => undefined),
    };
    const coordinator = new GitHubPublicationCoordinator(
      provider,
      new MemoryGitHubPublicationStore([publication()]),
      { reconciliationTimeoutMs: 10, retryDelayMs: 0 },
    );

    await expect(
      coordinator.pushApproved(runId, approval("GITHUB_PUSH"), pushRequest()),
    ).rejects.toMatchObject({
      code: "NETWORK_FAILED",
      message: "GitHub reconciliation timed out.",
      retryable: false,
    });
  });

  it("keeps platform credentials outside operation inputs and provider errors", async () => {
    const secret = "github_pat_this_is_a_test_secret_1234567890";
    const credentials = new EnvironmentGitHubCredentialSource({ GITHUB_TOKEN: secret });
    expect(await credentials.getToken()).toBe(secret);
    expect(JSON.stringify(pushRequest())).not.toContain(secret);

    const error = new GitHubProviderError("PROVIDER_FAILED", "safe structured failure", true, 500);
    expect(JSON.stringify(error.toJSON())).not.toContain(secret);
  });
});
