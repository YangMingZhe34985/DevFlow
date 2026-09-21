import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { DatabaseAdapter, RepositoryRecord, RunRecord, TaskRecord } from "@devflow/database";
import type { RunQueuePort } from "@devflow/shared";
import { decodeLocalRepositorySnapshot } from "@devflow/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureInitialLocalSnapshot,
  RunsController,
} from "../src/modules/runs/runs.controller.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.DEVFLOW_LOCAL_REPOSITORY_ROOT;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe("Run creation LOCAL snapshot", () => {
  it("freezes the dirty working tree before queue dispatch", async () => {
    const repositoryPath = await createRepository();
    await writeFile(path.join(repositoryPath, "source.txt"), "dirty at create\n", "utf8");
    const repository = repositoryRecord(repositoryPath);
    const task = taskRecord(repository.id);
    const database = {
      tasks: { findById: vi.fn(async () => task) },
      repositories: { findById: vi.fn(async () => repository) },
    } as unknown as DatabaseAdapter;

    const artifact = await captureInitialLocalSnapshot(database, task.id);
    await writeFile(path.join(repositoryPath, "source.txt"), "changed after create\n", "utf8");

    expect(artifact?.name).toBe("local-repository-snapshot.v1.json.gz");
    const snapshot = decodeLocalRepositorySnapshot(artifact?.content ?? "");
    const source = snapshot.files.find((entry) => entry.path === "source.txt");
    expect(source?.kind).toBe("FILE");
    if (source?.kind === "FILE") {
      expect(Buffer.from(source.contentBase64, "base64").toString("utf8")).toBe(
        "dirty at create\n",
      );
    }
    expect(await readFile(path.join(repositoryPath, "source.txt"), "utf8")).toBe(
      "changed after create\n",
    );
  });

  it("accepts a LOCAL repository beneath an explicitly configured parent root", async () => {
    const repositoryPath = await createRepository();
    process.env.DEVFLOW_LOCAL_REPOSITORY_ROOT = path.dirname(repositoryPath);
    const repository = repositoryRecord(repositoryPath);
    const task = taskRecord(repository.id);
    const database = {
      tasks: { findById: vi.fn(async () => task) },
      repositories: { findById: vi.fn(async () => repository) },
    } as unknown as DatabaseAdapter;

    const artifact = await captureInitialLocalSnapshot(database, task.id);

    expect(artifact?.name).toBe("local-repository-snapshot.v1.json.gz");
    expect(decodeLocalRepositorySnapshot(artifact?.content ?? "").files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "source.txt" })]),
    );
  });

  it("captures the current LOCAL feature branch when a legacy task baseRef is main", async () => {
    const repositoryPath = await createRepository();
    await git(repositoryPath, "switch", "--create", "feature/api-run");
    await writeFile(path.join(repositoryPath, "source.txt"), "feature branch\n", "utf8");
    await git(repositoryPath, "add", "source.txt");
    await git(
      repositoryPath,
      "-c",
      "user.name=DevFlow Test",
      "-c",
      "user.email=test@devflow.invalid",
      "commit",
      "--no-gpg-sign",
      "-m",
      "feature",
    );
    const repository = repositoryRecord(repositoryPath);
    const task = { ...taskRecord(repository.id), baseRef: "main" };
    const database = {
      tasks: { findById: vi.fn(async () => task) },
      repositories: { findById: vi.fn(async () => repository) },
    } as unknown as DatabaseAdapter;

    const artifact = await captureInitialLocalSnapshot(database, task.id);
    const snapshot = decodeLocalRepositorySnapshot(artifact?.content ?? "");

    expect(snapshot.sourceBranch).toBe("feature/api-run");
    expect(snapshot.requestedBaseRef).toBe("main");
  });

  it("does not recapture the host repository for an idempotent replay", async () => {
    const taskId = "00000000-0000-4000-8000-000000000011";
    const run = runRecord(taskId);
    const create = vi.fn(async () => ({ run, created: false }));
    const findByIdempotencyKey = vi.fn(async () => run);
    const database = {
      runs: { create, findByIdempotencyKey },
      tasks: { findById: vi.fn(() => Promise.reject(new Error("must not recapture"))) },
      repositories: { findById: vi.fn(() => Promise.reject(new Error("must not recapture"))) },
    } as unknown as DatabaseAdapter;
    const queue = {
      enqueue: vi.fn(async () => undefined),
    } as unknown as RunQueuePort;
    const controller = new RunsController(database, queue, {} as never);

    await expect(
      controller.create({ taskId, idempotencyKey: "stable-idempotency-key" }),
    ).resolves.toMatchObject({ created: false, run: { id: run.id } });

    expect(findByIdempotencyKey).toHaveBeenCalledWith("stable-idempotency-key");
    expect(create).toHaveBeenCalledWith({ taskId, idempotencyKey: "stable-idempotency-key" });
    expect(database.tasks.findById).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devflow-api-snapshot-"));
  temporaryDirectories.push(directory);
  await git(directory, "init", "--initial-branch=main");
  await writeFile(path.join(directory, "source.txt"), "clean\n", "utf8");
  await git(directory, "add", "--all");
  await git(
    directory,
    "-c",
    "user.name=DevFlow Test",
    "-c",
    "user.email=test@devflow.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    "fixture",
  );
  return directory;
}

async function git(directory: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["--no-optional-locks", "-C", directory, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
}

function repositoryRecord(sourceUri: string): RepositoryRecord {
  const now = new Date().toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000010",
    name: "local-fixture",
    sourceKind: "LOCAL",
    sourceUri,
    createdAt: now,
    updatedAt: now,
  };
}

function taskRecord(repositoryId: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000011",
    repositoryId,
    title: "Snapshot",
    description: "Freeze the input.",
    status: "OPEN",
    createdAt: now,
    updatedAt: now,
  };
}

function runRecord(taskId: string): RunRecord {
  const now = new Date().toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000012",
    taskId,
    idempotencyKey: "stable-idempotency-key",
    status: "QUEUED",
    currentStage: "START",
    maxSteps: 25,
    maxTestRetries: 3,
    maxReviewRetries: 1,
    dispatchRevision: 0,
    retryCount: 0,
    cancellationRequested: false,
    createdAt: now,
    updatedAt: now,
  };
}
