import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { DatabaseAdapter, RepositoryRecord } from "@devflow/database";
import { FakeGitHubProvider } from "@devflow/github";
import { captureLocalRepositorySnapshot } from "@devflow/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskBaseCommitResolver } from "../src/modules/tasks/task-base-commit-resolver.js";
import { TasksController } from "../src/modules/tasks/tasks.controller.js";

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

describe("Task base commit resolution", () => {
  it("resolves the current LOCAL main and non-main checkout to a full immutable SHA", async () => {
    const repositoryPath = await createRepository();
    const resolver = new TaskBaseCommitResolver(new FakeGitHubProvider());

    const main = await resolver.resolve(repository(repositoryPath));
    expect(main).toEqual({
      baseRef: "main",
      baseCommitSha: await gitOutput(repositoryPath, "rev-parse", "HEAD"),
    });
    expect(main.baseCommitSha).toMatch(/^[0-9a-f]{40}$/u);

    await git(repositoryPath, "switch", "--create", "feature/local-base");
    await writeFile(path.join(repositoryPath, "feature.txt"), "feature\n", "utf8");
    await git(repositoryPath, "add", "feature.txt");
    await commit(repositoryPath, "feature");

    const feature = await resolver.resolve(repository(repositoryPath));
    expect(feature.baseRef).toBe("feature/local-base");
    expect(feature.baseCommitSha).toBe(await gitOutput(repositoryPath, "rev-parse", "HEAD"));
  });

  it("resolves an explicit LOCAL ref without changing the current checkout", async () => {
    const repositoryPath = await createRepository();
    const mainSha = await gitOutput(repositoryPath, "rev-parse", "main");
    await git(repositoryPath, "switch", "--create", "feature/current");
    const resolver = new TaskBaseCommitResolver(new FakeGitHubProvider());

    await expect(resolver.resolve(repository(repositoryPath), "main")).resolves.toEqual({
      baseRef: "main",
      baseCommitSha: mainSha,
    });
    expect(await gitOutput(repositoryPath, "branch", "--show-current")).toBe("feature/current");
  });

  it("fails immediately for an invalid ref or unresolved LOCAL repository", async () => {
    const repositoryPath = await createRepository();
    const resolver = new TaskBaseCommitResolver(new FakeGitHubProvider());

    await expect(resolver.resolve(repository(repositoryPath), "missing/ref")).rejects.toMatchObject(
      {
        code: "VALIDATION_ERROR",
      },
    );
    await expect(
      resolver.resolve(repository(path.join(repositoryPath, "does-not-exist"))),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses the fixed Task SHA when the LOCAL branch advances later", async () => {
    const repositoryPath = await createRepository();
    const resolver = new TaskBaseCommitResolver(new FakeGitHubProvider());
    const fixed = await resolver.resolve(repository(repositoryPath), "main");

    await writeFile(path.join(repositoryPath, "source.txt"), "second\n", "utf8");
    await git(repositoryPath, "add", "source.txt");
    await commit(repositoryPath, "advance main");
    expect(await gitOutput(repositoryPath, "rev-parse", "HEAD")).not.toBe(fixed.baseCommitSha);

    const snapshot = await captureLocalRepositorySnapshot({
      sourceUri: repositoryPath,
      workspaceRoot: repositoryPath,
      baseRef: fixed.baseRef,
      baseCommit: fixed.baseCommitSha,
    });
    expect(snapshot.sourceHead).toBe(fixed.baseCommitSha);
    expect(snapshot.requestedBaseCommit).toBe(fixed.baseCommitSha);
  });

  it("persists only the platform-resolved SHA and rejects a client-supplied commit", async () => {
    const repositoryRecord = repository("C:/fixture");
    const create = vi.fn(async (input) => ({ id: "task-1", status: "OPEN", ...input }));
    const database = {
      repositories: { findById: vi.fn(async () => repositoryRecord) },
      tasks: { create },
    } as unknown as DatabaseAdapter;
    const resolve = vi.fn(async () => ({ baseRef: "main", baseCommitSha: "a".repeat(40) }));
    const controller = new TasksController(database, {
      resolve,
    } as unknown as TaskBaseCommitResolver);

    await expect(
      controller.create({
        repositoryId: repositoryRecord.id,
        title: "Pinned task",
        description: "Resolve at creation.",
      }),
    ).resolves.toMatchObject({ baseRef: "main", baseCommitSha: "a".repeat(40) });
    expect(create).toHaveBeenCalledWith({
      repositoryId: repositoryRecord.id,
      title: "Pinned task",
      description: "Resolve at creation.",
      baseRef: "main",
      baseCommitSha: "a".repeat(40),
    });

    await expect(
      controller.create({
        repositoryId: repositoryRecord.id,
        title: "Client SHA",
        description: "Must be rejected.",
        baseCommitSha: "b".repeat(40),
      }),
    ).rejects.toBeDefined();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("maps GitHub default and explicit refs without exposing credentials", async () => {
    const resolver = new TaskBaseCommitResolver(
      new FakeGitHubProvider({ defaultBranch: "trunk", baseCommitSha: "c".repeat(40) }),
    );
    const remote = repository("https://github.com/openai/devflow.git", "GIT");

    await expect(resolver.resolve(remote)).resolves.toEqual({
      baseRef: "trunk",
      baseCommitSha: "c".repeat(40),
    });
    await expect(resolver.resolve(remote, "release/v2")).resolves.toEqual({
      baseRef: "release/v2",
      baseCommitSha: "c".repeat(40),
    });
  });
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devflow-task-base-"));
  temporaryDirectories.push(directory);
  await git(directory, "init", "--initial-branch=main");
  await writeFile(path.join(directory, "source.txt"), "first\n", "utf8");
  await git(directory, "add", "--all");
  await commit(directory, "initial");
  return directory;
}

async function commit(directory: string, message: string): Promise<void> {
  await git(
    directory,
    "-c",
    "user.name=DevFlow Test",
    "-c",
    "user.email=test@devflow.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    message,
  );
}

async function git(directory: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["--no-optional-locks", "-C", directory, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
}

async function gitOutput(directory: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--no-optional-locks", "-C", directory, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim().toLowerCase();
}

function repository(sourceUri: string, sourceKind: "LOCAL" | "GIT" = "LOCAL"): RepositoryRecord {
  const now = new Date().toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000010",
    name: "fixture",
    sourceKind,
    sourceUri,
    createdAt: now,
    updatedAt: now,
  };
}
