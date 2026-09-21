import { randomUUID } from "node:crypto";

import { PrismaDatabaseAdapter } from "@devflow/database";
import { describe, expect, it } from "vitest";

const enabled = process.env.DEVFLOW_P10_INTEGRATION === "1";
const describeP10 = enabled ? describe : describe.skip;

describeP10("P10 GitHub approval persistence", () => {
  it("rejects credential material in GitHub approval comments and resolutions before persistence", async () => {
    await withDatabase(async (database) => {
      const run = await createClaimedRun(database, "credential-guard");
      const artifact = await changeSetArtifact(database, run.id);
      const paused = await database.runs.pauseForGitHubApproval(run.id, "worker:credential-guard", {
        kind: "GITHUB_PUSH",
        request: pushApprovalRequest(run.id),
        publication: publicationInput(run.id, artifact.id),
      });
      const secret = "github_pat_platform_owned_secret_12345678901234567890";

      await expect(
        database.approvals.resolve(paused.approval.id, {
          status: "APPROVED",
          comment: `copied credential: ${secret}`,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(
        database.approvals.resolve(paused.approval.id, {
          status: "APPROVED",
          resolution: { accessToken: secret },
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(
        database.approvals.resolveForWorkflow(paused.approval.id, {
          status: "APPROVED",
          comment: `copied credential: ${secret}`,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(
        database.approvals.resolveForWorkflow(paused.approval.id, {
          status: "APPROVED",
          resolution: { authorization: `Bearer ${secret}` },
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

      expect(await database.approvals.findById(paused.approval.id)).toMatchObject({
        status: "PENDING",
      });
      expect(await database.runs.findById(run.id)).toMatchObject({
        status: "WAITING_APPROVAL",
        currentStage: "WAITING_PUSH_APPROVAL",
      });
      const events = await database.events.list(run.id, { limit: 100 });
      expect(events.map(({ type }) => type)).toEqual(["PUSH_APPROVAL_REQUIRED"]);
      expect(
        JSON.stringify({ approval: await database.approvals.findById(paused.approval.id), events }),
      ).not.toContain(secret);
    });
  });

  it("rejects push with no metadata side effect and a structured terminal event", async () => {
    await withDatabase(async (database) => {
      const run = await createClaimedRun(database, "reject");
      const artifact = await changeSetArtifact(database, run.id);
      const paused = await database.runs.pauseForGitHubApproval(run.id, "worker:reject", {
        kind: "GITHUB_PUSH",
        request: pushApprovalRequest(run.id),
        publication: publicationInput(run.id, artifact.id),
      });

      const outcome = await database.approvals.resolveForWorkflow(paused.approval.id, {
        status: "REJECTED",
        comment: "Do not publish this change.",
      });

      expect(outcome.shouldEnqueue).toBe(false);
      expect(outcome.run).toMatchObject({ status: "CANCELLED", currentStage: "CANCELLED" });
      expect(await database.githubPublications.findByRunId(run.id)).toMatchObject({
        branchName: branchName(run.id),
      });
      expect((await database.githubPublications.findByRunId(run.id))?.commitSha).toBeUndefined();
      const events = await database.events.list(run.id, { limit: 100 });
      expect(events.map((event) => event.type)).toEqual([
        "PUSH_APPROVAL_REQUIRED",
        "PUSH_REJECTED",
        "RUN_CANCELLED",
      ]);
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    });
  });

  it("persists approved branch and PR metadata exactly once across duplicate delivery", async () => {
    await withDatabase(async (database) => {
      const run = await createClaimedRun(database, "approve");
      const artifact = await changeSetArtifact(database, run.id);
      const pushPause = await database.runs.pauseForGitHubApproval(run.id, "worker:approve", {
        kind: "GITHUB_PUSH",
        request: pushApprovalRequest(run.id),
        publication: publicationInput(run.id, artifact.id),
      });
      const pushApproval = await database.approvals.resolveForWorkflow(pushPause.approval.id, {
        status: "APPROVED",
      });
      expect(pushApproval).toMatchObject({ shouldEnqueue: true, run: { currentStage: "PUSH" } });

      const pushedRun = await database.runs.claim(run.id, "worker:push", 60_000, 1);
      expect(pushedRun).not.toBeNull();
      const pushResult = {
        branchName: branchName(run.id),
        commitSha: "b".repeat(40),
        remoteUrl: `https://github.test/devflow/fixture/tree/${encodeURIComponent(branchName(run.id))}`,
        idempotent: false,
      };
      await database.githubPublications.recordPush(run.id, pushOperation(run.id), pushResult);
      await database.githubPublications.recordPush(run.id, pushOperation(run.id), {
        ...pushResult,
        idempotent: true,
      });
      const prPause = await database.runs.pauseForGitHubApproval(run.id, "worker:push", {
        kind: "GITHUB_PULL_REQUEST",
        request: { operationKey: prOperation(run.id), branchName: branchName(run.id) },
      });
      const prApproval = await database.approvals.resolveForWorkflow(prPause.approval.id, {
        status: "APPROVED",
      });
      expect(prApproval).toMatchObject({
        shouldEnqueue: true,
        run: { currentStage: "CREATE_PR", dispatchRevision: 2 },
      });

      expect(await database.runs.claim(run.id, "worker:pr", 60_000, 2)).not.toBeNull();
      const prResult = {
        number: 42,
        url: "https://github.test/devflow/fixture/pull/42",
        state: "open" as const,
        idempotent: false,
      };
      await database.githubPublications.recordPullRequest(run.id, prOperation(run.id), prResult);
      await database.githubPublications.recordPullRequest(run.id, prOperation(run.id), {
        ...prResult,
        idempotent: true,
      });
      await database.runs.complete(run.id, "worker:pr", {
        runId: run.id,
        status: "SUCCEEDED",
        summary: "Published pull request #42.",
        metrics: emptyMetrics(),
      });

      const detail = await database.runs.findDetail(run.id);
      expect(detail?.githubPublication).toMatchObject({
        branchName: branchName(run.id),
        commitSha: "b".repeat(40),
        pullRequestOperationKey: prOperation(run.id),
        pullRequestNumber: 42,
        pullRequestUrl: prResult.url,
        pullRequestState: "open",
      });
      expect(detail?.approvals.map((approval) => [approval.kind, approval.status])).toEqual([
        ["GITHUB_PUSH", "APPROVED"],
        ["GITHUB_PULL_REQUEST", "APPROVED"],
      ]);
      expect(detail?.events.filter((event) => event.type === "PUSH_COMPLETED")).toHaveLength(1);
      expect(detail?.events.filter((event) => event.type === "PR_CREATED")).toHaveLength(1);
      expect(detail?.events.at(-1)?.type).toBe("RUN_COMPLETED");
      expect(detail?.events.map((event) => event.sequence)).toEqual(
        detail?.events.map((_, index) => index + 1),
      );
    });
  });
});

async function withDatabase(
  execute: (database: PrismaDatabaseAdapter) => Promise<void>,
): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined) throw new Error("TEST_DATABASE_URL is required.");
  const database = PrismaDatabaseAdapter.fromConnectionString(url);
  await database.connect();
  try {
    await execute(database);
  } finally {
    await database.disconnect();
  }
}

async function createClaimedRun(database: PrismaDatabaseAdapter, suffix: string) {
  const repository = await database.repositories.create({
    name: `github-fixture-${suffix}-${randomUUID()}`,
    sourceKind: "GIT",
    sourceUri: "https://github.com/devflow/fixture.git",
    defaultBranch: "main",
  });
  const task = await database.tasks.create({
    repositoryId: repository.id,
    title: "Fix fixture",
    description: "Repair the fixture.",
    baseRef: "main",
    baseCommitSha: "a".repeat(40),
  });
  const { run } = await database.runs.create({
    taskId: task.id,
    idempotencyKey: `p10-${suffix}-${randomUUID()}`,
  });
  const claimed = await database.runs.claim(run.id, `worker:${suffix}`, 60_000, 0);
  if (claimed === null) throw new Error("Could not claim fixture run.");
  return claimed;
}

async function changeSetArtifact(database: PrismaDatabaseAdapter, runId: string) {
  return await database.artifacts.create({
    runId,
    kind: "GITHUB_CHANGESET",
    name: "github-changeset.json",
    mimeType: "application/json",
    content: JSON.stringify({ changes: [] }),
  });
}

function publicationInput(runId: string, changesArtifactId: string) {
  return {
    repository: { owner: "devflow", name: "fixture" },
    baseCommit: "a".repeat(40),
    baseBranch: "main",
    branchName: branchName(runId),
    pushOperationKey: pushOperation(runId),
    changesArtifactId,
  };
}

function pushApprovalRequest(runId: string) {
  return { operationKey: pushOperation(runId), branchName: branchName(runId) };
}

function branchName(runId: string): string {
  return `devflow/run-${runId}`;
}

function pushOperation(runId: string): string {
  return `${runId}:push:0`;
}

function prOperation(runId: string): string {
  return `${runId}:pull-request:0`;
}

function emptyMetrics() {
  return {
    durationMs: 1,
    steps: 1,
    modelCalls: 1,
    toolCalls: 1,
    retries: 0,
    modelLatencyMs: 1,
    toolLatencyMs: 1,
    tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}
