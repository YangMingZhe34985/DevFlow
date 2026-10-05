import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type * as FileSystem from "node:fs";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";

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

/** Execute the actual read script against a temporary workspace without Docker. */
class ReadFileDockerRunner extends RecordingDockerRunner {
  constructor(private readonly workspace: string) {
    super();
  }

  override async run(args: readonly string[], options?: DockerCommandOptions) {
    const recorded = await super.run(args, options);
    const script = args.at(-3);
    if (
      args[0] !== "exec" ||
      args.at(-5) !== "node" ||
      args.at(-4) !== "-e" ||
      script === undefined ||
      !(args.at(-1) ?? "").startsWith("{")
    ) {
      return recorded;
    }
    const nodeRequire = createRequire(import.meta.url);
    const fileSystem = nodeRequire("node:fs") as typeof FileSystem;
    let stdout = "";
    runInNewContext(
      script,
      {
        Buffer,
        require: (specifier: string) =>
          specifier === "node:fs"
            ? {
                ...fileSystem,
                realpathSync: (target: string) =>
                  target === "/workspace"
                    ? fileSystem.realpathSync(this.workspace)
                    : fileSystem.realpathSync(target),
              }
            : nodeRequire(specifier),
        process: {
          argv: ["node", ...args.slice(-2)],
          stdout: {
            write: (value: string) => {
              stdout += value;
            },
          },
        },
      },
      { timeout: 1_000 },
    );
    const bytes = Buffer.from(stdout);
    const maxBytes = options?.maxOutputBytes ?? bytes.length;
    return {
      ...recorded,
      stdout: bytes.subarray(0, maxBytes).toString("utf8"),
      outputTruncated: bytes.length > maxBytes,
    };
  }
}

async function createFileReadSession(content: string | Buffer) {
  const workspace = await mkdtemp(path.join(tmpdir(), "devflow-read-file-"));
  temporaryDirectories.push(workspace);
  await writeFile(path.join(workspace, "source.txt"), content);
  const manager = new DockerSandboxManager({
    image: "test",
    workspaceRoot: process.cwd(),
    commandRunner: new ReadFileDockerRunner(workspace),
  });
  return await manager.create(createOptions(randomUUID()));
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
  it("returns complete raw file hashes and sizes independent of escaped CRLF snippet limits", async () => {
    const source = Buffer.from("\uFEFF" + 'line "\\\r\n'.repeat(12_000) + "tail");
    expect(source.length).toBeGreaterThan(64 * 1_024);
    const session = await createFileReadSession(source);
    try {
      const expectedHash = createHash("sha256").update(source).digest("hex");
      for (const maxBytes of [32, 64 * 1_024, source.length]) {
        const read = await session.readFile({ path: "source.txt", maxBytes });
        expect(read).toMatchObject({ fileSha256: expectedHash, sizeBytes: source.length });
        expect(Buffer.byteLength(read.content)).toBeLessThanOrEqual(maxBytes);
        expect(source.toString("utf8").startsWith(read.content)).toBe(true);
        expect(read.content).toContain("\r\n");
        expect(read.truncated).toBe(maxBytes < source.length);
        if (!read.truncated) expect(read.content).toBe(source.toString("utf8"));
      }
    } finally {
      await session.dispose();
    }
  });

  it.each<[number, string]>([
    [1, "A"],
    [4, "A"],
    [5, "A😀"],
    [7, "A😀"],
    [8, "A😀中"],
    [10, "A😀中\r\n"],
    [11, "A😀中\r\nZ"],
  ])("keeps UTF-8 characters whole at a %i-byte snippet limit", async (maxBytes, expected) => {
    const source = "A😀中\r\nZ";
    const session = await createFileReadSession(source);
    try {
      const read = await session.readFile({ path: "source.txt", maxBytes });
      expect(read).toMatchObject({
        content: expected,
        fileSha256: createHash("sha256").update(source).digest("hex"),
        sizeBytes: Buffer.byteLength(source),
        truncated: maxBytes < Buffer.byteLength(source),
      });
      expect(read.content).not.toContain("\uFFFD");
    } finally {
      await session.dispose();
    }
  });

  it("hashes raw bytes even when UTF-8 decoding changes the returned text", async () => {
    const source = Buffer.from([0xff, 0x0d, 0x0a, 0x61]);
    const session = await createFileReadSession(source);
    try {
      const read = await session.readFile({ path: "source.txt" });
      expect(read.fileSha256).toBe(createHash("sha256").update(source).digest("hex"));
      expect(read.fileSha256).not.toBe(createHash("sha256").update(read.content).digest("hex"));
      expect(read.sizeBytes).toBe(source.length);
    } finally {
      await session.dispose();
    }
  });

  it("drains a locally cancelled command without disposing the owner's session (retrieval fallback)", async () => {
    const local = new AbortController();
    const owner = new AbortController();
    class Runner extends RecordingDockerRunner {
      override async run(args: readonly string[], options?: DockerCommandOptions) {
        if (args.includes("--local-cancel")) {
          local.abort();
          // Docker client must not be detached by the nested retrieval deadline.
          expect(options?.signal?.aborted).toBe(false);
        }
        return super.run(args, options);
      }
    }
    const runner = new Runner();
    const manager = new DockerSandboxManager({
      image: "test",
      workspaceRoot: process.cwd(),
      commandRunner: runner,
    });
    const session = await manager.create(createOptions(randomUUID()), owner.signal);
    await expect(
      session.exec({ program: "node", args: ["--local-cancel"] }, local.signal),
    ).rejects.toMatchObject({ code: "SANDBOX_CANCELLED" });
    expect(runner.calls.some((c) => c[0] === "rm")).toBe(false);
    await expect(
      session.exec({ program: "node", args: ["--version"] }, owner.signal),
    ).resolves.toMatchObject({ exitCode: 0 });
    await session.dispose();
    expect(runner.calls.filter((c) => c[0] === "rm")).toHaveLength(1);
  });

  it("fresh dispatch/recovery identities cannot be removed by old session cleanup", async () => {
    const runner = new RecordingDockerRunner();
    const manager = new DockerSandboxManager({
      image: "test",
      workspaceRoot: process.cwd(),
      commandRunner: runner,
    });
    const options = createOptions(randomUUID());
    const first = await manager.create({
      ...options,
      owner: { executionOwner: "worker-a", dispatchRevision: 1, segment: randomUUID() },
    });
    await first.dispose(); // approval releases its segment before resume
    const second = await manager.create({
      ...options,
      owner: { executionOwner: "worker-b", dispatchRevision: 2, segment: randomUUID() },
    });
    expect(second.id).not.toBe(first.id);
    await first.dispose();
    await expect(first.exec({ program: "node", args: [] })).rejects.toMatchObject({
      code: "SANDBOX_ALREADY_DISPOSED",
      details: {
        executionOwner: "worker-a",
        dispatchRevision: 1,
        lifecycleInvariantViolation: true,
      },
    });
    await expect(second.exec({ program: "node", args: [] })).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(runner.calls.filter((c) => c[0] === "rm")).toHaveLength(1);
    await second.dispose();
  });

  it("revoked owners cannot begin writes or report in-flight success", async () => {
    let live = true;
    const runner = new RecordingDockerRunner(undefined, (args) => {
      if (args.includes("--revoke")) live = false;
      return false;
    });
    const { DevflowError } = await import("@devflow/shared");
    const manager = new DockerSandboxManager({
      image: "test",
      workspaceRoot: process.cwd(),
      commandRunner: runner,
      assertOwnership: async () => {
        if (!live) throw new DevflowError({ code: "SANDBOX_LOST_OWNERSHIP", message: "revoked" });
      },
    });
    const session = await manager.create(createOptions(randomUUID()));
    live = false;
    const count = runner.calls.length;
    await expect(session.writeFile({ path: "x", content: "stale" })).rejects.toMatchObject({
      code: "SANDBOX_LOST_OWNERSHIP",
    });
    expect(runner.calls).toHaveLength(count);
    live = true;
    await expect(session.exec({ program: "node", args: ["--revoke"] })).rejects.toMatchObject({
      code: "SANDBOX_LOST_OWNERSHIP",
    });
    await session.dispose();
  });

  it("owner cancellation fences future commands and creator cleanup is idempotent", async () => {
    const controller = new AbortController();
    const runner = new RecordingDockerRunner();
    const states: unknown[] = [];
    const manager = new DockerSandboxManager({
      image: "test",
      workspaceRoot: process.cwd(),
      commandRunner: runner,
      observeLifecycle: (e) => states.push(e.state),
    });
    const session = await manager.create(createOptions(randomUUID()), controller.signal);
    controller.abort();
    await expect(session.exec({ program: "node", args: [] })).rejects.toMatchObject({
      code: "SANDBOX_CANCELLED",
    });
    await Promise.all([session.dispose(), session.dispose()]);
    expect(states).toEqual(["ACTIVE", "DISPOSING", "DISPOSED"]);
    expect(runner.calls.filter((c) => c[0] === "rm")).toHaveLength(1);
  });

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
      code: "SANDBOX_CREATE_FAILED",
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
      code: "SANDBOX_CREATE_FAILED",
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
      code: "SANDBOX_RESTORE_FAILED",
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
