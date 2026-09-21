import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureLocalRepositorySnapshot,
  captureLocalRepositoryCommitSnapshot,
  decodeLocalRepositorySnapshot,
  DockerSandboxManager,
  encodeLocalRepositorySnapshot,
  type DockerCommandOptions,
  type DockerCommandResult,
  type DockerCommandRunner,
  type LocalRepositorySnapshot,
  type SandboxCreateOptions,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

class RecordingDockerRunner implements DockerCommandRunner {
  readonly calls: readonly string[][] = [];

  constructor(
    private readonly failOperation?: string,
    private readonly failWhen?: (args: readonly string[]) => boolean,
  ) {}

  async run(
    args: readonly string[],
    _options?: DockerCommandOptions,
  ): Promise<DockerCommandResult> {
    (this.calls as string[][]).push([...args]);
    const failed = args[0] === this.failOperation || this.failWhen?.(args) === true;
    return {
      exitCode: failed ? 1 : 0,
      stdout: failed ? "" : "ok\n",
      stderr: failed ? "simulated failure" : "",
      durationMs: 1,
      outputTruncated: false,
    };
  }
}

function createOptions(runId: string): SandboxCreateOptions {
  return {
    runId,
    repository: { sourceUri: pathToFileURL(process.cwd()).href, snapshot: emptySnapshot() },
    limits: {
      cpuCount: 1,
      memoryMb: 512,
      pids: 64,
      timeoutMs: 1_000,
      networkEnabled: false,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("DockerSandboxManager", () => {
  it("creates, uses and removes a container without a host execution fallback", async () => {
    const runner = new RecordingDockerRunner();
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });
    const session = await manager.create(createOptions(randomUUID()));

    await session.exec({ program: "node", args: ["--version"] });
    await session.dispose();

    expect(runner.calls.map((args) => args[0])).toEqual([
      "create",
      "start",
      "exec",
      "exec",
      "exec",
      "exec",
      "exec",
      "rm",
    ]);
    const command = runner.calls[6] ?? [];
    expect(command).toContain("/workspace");
    expect(command).toContain("node");
    expect(command).toContain("--version");
    expect(runner.calls[0]).toEqual(
      expect.arrayContaining([
        "--cpus",
        "1",
        "--memory",
        "512m",
        "--memory-swap",
        "512m",
        "--pids-limit",
        "64",
        "--network",
        "none",
        "--security-opt",
        "no-new-privileges",
      ]),
    );
  });

  it("removes a partially-created container when startup fails", async () => {
    const runner = new RecordingDockerRunner("start");
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });

    await expect(manager.create(createOptions(randomUUID()))).rejects.toMatchObject({
      code: "SANDBOX_FAILED",
    });
    expect(runner.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("attempts cleanup when create has an ambiguous client-side failure", async () => {
    class AmbiguousCreateRunner extends RecordingDockerRunner {
      override async run(
        args: readonly string[],
        options?: DockerCommandOptions,
      ): Promise<DockerCommandResult> {
        if (args[0] === "create") {
          await super.run(args, options);
          throw new Error("connection closed after daemon accepted create");
        }
        return await super.run(args, options);
      }
    }
    const runner = new AmbiguousCreateRunner();
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });

    await expect(manager.create(createOptions(randomUUID()))).rejects.toMatchObject({
      code: "SANDBOX_FAILED",
    });
    expect(runner.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("removes the container when restoring a LOCAL snapshot fails", async () => {
    const runner = new RecordingDockerRunner(
      undefined,
      (args) => args[0] === "exec" && args.includes("node"),
    );
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });

    await expect(manager.create(createOptions(randomUUID()))).rejects.toMatchObject({
      code: "SANDBOX_FAILED",
    });
    expect(runner.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("rejects path traversal before invoking Docker", async () => {
    const runner = new RecordingDockerRunner();
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });
    const session = await manager.create(createOptions(randomUUID()));
    const callsBeforeRead = runner.calls.length;

    await expect(session.readFile({ path: "../outside.txt" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(runner.calls).toHaveLength(callsBeforeRead);
    await session.dispose();
  });

  it("requires network access for remote clones and emits structured clone arguments", async () => {
    const deniedRunner = new RecordingDockerRunner();
    const deniedManager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: deniedRunner,
    });
    const denied = createOptions(randomUUID());
    denied.repository = { sourceUri: "https://example.invalid/repository.git" };
    await expect(deniedManager.create(denied)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(deniedRunner.calls).toHaveLength(0);

    const runner = new RecordingDockerRunner();
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });
    const allowed = createOptions(randomUUID());
    allowed.repository = {
      sourceUri: "https://example.invalid/repository.git",
      baseRef: "main",
    };
    allowed.limits.networkEnabled = true;
    const session = await manager.create(allowed);

    expect(runner.calls[2]).toEqual(
      expect.arrayContaining([
        "git",
        "clone",
        "--branch",
        "main",
        "--single-branch",
        "--",
        "https://example.invalid/repository.git",
        "/workspace",
      ]),
    );
    await session.dispose();
  });

  it("rejects embedded clone credentials before invoking Docker", async () => {
    const runner = new RecordingDockerRunner();
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });
    const options = createOptions(randomUUID());
    options.repository = {
      sourceUri: "https://github_pat_secret@github.com/devflow/fixture.git",
    };
    options.limits.networkEnabled = true;

    await expect(manager.create(options)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runner.calls).toHaveLength(0);
  });

  it("restores a dirty snapshot without invoking an unsafe checkout", async () => {
    const runner = new RecordingDockerRunner(undefined, (args) =>
      args.some((value) => value === "checkout"),
    );
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });
    const options = createOptions(randomUUID());
    options.repository = {
      sourceUri: pathToFileURL(process.cwd()).href,
      baseRef: "main",
      baseCommit: "1111111",
      snapshot: {
        version: 1,
        sourceHead: "1111111111111111111111111111111111111111",
        requestedBaseRef: "main",
        requestedBaseCommit: "1111111",
        totalBytes: 5,
        files: [
          {
            kind: "FILE",
            path: "dirty.txt",
            mode: 0o644,
            sizeBytes: 5,
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            contentBase64: Buffer.from("hello").toString("base64"),
          },
        ],
      },
    };

    const session = await manager.create(options);
    expect(runner.calls.flat()).not.toContain("checkout");
    await session.dispose();
  });

  it("validates resource and environment limits before container creation", async () => {
    const runner = new RecordingDockerRunner();
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });
    const invalid = createOptions(randomUUID());
    invalid.limits.memoryMb = 5;

    await expect(manager.create(invalid)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runner.calls).toHaveLength(0);
  });
});

describe("LOCAL repository snapshots", () => {
  it("resolves a file URL beneath a Windows-compatible parent root with spaces and Unicode", async () => {
    const repository = await createGitRepository("本地 repository");
    const snapshot = await captureLocalRepositorySnapshot({
      sourceUri: pathToFileURL(repository).href,
      workspaceRoot: path.dirname(repository),
    });

    expect(snapshot.files.map((entry) => entry.path)).toContain("tracked.txt");
  });

  it("captures the fixed commit tree and ignores the current dirty working tree", async () => {
    const repository = await createGitRepository();
    const head = await git(repository, "rev-parse", "HEAD");
    await writeFile(path.join(repository, "tracked.txt"), "dirty after commit\n", "utf8");
    await writeFile(path.join(repository, "untracked.txt"), "not in benchmark\n", "utf8");

    const snapshot = await captureLocalRepositoryCommitSnapshot({
      sourceUri: repository,
      workspaceRoot: repository,
      baseCommit: head,
    });

    expect(snapshot.sourceHead).toBe(head);
    expect(snapshot.files.map((entry) => entry.path)).not.toContain("untracked.txt");
    const tracked = snapshot.files.find((entry) => entry.path === "tracked.txt");
    expect(tracked?.kind).toBe("FILE");
    if (tracked?.kind === "FILE") {
      expect(Buffer.from(tracked.contentBase64, "base64").toString("utf8")).toBe("clean\n");
    }
    expect(await readFile(path.join(repository, "tracked.txt"), "utf8")).toBe(
      "dirty after commit\n",
    );
  });

  it("captures a clean repository with fixed revision provenance and no Git metadata", async () => {
    const repository = await createGitRepository();
    const branch = await git(repository, "branch", "--show-current");
    const head = await git(repository, "rev-parse", "HEAD");
    const snapshot = await captureLocalRepositorySnapshot({
      sourceUri: pathToFileURL(repository).href,
      workspaceRoot: repository,
      baseRef: branch,
      baseCommit: head,
    });
    const decoded = decodeLocalRepositorySnapshot(encodeLocalRepositorySnapshot(snapshot));

    expect(decoded).toMatchObject({
      sourceHead: head,
      sourceBranch: branch,
      requestedBaseRef: branch,
      requestedBaseCommit: head,
    });
    expect(decoded.files.map((entry) => entry.path)).toEqual([
      ".gitignore",
      "deleted-later.txt",
      "tracked.txt",
    ]);
    expect(decoded.files.some((entry) => entry.path.includes(".git" + path.sep))).toBe(false);
  });

  it("captures the checked-out feature branch even when task baseRef still names main", async () => {
    const repository = await createGitRepository();
    const mainHead = await git(repository, "rev-parse", "main");
    await git(repository, "switch", "--create", "feature/local-run");
    await writeFile(path.join(repository, "tracked.txt"), "feature commit\n", "utf8");
    await git(repository, "add", "tracked.txt");
    await git(repository, "commit", "--no-gpg-sign", "-m", "feature commit");
    const featureHead = await git(repository, "rev-parse", "HEAD");
    await writeFile(path.join(repository, "untracked.txt"), "dirty feature context\n", "utf8");

    const snapshot = await captureLocalRepositorySnapshot({
      sourceUri: repository,
      workspaceRoot: repository,
      baseRef: "main",
    });

    expect(featureHead).not.toBe(mainHead);
    expect(snapshot).toMatchObject({
      sourceHead: featureHead,
      sourceBranch: "feature/local-run",
      requestedBaseRef: "main",
    });
    expect(snapshot.files.map((entry) => entry.path)).toContain("untracked.txt");
  });

  it("does not require a legacy LOCAL task baseRef to exist", async () => {
    const repository = await createGitRepository();
    await git(repository, "branch", "--move", "trunk");

    const snapshot = await captureLocalRepositorySnapshot({
      sourceUri: repository,
      workspaceRoot: repository,
      baseRef: "main",
    });

    expect(snapshot.sourceBranch).toBe("trunk");
    expect(snapshot.requestedBaseRef).toBe("main");
  });

  it("captures a detached LOCAL HEAD without requiring a branch checkout", async () => {
    const repository = await createGitRepository();
    await git(repository, "switch", "--create", "feature/detached-run");
    await writeFile(path.join(repository, "tracked.txt"), "detached commit\n", "utf8");
    await git(repository, "add", "tracked.txt");
    await git(repository, "commit", "--no-gpg-sign", "-m", "detached commit");
    const detachedHead = await git(repository, "rev-parse", "HEAD");
    await git(repository, "checkout", "--detach", detachedHead);

    const snapshot = await captureLocalRepositorySnapshot({
      sourceUri: repository,
      workspaceRoot: repository,
      baseRef: "main",
    });

    expect(snapshot.sourceHead).toBe(detachedHead);
    expect(snapshot.sourceBranch).toBeUndefined();
  });

  it("captures modified and untracked files, excludes ignored/deleted files, and leaves host unchanged", async () => {
    const repository = await createGitRepository();
    await writeFile(path.join(repository, "tracked.txt"), "dirty tracked\n", "utf8");
    await writeFile(path.join(repository, "untracked.txt"), "untracked\n", "utf8");
    await writeFile(path.join(repository, "ignored.secret"), "do not archive\n", "utf8");
    await unlink(path.join(repository, "deleted-later.txt"));
    const statusBefore = await git(repository, "status", "--porcelain=v1");
    const trackedBefore = await readFile(path.join(repository, "tracked.txt"), "utf8");

    const snapshot = await captureLocalRepositorySnapshot({
      sourceUri: repository,
      workspaceRoot: repository,
    });

    expect(snapshot.files.map((entry) => entry.path)).toEqual([
      ".gitignore",
      "tracked.txt",
      "untracked.txt",
    ]);
    expect(snapshot.files.map((entry) => entry.path)).not.toContain("ignored.secret");
    expect(snapshot.files.map((entry) => entry.path)).not.toContain("deleted-later.txt");
    expect(await readFile(path.join(repository, "tracked.txt"), "utf8")).toBe(trackedBefore);
    expect(await git(repository, "status", "--porcelain=v1")).toBe(statusBefore);
  });

  it("rejects a conflicting requested revision before Docker can be invoked", async () => {
    const repository = await createGitRepository();

    await expect(
      captureLocalRepositorySnapshot({
        sourceUri: repository,
        workspaceRoot: repository,
        baseCommit: "0000000",
      }),
    ).rejects.toMatchObject({ code: "SANDBOX_FAILED" });
  });
});

function emptySnapshot(): LocalRepositorySnapshot {
  return {
    version: 1,
    sourceHead: "0000000000000000000000000000000000000000",
    totalBytes: 0,
    files: [],
  };
}

async function createGitRepository(nestedDirectory?: string): Promise<string> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "devflow-local-snapshot-"));
  temporaryDirectories.push(temporaryRoot);
  const repository =
    nestedDirectory === undefined ? temporaryRoot : path.join(temporaryRoot, nestedDirectory);
  if (nestedDirectory !== undefined) await mkdir(repository);
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.name", "DevFlow Test");
  await git(repository, "config", "user.email", "test@devflow.invalid");
  await writeFile(path.join(repository, ".gitignore"), "*.secret\n", "utf8");
  await writeFile(path.join(repository, "tracked.txt"), "clean\n", "utf8");
  await writeFile(path.join(repository, "deleted-later.txt"), "present\n", "utf8");
  await mkdir(path.join(repository, "empty-directory"));
  await git(repository, "add", "--all");
  await git(repository, "commit", "--no-gpg-sign", "-m", "fixture");
  return repository;
}

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["--no-optional-locks", "-C", repository, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}
