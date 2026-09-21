import { spawn } from "node:child_process";
import path from "node:path";

import { assertCredentialFreeRepositoryUri, DevflowError, toDevflowError } from "@devflow/shared";

import {
  CommandSpecSchema,
  SandboxCreateOptionsSchema,
  type ApplyPatchRequest,
  type ApplyPatchResult,
  type CommandResult,
  type CommandSpec,
  type ListFilesRequest,
  type ListFilesResult,
  type LocalRepositorySnapshot,
  type ReadFileRequest,
  type ReadFileResult,
  type SandboxCreateOptions,
  type SandboxManager,
  type SandboxSession,
  type WriteFileRequest,
  type WriteFileResult,
} from "./contracts.js";
import {
  captureLocalRepositorySnapshot,
  validateSnapshotIntegrity,
} from "./local-repository-snapshot.js";

const DEFAULT_DOCKER_OUTPUT_BYTES = 1_000_000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 200_000;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ENVIRONMENT_VALUE_BYTES = 32_768;
const MAX_ENVIRONMENT_BYTES = 131_072;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export interface DockerSandboxManagerOptions {
  image: string;
  workspaceRoot: string;
  commandRunner?: DockerCommandRunner;
}

export interface DockerCommandOptions {
  signal?: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number;
}

export interface DockerCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  outputTruncated: boolean;
}

export interface DockerCommandRunner {
  run(args: readonly string[], options?: DockerCommandOptions): Promise<DockerCommandResult>;
}

interface SnapshotRepository {
  kind: "SNAPSHOT";
  snapshot: LocalRepositorySnapshot;
}

interface RemoteRepository {
  kind: "CLONE";
  uri: string;
}

type ResolvedRepository = SnapshotRepository | RemoteRepository;

export class NodeDockerCommandRunner implements DockerCommandRunner {
  async run(
    args: readonly string[],
    options: DockerCommandOptions = {},
  ): Promise<DockerCommandResult> {
    if (options.signal?.aborted === true) {
      throw new DevflowError({
        code: "CANCELLED",
        message: "Docker command was cancelled before it started.",
      });
    }

    const startedAt = Date.now();
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_DOCKER_OUTPUT_BYTES;
    return await new Promise<DockerCommandResult>((resolve, reject) => {
      const child = spawn("docker", args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let capturedBytes = 0;
      let outputTruncated = false;
      let settled = false;

      const capture = (target: Buffer[], chunk: Buffer): void => {
        const remaining = maxOutputBytes - capturedBytes;
        if (remaining <= 0) {
          outputTruncated = true;
          return;
        }
        const kept = chunk.subarray(0, remaining);
        target.push(kept);
        capturedBytes += kept.length;
        if (kept.length < chunk.length) outputTruncated = true;
      };
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));

      const onAbort = (): void => {
        child.kill();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        if (options.signal?.aborted === true) {
          reject(
            new DevflowError({
              code: "CANCELLED",
              message: "Docker command was cancelled.",
            }),
          );
          return;
        }
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          durationMs: Date.now() - startedAt,
          outputTruncated,
        });
      });

      child.stdin.on("error", () => undefined);
      if (options.stdin !== undefined) child.stdin.write(options.stdin);
      child.stdin.end();
    });
  }
}

export class DockerSandboxManager implements SandboxManager {
  private readonly runner: DockerCommandRunner;
  private readonly sessions = new Map<string, DockerSandboxSession>();

  constructor(private readonly options: DockerSandboxManagerOptions) {
    this.runner = options.commandRunner ?? new NodeDockerCommandRunner();
  }

  async create(options: SandboxCreateOptions, signal?: AbortSignal): Promise<SandboxSession> {
    const parsed = SandboxCreateOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "Invalid Docker sandbox configuration.",
        details: parsed.error.flatten(),
      });
    }
    validateEnvironment(parsed.data.environment);
    validateGitReference(parsed.data.repository.baseRef);
    const repository = await this.resolveRepository(parsed.data.repository, signal);
    if (repository.kind === "CLONE" && !parsed.data.limits.networkEnabled) {
      throw new DevflowError({
        code: "PERMISSION_DENIED",
        message: "Remote repository cloning requires sandbox network access.",
      });
    }

    const containerName = ("devflow-" + parsed.data.runId.replace(/[^a-zA-Z0-9_.-]/gu, "-")).slice(
      0,
      63,
    );
    const memory = String(parsed.data.limits.memoryMb) + "m";
    const createArgs = [
      "create",
      "--name",
      containerName,
      "--label",
      "devflow.managed=true",
      "--label",
      "devflow.runId=" + parsed.data.runId,
      "--init",
      "--security-opt",
      "no-new-privileges",
      "--workdir",
      "/workspace",
      "--cpus",
      String(parsed.data.limits.cpuCount),
      "--memory",
      memory,
      "--memory-swap",
      memory,
      "--pids-limit",
      String(parsed.data.limits.pids),
    ];
    if (!parsed.data.limits.networkEnabled) createArgs.push("--network", "none");
    appendEnvironment(createArgs, parsed.data.environment);
    createArgs.push(this.options.image, "sleep", "infinity");

    try {
      ensureDockerSuccess(
        await this.runner.run(createArgs, dockerSignal(signal)),
        "create sandbox",
      );
      ensureDockerSuccess(
        await this.runner.run(["start", containerName], dockerSignal(signal)),
        "start sandbox",
      );

      if (repository.kind === "SNAPSHOT") {
        await restoreLocalSnapshot(this.runner, containerName, repository.snapshot, signal);
      } else {
        const cloneArgs = ["exec", "--user", "10001:10001", containerName, "git", "clone"];
        if (parsed.data.repository.baseRef !== undefined) {
          cloneArgs.push("--branch", parsed.data.repository.baseRef, "--single-branch");
        }
        cloneArgs.push("--", repository.uri, "/workspace");
        ensureDockerSuccess(
          await this.runner.run(cloneArgs, dockerSignal(signal)),
          "clone repository into sandbox",
        );
      }

      // LOCAL snapshots are already fixed to the captured effective working tree.
      // Only remote clones are checked out to a requested immutable revision.
      const revision = repository.kind === "CLONE" ? parsed.data.repository.baseCommit : undefined;
      if (revision !== undefined) {
        ensureDockerSuccess(
          await this.runner.run(
            [
              "exec",
              "--user",
              "10001:10001",
              containerName,
              "git",
              "-C",
              "/workspace",
              "checkout",
              "--detach",
              revision,
            ],
            dockerSignal(signal),
          ),
          "check out repository revision",
        );
      }

      const session = new DockerSandboxSession(
        containerName,
        parsed.data.limits.timeoutMs,
        this.runner,
        () => this.sessions.delete(containerName),
      );
      this.sessions.set(containerName, session);
      return session;
    } catch (error) {
      // `docker create` can produce the container and still surface an abort or
      // transport error to the client. The deterministic name makes an
      // unconditional best-effort cleanup both safe and idempotent.
      await removeContainer(this.runner, containerName).catch(() => undefined);
      throw toDevflowError(error, {
        code: "SANDBOX_FAILED",
        message: "Failed to create Docker sandbox.",
      });
    }
  }

  async destroy(sandboxId: string): Promise<void> {
    const session = this.sessions.get(sandboxId);
    if (session !== undefined) {
      await session.dispose();
      return;
    }
    await removeContainer(this.runner, sandboxId);
  }

  private async resolveRepository(
    repository: SandboxCreateOptions["repository"],
    signal?: AbortSignal,
  ): Promise<ResolvedRepository> {
    if (repository.snapshot !== undefined) {
      if (isRemoteRepository(repository.sourceUri)) {
        throw new DevflowError({
          code: "VALIDATION_ERROR",
          message: "A LOCAL snapshot cannot be used with a remote repository URI.",
        });
      }
      return { kind: "SNAPSHOT", snapshot: validateSnapshotIntegrity(repository.snapshot) };
    }
    if (isRemoteRepository(repository.sourceUri)) {
      assertCredentialFreeRepositoryUri(repository.sourceUri);
      return { kind: "CLONE", uri: repository.sourceUri };
    }
    return {
      kind: "SNAPSHOT",
      snapshot: await captureLocalRepositorySnapshot({
        sourceUri: repository.sourceUri,
        workspaceRoot: this.options.workspaceRoot,
        ...(repository.baseRef === undefined ? {} : { baseRef: repository.baseRef }),
        ...(repository.baseCommit === undefined ? {} : { baseCommit: repository.baseCommit }),
        ...(signal === undefined ? {} : { signal }),
      }),
    };
  }
}

class DockerSandboxSession implements SandboxSession {
  readonly workspacePath = "/workspace";
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(
    readonly id: string,
    private readonly defaultTimeoutMs: number,
    private readonly runner: DockerCommandRunner,
    private readonly onDispose: () => void,
  ) {}

  async exec(command: CommandSpec, signal?: AbortSignal): Promise<CommandResult> {
    this.assertActive();
    const parsed = CommandSpecSchema.safeParse(command);
    if (!parsed.success) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "Invalid sandbox command.",
        details: parsed.error.flatten(),
      });
    }
    validateCommandText(parsed.data);
    validateEnvironment(parsed.data.env);

    const cwd = normalizeRelativePath(parsed.data.cwd ?? ".");
    const timeoutMs = Math.min(
      parsed.data.timeoutMs ?? this.defaultTimeoutMs,
      this.defaultTimeoutMs,
    );
    const args = ["exec", "--workdir", "/workspace"];
    appendEnvironment(args, parsed.data.env);
    if (parsed.data.stdin !== undefined) args.push("--interactive");
    args.push(
      this.id,
      "timeout",
      "--signal=TERM",
      "--kill-after=1s",
      Math.max(0.001, timeoutMs / 1000).toString() + "s",
      "node",
      "-e",
      EXEC_COMMAND_SCRIPT,
      cwd,
      parsed.data.program,
      ...parsed.data.args,
    );

    let result: DockerCommandResult;
    try {
      result = await this.runner.run(args, {
        ...(signal === undefined ? {} : { signal }),
        ...(parsed.data.stdin === undefined ? {} : { stdin: parsed.data.stdin }),
        maxOutputBytes: parsed.data.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_BYTES,
      });
    } catch (error) {
      if (signal?.aborted === true) {
        await this.dispose().catch(() => undefined);
        throw new DevflowError({
          code: "CANCELLED",
          message: "Sandbox command was cancelled and its container was removed.",
          cause: error,
        });
      }
      throw toDevflowError(error, {
        code: "SANDBOX_FAILED",
        message: "Docker could not execute the sandbox command.",
      });
    }

    const timedOut = result.exitCode === 124;
    if (timedOut) await this.dispose();
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut,
      outputTruncated: result.outputTruncated,
    };
  }

  async listFiles(input: ListFilesRequest, signal?: AbortSignal): Promise<ListFilesResult> {
    const requestedPath = normalizeRelativePath(input.path ?? ".");
    const recursive = input.recursive ?? false;
    const maxEntries = input.maxEntries ?? 500;
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 2_000) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "maxEntries must be between 1 and 2000.",
      });
    }
    const result = await this.exec(
      {
        program: "node",
        args: ["-e", LIST_FILES_SCRIPT, requestedPath, String(recursive), String(maxEntries)],
        timeoutMs: 15_000,
        maxOutputBytes: 1_000_000,
      },
      signal,
    );
    return parseJsonCommand<ListFilesResult>(result, "list files");
  }

  async readFile(input: ReadFileRequest, signal?: AbortSignal): Promise<ReadFileResult> {
    const requestedPath = normalizeRelativePath(input.path);
    const maxBytes = input.maxBytes ?? 200_000;
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "maxBytes must be between 1 and 1000000.",
      });
    }
    const result = await this.exec(
      {
        program: "node",
        args: ["-e", READ_FILE_SCRIPT, requestedPath, String(maxBytes)],
        timeoutMs: 15_000,
        maxOutputBytes: maxBytes + 20_000,
      },
      signal,
    );
    return parseJsonCommand<ReadFileResult>(result, "read file");
  }

  async writeFile(input: WriteFileRequest, signal?: AbortSignal): Promise<WriteFileResult> {
    const requestedPath = normalizeRelativePath(input.path);
    const result = await this.exec(
      {
        program: "node",
        args: ["-e", WRITE_FILE_SCRIPT, requestedPath, input.expectedSha256 ?? ""],
        stdin: input.content,
        timeoutMs: 20_000,
        maxOutputBytes: 20_000,
      },
      signal,
    );
    return parseJsonCommand<WriteFileResult>(result, "write file");
  }

  async applyPatch(input: ApplyPatchRequest, signal?: AbortSignal): Promise<ApplyPatchResult> {
    if (Buffer.byteLength(input.patch, "utf8") > 2_000_000) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "Patch exceeds the 2000000 byte sandbox limit.",
      });
    }
    const applyResult = await this.exec(
      {
        program: "git",
        args: ["apply", "--whitespace=nowarn", "-"],
        stdin: input.patch,
        timeoutMs: 30_000,
        maxOutputBytes: 100_000,
      },
      signal,
    );
    if (applyResult.exitCode !== 0) {
      return {
        applied: false,
        changedFiles: [],
        diagnostics: [applyResult.stderr || applyResult.stdout],
      };
    }
    const status = await this.exec(
      { program: "git", args: ["status", "--porcelain=v1"], timeoutMs: 10_000 },
      signal,
    );
    return {
      applied: true,
      changedFiles: status.stdout
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => line.slice(3)),
      diagnostics: [],
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposePromise ??= this.remove();
    await this.disposePromise;
  }

  private async remove(): Promise<void> {
    try {
      await removeContainer(this.runner, this.id);
      this.disposed = true;
      this.onDispose();
    } finally {
      if (!this.disposed) this.disposePromise = undefined;
    }
  }

  private assertActive(): void {
    if (this.disposed || this.disposePromise !== undefined) {
      throw new DevflowError({
        code: "SANDBOX_FAILED",
        message: "Sandbox '" + this.id + "' has already been disposed.",
      });
    }
  }
}

async function restoreLocalSnapshot(
  runner: DockerCommandRunner,
  containerName: string,
  snapshot: LocalRepositorySnapshot,
  signal?: AbortSignal,
): Promise<void> {
  ensureDockerSuccess(
    await runner.run(
      [
        "exec",
        "--interactive",
        "--user",
        "10001:10001",
        containerName,
        "node",
        "-e",
        RESTORE_LOCAL_SNAPSHOT_SCRIPT,
      ],
      {
        ...dockerSignal(signal),
        stdin: JSON.stringify(snapshot),
        maxOutputBytes: 100_000,
      },
    ),
    "restore LOCAL repository snapshot",
  );
  ensureDockerSuccess(
    await runner.run(
      [
        "exec",
        "--user",
        "10001:10001",
        containerName,
        "git",
        "init",
        "--initial-branch=devflow-snapshot",
        "/workspace",
      ],
      dockerSignal(signal),
    ),
    "initialize LOCAL snapshot repository",
  );
  ensureDockerSuccess(
    await runner.run(
      ["exec", "--user", "10001:10001", containerName, "git", "-C", "/workspace", "add", "--all"],
      dockerSignal(signal),
    ),
    "stage LOCAL snapshot baseline",
  );
  ensureDockerSuccess(
    await runner.run(
      [
        "exec",
        "--user",
        "10001:10001",
        "--env",
        "GIT_AUTHOR_DATE=2000-01-01T00:00:00Z",
        "--env",
        "GIT_COMMITTER_DATE=2000-01-01T00:00:00Z",
        containerName,
        "git",
        "-C",
        "/workspace",
        "-c",
        "user.name=DevFlow Snapshot",
        "-c",
        "user.email=snapshot@devflow.invalid",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        `DevFlow LOCAL snapshot of ${snapshot.sourceHead}`,
      ],
      dockerSignal(signal),
    ),
    "commit LOCAL snapshot baseline",
  );
}

async function removeContainer(runner: DockerCommandRunner, containerId: string): Promise<void> {
  const result = await runner.run(["rm", "--force", containerId]);
  if (result.exitCode !== 0 && !result.stderr.includes("No such container")) {
    throw new DevflowError({
      code: "SANDBOX_FAILED",
      message: "Failed to remove sandbox '" + containerId + "': " + result.stderr.trim(),
    });
  }
}

function ensureDockerSuccess(result: DockerCommandResult, operation: string): void {
  if (result.exitCode !== 0) {
    throw new DevflowError({
      code: "SANDBOX_FAILED",
      message:
        "Docker could not " + operation + ": " + (result.stderr.trim() || result.stdout.trim()),
    });
  }
}

function dockerSignal(signal: AbortSignal | undefined): DockerCommandOptions {
  return signal === undefined ? {} : { signal };
}

function parseJsonCommand<T>(result: CommandResult, operation: string): T {
  if (result.exitCode !== 0) {
    throw new DevflowError({
      code: result.timedOut ? "TIMEOUT" : "SANDBOX_FAILED",
      message: "Could not " + operation + ": " + (result.stderr.trim() || result.stdout.trim()),
    });
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new DevflowError({
      code: "SANDBOX_FAILED",
      message: "Sandbox returned invalid JSON while trying to " + operation + ".",
      cause: error,
    });
  }
}

function normalizeRelativePath(value: string): string {
  if (value.includes("\0") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new DevflowError({
      code: "PERMISSION_DENIED",
      message: "Path must be relative to the sandbox workspace: " + value,
    });
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) {
    throw new DevflowError({
      code: "PERMISSION_DENIED",
      message: "Path escapes the sandbox workspace: " + value,
    });
  }
  return path.posix.normalize(normalized);
}

function validateCommandText(command: CommandSpec): void {
  const values = [command.program, command.cwd ?? "", ...command.args];
  if (values.some((value) => value.includes("\0"))) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Sandbox command contains a null byte.",
    });
  }
}

function validateEnvironment(environment: Readonly<Record<string, string>> | undefined): void {
  const entries = Object.entries(environment ?? {});
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Sandbox environment exceeds " + String(MAX_ENVIRONMENT_ENTRIES) + " entries.",
    });
  }
  let totalBytes = 0;
  for (const [key, value] of entries) {
    if (!ENVIRONMENT_NAME.test(key)) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "Invalid sandbox environment variable name '" + key + "'.",
      });
    }
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (value.includes("\0") || valueBytes > MAX_ENVIRONMENT_VALUE_BYTES) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "Sandbox environment variable '" + key + "' is too large or invalid.",
      });
    }
    totalBytes += Buffer.byteLength(key, "utf8") + valueBytes;
  }
  if (totalBytes > MAX_ENVIRONMENT_BYTES) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Sandbox environment exceeds the total byte limit.",
    });
  }
}

function appendEnvironment(
  args: string[],
  environment: Readonly<Record<string, string>> | undefined,
): void {
  for (const [key, value] of Object.entries(environment ?? {})) {
    args.push("--env", key + "=" + value);
  }
}

function validateGitReference(reference: string | undefined): void {
  if (reference === undefined) return;
  const valid =
    /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(reference) &&
    !reference.includes("..") &&
    !reference.includes("@{") &&
    !reference.endsWith("/") &&
    !reference.endsWith(".");
  if (!valid) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Repository baseRef is not a safe Git reference.",
    });
  }
}

function isRemoteRepository(sourceUri: string): boolean {
  return (
    /^(?:https?|ssh|git):\/\//iu.test(sourceUri) ||
    /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:.+/u.test(sourceUri)
  );
}

const RESTORE_LOCAL_SNAPSHOT_SCRIPT = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const root = "/workspace";',
  'const snapshot = JSON.parse(fs.readFileSync(0, "utf8"));',
  "for (const entry of snapshot.files) {",
  '  const requested = String(entry.path).replaceAll("\\\\", "/");',
  '  const segments = requested.split("/");',
  '  if (!requested || path.posix.isAbsolute(requested) || segments.includes("..") || segments.includes(".git")) throw new Error("unsafe snapshot path");',
  "  const destination = path.resolve(root, ...segments);",
  '  if (!destination.startsWith(root + path.sep)) throw new Error("snapshot path escaped workspace");',
  "  fs.mkdirSync(path.dirname(destination), { recursive: true });",
  '  if (entry.kind === "FILE") {',
  '    fs.writeFileSync(destination, Buffer.from(entry.contentBase64, "base64"), { mode: entry.mode });',
  "    fs.chmodSync(destination, entry.mode);",
  '  } else if (entry.kind === "SYMLINK") {',
  "    fs.symlinkSync(entry.target, destination);",
  '  } else throw new Error("unsupported snapshot entry");',
  "}",
].join("\n");

const WORKSPACE_GUARD_SCRIPT = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const root = fs.realpathSync("/workspace");',
  "function inside(candidate) {",
  "  return candidate === root || candidate.startsWith(root + path.sep);",
  "}",
  "function guardLexical(requested) {",
  "  const candidate = path.resolve(root, requested);",
  '  if (!inside(candidate)) throw new Error("path traversal outside /workspace");',
  "  return candidate;",
  "}",
  "function guardReal(candidate) {",
  "  const resolved = fs.realpathSync(candidate);",
  '  if (!inside(resolved)) throw new Error("symlink escape outside /workspace");',
  "  return resolved;",
  "}",
].join("\n");

const EXEC_COMMAND_SCRIPT = [
  WORKSPACE_GUARD_SCRIPT,
  "const requested = process.argv[1];",
  "const program = process.argv[2];",
  "const args = process.argv.slice(3);",
  "const cwd = guardReal(guardLexical(requested));",
  'const child = require("node:child_process").spawn(program, args, {',
  "  cwd,",
  '  stdio: "inherit",',
  "  env: process.env,",
  "});",
  'child.once("error", (error) => { console.error(error.message); process.exitCode = 127; });',
  'child.once("exit", (code, signal) => {',
  "  process.exitCode = code === null ? (signal === null ? 1 : 128) : code;",
  "});",
].join("\n");

const LIST_FILES_SCRIPT = [
  WORKSPACE_GUARD_SCRIPT,
  "const requested = process.argv[1];",
  'const recursive = process.argv[2] === "true";',
  "const maxEntries = Number(process.argv[3]);",
  "const start = guardLexical(requested);",
  "const entries = [];",
  "let truncated = false;",
  'const ignoredDirectories = new Set([".git", "node_modules", ".next", "dist"]);',
  "function add(absolute) {",
  "  if (entries.length >= maxEntries) { truncated = true; return; }",
  "  const info = fs.lstatSync(absolute);",
  "  if (info.isSymbolicLink()) guardReal(absolute);",
  '  const relative = path.relative(root, absolute).split(path.sep).join("/") || ".";',
  '  const kind = info.isSymbolicLink() ? "SYMLINK" : info.isDirectory() ? "DIRECTORY" : "FILE";',
  "  entries.push({ path: relative, kind, ...(info.isFile() ? { sizeBytes: info.size } : {}) });",
  "  if (recursive && info.isDirectory()) {",
  "    guardReal(absolute);",
  "    for (const name of fs.readdirSync(absolute).sort()) {",
  "      if (ignoredDirectories.has(name)) continue;",
  "      if (entries.length >= maxEntries) { truncated = true; break; }",
  "      add(path.join(absolute, name));",
  "    }",
  "  }",
  "}",
  "const startInfo = fs.lstatSync(start);",
  "if (startInfo.isSymbolicLink()) {",
  "  guardReal(start);",
  "  add(start);",
  "} else if (startInfo.isDirectory()) {",
  "  guardReal(start);",
  "  for (const name of fs.readdirSync(start).sort()) {",
  "    if (ignoredDirectories.has(name)) continue;",
  "    add(path.join(start, name));",
  "  }",
  "} else {",
  "  add(start);",
  "}",
  "process.stdout.write(JSON.stringify({ entries, truncated }));",
].join("\n");

const READ_FILE_SCRIPT = [
  WORKSPACE_GUARD_SCRIPT,
  "const requested = process.argv[1];",
  "const maxBytes = Number(process.argv[2]);",
  "const absolute = guardReal(guardLexical(requested));",
  "const source = fs.readFileSync(absolute);",
  "const selected = source.subarray(0, maxBytes);",
  "process.stdout.write(JSON.stringify({",
  "  path: requested,",
  '  content: selected.toString("utf8"),',
  '  encoding: "utf8",',
  "  truncated: source.length > selected.length,",
  "}));",
].join("\n");

const WRITE_FILE_SCRIPT = [
  WORKSPACE_GUARD_SCRIPT,
  'const crypto = require("node:crypto");',
  "const requested = process.argv[1];",
  "const expected = process.argv[2];",
  "const absolute = guardLexical(requested);",
  "let ancestor = path.dirname(absolute);",
  "while (!fs.existsSync(ancestor)) {",
  "  const parent = path.dirname(ancestor);",
  '  if (parent === ancestor) throw new Error("no writable workspace ancestor");',
  "  ancestor = parent;",
  "}",
  "guardReal(ancestor);",
  "if (fs.existsSync(absolute)) {",
  "  guardReal(absolute);",
  "  if (expected) {",
  '    const current = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");',
  '    if (current !== expected) throw new Error("file changed since it was read");',
  "  }",
  "} else if (expected) {",
  '  throw new Error("expectedSha256 was provided but file is missing");',
  "}",
  'const content = fs.readFileSync(0, "utf8");',
  "fs.mkdirSync(path.dirname(absolute), { recursive: true });",
  "guardReal(path.dirname(absolute));",
  'const temporary = absolute + ".devflow-" + crypto.randomUUID() + ".tmp";',
  'fs.writeFileSync(temporary, content, "utf8");',
  "fs.renameSync(temporary, absolute);",
  'const sha256 = crypto.createHash("sha256").update(content).digest("hex");',
  "process.stdout.write(JSON.stringify({",
  "  path: requested,",
  "  sha256,",
  "  sizeBytes: Buffer.byteLength(content),",
  "}));",
].join("\n");
