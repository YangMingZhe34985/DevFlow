import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  ArtifactRecord,
  CreateArtifactInput,
  DatabaseAdapter,
  RunExecutionRecord,
} from "@devflow/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureLocalRunSnapshot,
  LOCAL_RUN_SNAPSHOT_ARTIFACT,
  requireLocalRunSnapshot,
} from "../src/runs/local-run-snapshot.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("LOCAL Run snapshot persistence", () => {
  it("persists the pre-approval working tree once and reuses it after the host changes", async () => {
    const repository = await createRepository();
    const run = executionRecord(repository);
    const records: ArtifactRecord[] = [];
    const create = vi.fn(async (input: CreateArtifactInput) => {
      const record: ArtifactRecord = {
        id: randomUUID(),
        runId: input.runId,
        kind: input.kind,
        name: input.name,
        ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
        ...(input.content === undefined ? {} : { content: input.content }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        createdAt: new Date().toISOString(),
      };
      records.push(record);
      return record;
    });
    const database = {
      artifacts: {
        create,
        list: vi.fn(async () => records),
      },
    } as unknown as DatabaseAdapter;
    const signal = new AbortController().signal;

    const captured = await ensureLocalRunSnapshot(database, run, signal);
    await writeFile(path.join(repository, "source.txt"), "changed during approval\n", "utf8");
    const reused = await ensureLocalRunSnapshot(database, run, signal);
    const required = await requireLocalRunSnapshot(database, run);

    expect(create).toHaveBeenCalledOnce();
    expect(records[0]).toMatchObject({ kind: "OTHER", name: LOCAL_RUN_SNAPSHOT_ARTIFACT });
    expect(reused).toEqual(captured);
    expect(required).toEqual(captured);
    const source = required?.files.find((entry) => entry.path === "source.txt");
    expect(source?.kind).toBe("FILE");
    if (source?.kind === "FILE") {
      expect(Buffer.from(source.contentBase64, "base64").toString("utf8")).toBe(
        "captured before approval\n",
      );
    }
  });
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(path.join(tmpdir(), "devflow-run-snapshot-"));
  temporaryDirectories.push(repository);
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.name", "DevFlow Test");
  await git(repository, "config", "user.email", "test@devflow.invalid");
  await writeFile(path.join(repository, "source.txt"), "captured before approval\n", "utf8");
  await git(repository, "add", "--all");
  await git(repository, "commit", "--no-gpg-sign", "-m", "fixture");
  return repository;
}

async function git(repository: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["--no-optional-locks", "-C", repository, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
}

function executionRecord(repositoryPath: string): RunExecutionRecord {
  const runId = randomUUID();
  const taskId = randomUUID();
  const repositoryId = randomUUID();
  const now = new Date().toISOString();
  return {
    id: runId,
    taskId,
    status: "RUNNING",
    currentStage: "START",
    maxSteps: 5,
    maxTestRetries: 1,
    maxReviewRetries: 1,
    dispatchRevision: 0,
    retryCount: 0,
    executionOwner: "worker:test",
    cancellationRequested: false,
    createdAt: now,
    updatedAt: now,
    task: {
      id: taskId,
      repositoryId,
      title: "Snapshot task",
      description: "Capture before approval.",
      status: "OPEN",
      createdAt: now,
      updatedAt: now,
    },
    repository: {
      id: repositoryId,
      name: "fixture",
      sourceKind: "LOCAL",
      sourceUri: repositoryPath,
      createdAt: now,
      updatedAt: now,
    },
  };
}
