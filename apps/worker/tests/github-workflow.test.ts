import { randomUUID } from "node:crypto";

import type {
  ApprovalRecord,
  ArtifactRecord,
  DatabaseAdapter,
  RunExecutionRecord,
} from "@devflow/database";
import {
  FakeGitHubProvider,
  GitHubProviderError,
  MemoryGitHubPublicationStore,
  branchNameForRun,
  operationKeyForRun,
  type GitHubProvider,
} from "@devflow/github";
import type { NewAgentEvent } from "@devflow/shared";
import { describe, expect, it, vi } from "vitest";

import { loadWorkerEnvironment } from "../src/config/env.js";
import { GitHubDeliveryExecutor, prepareGitHubPushApproval } from "../src/runs/github-delivery.js";

describe("GitHubDeliveryExecutor publication stages", () => {
  it("resumes approved push and PR stages idempotently", async () => {
    const run = githubRun("PUSH");
    const artifact = changeSetArtifact(run.id);
    const store = new MemoryGitHubPublicationStore([
      {
        runId: run.id,
        repository: { owner: "devflow", name: "fixture" },
        baseCommit: "a".repeat(40),
        baseBranch: "main",
        branchName: branchNameForRun(run.id),
        pushOperationKey: operationKeyForRun(run.id, "push"),
        changesArtifactId: artifact.id,
      },
    ]);
    const approvals: ApprovalRecord[] = [approved(run.id, "GITHUB_PUSH")];
    const events: NewAgentEvent[] = [];
    const database = fakeDatabase(store, approvals, artifact, events);
    const provider = new FakeGitHubProvider();
    const executor = new GitHubDeliveryExecutor(database, environment(), () => provider);

    const firstPush = await executor.execute(run, new AbortController().signal);
    const duplicatePush = await executor.execute(run, new AbortController().signal);
    expect(firstPush).toMatchObject({
      status: "WAITING_APPROVAL",
      approval: { kind: "GITHUB_PULL_REQUEST" },
    });
    expect(duplicatePush).toMatchObject({ status: "WAITING_APPROVAL" });
    expect(provider.pushSideEffects).toHaveLength(1);

    approvals.push(approved(run.id, "GITHUB_PULL_REQUEST"));
    const completed = await executor.execute(
      { ...run, currentStage: "CREATE_PR" },
      new AbortController().signal,
    );
    const duplicateCompleted = await executor.execute(
      { ...run, currentStage: "CREATE_PR" },
      new AbortController().signal,
    );
    expect(completed).toMatchObject({ status: "SUCCEEDED" });
    expect(duplicateCompleted).toMatchObject({ status: "SUCCEEDED" });
    expect(provider.pullRequestSideEffects).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(["PUSH_COMPLETED", "PR_CREATED"]);
  });

  it("publishes exactly the change set that any execution mode prepared for approval", async () => {
    const run = githubRun("PUSH");
    const prepared = JSON.parse(changeSetArtifact(run.id).content!) as {
      changes: Parameters<typeof prepareGitHubPushApproval>[2];
      metrics: Parameters<typeof prepareGitHubPushApproval>[4];
    };
    let artifact: ArtifactRecord | undefined;
    const pause = await prepareGitHubPushApproval(
      {
        artifacts: {
          create: async (input: Omit<ArtifactRecord, "id" | "createdAt">) =>
            (artifact = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }),
        },
      } as unknown as DatabaseAdapter,
      run,
      prepared.changes,
      "Autonomous agent fixed the fixture.",
      prepared.metrics,
    );
    expect(pause.approval.kind).toBe("GITHUB_PUSH");
    const store = new MemoryGitHubPublicationStore([
      { runId: run.id, ...pause.approval.publication! },
    ]);
    const approvals = [approved(run.id, "GITHUB_PUSH")];
    const provider = new FakeGitHubProvider();
    const executor = new GitHubDeliveryExecutor(
      fakeDatabase(store, approvals, artifact!, []),
      environment(),
      () => provider,
    );
    const signal = new AbortController().signal;
    await executor.execute(run, signal);
    approvals.push(approved(run.id, "GITHUB_PULL_REQUEST"));
    const done = await executor.execute({ ...run, currentStage: "CREATE_PR" }, signal);
    expect(done).toMatchObject({ status: "SUCCEEDED", metrics: prepared.metrics });
    expect(provider.pushSideEffects).toHaveLength(1);
    expect(provider.pullRequestSideEffects).toHaveLength(1);
    expect(provider.pushCalls[0]?.changes).toEqual(prepared.changes);
  });

  it("persists only a redacted structured provider failure", async () => {
    const run = githubRun("PUSH");
    const artifact = changeSetArtifact(run.id);
    const store = new MemoryGitHubPublicationStore([
      {
        runId: run.id,
        repository: { owner: "devflow", name: "fixture" },
        baseCommit: "a".repeat(40),
        baseBranch: "main",
        branchName: branchNameForRun(run.id),
        pushOperationKey: operationKeyForRun(run.id, "push"),
        changesArtifactId: artifact.id,
      },
    ]);
    const events: NewAgentEvent[] = [];
    const provider = new FakeGitHubProvider({ failPushes: 3 });
    const executor = new GitHubDeliveryExecutor(
      fakeDatabase(store, [approved(run.id, "GITHUB_PUSH")], artifact, events),
      environment(),
      () => provider,
    );

    await expect(executor.execute(run, new AbortController().signal)).rejects.toMatchObject({
      code: "GITHUB_FAILED",
      retryable: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "GITHUB_OPERATION_FAILED", level: "ERROR" });
    expect(JSON.stringify(events)).not.toMatch(/token|credential|secret/iu);
    expect(provider.pushSideEffects).toHaveLength(0);
  });

  it("reconciles a lost remote response and persists one completion event", async () => {
    const run = githubRun("PUSH");
    const artifact = changeSetArtifact(run.id);
    const store = new MemoryGitHubPublicationStore([
      {
        runId: run.id,
        repository: { owner: "devflow", name: "fixture" },
        baseCommit: "a".repeat(40),
        baseBranch: "main",
        branchName: branchNameForRun(run.id),
        pushOperationKey: operationKeyForRun(run.id, "push"),
        changesArtifactId: artifact.id,
      },
    ]);
    const remote = new FakeGitHubProvider();
    let responseLost = true;
    const provider: GitHubProvider = {
      pushBranch: async (request, signal) => {
        const result = await remote.pushBranch(request, signal);
        if (responseLost) {
          responseLost = false;
          throw new GitHubProviderError(
            "NETWORK_FAILED",
            "Connection closed after GitHub accepted the ref.",
            true,
          );
        }
        return result;
      },
      createPullRequest: async (request, signal) => await remote.createPullRequest(request, signal),
    };
    const events: NewAgentEvent[] = [];
    const executor = new GitHubDeliveryExecutor(
      fakeDatabase(store, [approved(run.id, "GITHUB_PUSH")], artifact, events),
      environment(),
      () => provider,
    );

    await expect(executor.execute(run, new AbortController().signal)).resolves.toMatchObject({
      status: "WAITING_APPROVAL",
    });
    expect(remote.pushCalls).toHaveLength(2);
    expect(remote.pushSideEffects).toHaveLength(1);
    expect(await store.findByRunId(run.id)).toMatchObject({
      commitSha: remote.pushSideEffects[0]?.commitSha,
    });
    expect(events.map(({ type }) => type)).toEqual(["PUSH_COMPLETED"]);
  });
});

function githubRun(stage: "PUSH" | "CREATE_PR"): RunExecutionRecord {
  const now = new Date().toISOString();
  const id = randomUUID();
  const taskId = randomUUID();
  const repositoryId = randomUUID();
  return {
    id,
    taskId,
    status: "RUNNING",
    currentStage: stage,
    maxSteps: 10,
    maxTestRetries: 1,
    maxReviewRetries: 1,
    dispatchRevision: stage === "PUSH" ? 2 : 3,
    retryCount: 0,
    cancellationRequested: false,
    createdAt: now,
    updatedAt: now,
    task: {
      id: taskId,
      repositoryId,
      title: "Fix fixture",
      description: "Repair the fixture.",
      status: "OPEN",
      baseRef: "main",
      baseCommitSha: "a".repeat(40),
      createdAt: now,
      updatedAt: now,
    },
    repository: {
      id: repositoryId,
      name: "fixture",
      sourceKind: "GIT",
      sourceUri: "https://github.com/devflow/fixture.git",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    },
  };
}

function changeSetArtifact(runId: string): ArtifactRecord {
  return {
    id: randomUUID(),
    runId,
    kind: "GITHUB_CHANGESET",
    name: "github-changeset.json",
    mimeType: "application/json",
    content: JSON.stringify({
      version: 1,
      changes: [
        {
          kind: "UPSERT",
          path: "src/fix.ts",
          contentBase64: Buffer.from("fixed\n").toString("base64"),
          mode: "100644",
        },
      ],
      summary: "Implementation and review completed.",
      metrics: {
        durationMs: 10,
        steps: 2,
        modelCalls: 2,
        toolCalls: 3,
        retries: 0,
        modelLatencyMs: 4,
        toolLatencyMs: 6,
        tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      pullRequest: { title: "Fix fixture", body: "Verified change." },
    }),
    createdAt: new Date().toISOString(),
  };
}

function approved(runId: string, kind: ApprovalRecord["kind"]): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    runId,
    kind,
    status: "APPROVED",
    request: {},
    requestedAt: now,
    resolvedAt: now,
    updatedAt: now,
  };
}

function fakeDatabase(
  store: MemoryGitHubPublicationStore,
  approvals: ApprovalRecord[],
  artifact: ArtifactRecord,
  events: NewAgentEvent[],
): DatabaseAdapter {
  const append = async (event: NewAgentEvent) => {
    events.push(event);
    return {
      schemaVersion: 1 as const,
      eventId: randomUUID(),
      sequence: events.length,
      level: event.level ?? ("INFO" as const),
      ...event,
    };
  };
  return {
    githubPublications: {
      findByRunId: async (runId) => await store.findByRunId(runId),
      recordPush: async (runId, operationKey, result) => {
        const before = await store.findByRunId(runId);
        await store.recordPush(runId, operationKey, result);
        if (before?.commitSha === undefined) {
          await append({
            runId,
            type: "PUSH_COMPLETED",
            occurredAt: new Date().toISOString(),
            payload: { commitSha: result.commitSha },
          });
        }
      },
      recordPullRequest: async (runId, operationKey, result) => {
        const before = await store.findByRunId(runId);
        await store.recordPullRequest(runId, operationKey, result);
        if (before?.pullRequestNumber === undefined) {
          await append({
            runId,
            type: "PR_CREATED",
            occurredAt: new Date().toISOString(),
            payload: { number: result.number },
          });
        }
      },
    },
    approvals: { list: vi.fn(async () => approvals) },
    artifacts: { list: vi.fn(async () => [artifact]) },
    events: {
      append: vi.fn(append),
    },
  } as unknown as DatabaseAdapter;
}

function environment() {
  return loadWorkerEnvironment({
    DATABASE_URL: "postgresql://devflow:devflow@localhost:5432/devflow",
    DEVFLOW_GITHUB_WRITE_ENABLED: "false",
  });
}
