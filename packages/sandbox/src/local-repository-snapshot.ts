import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { DevflowError, toDevflowError } from "@devflow/shared";

import { LocalRepositorySnapshotSchema, type LocalRepositorySnapshot } from "./contracts.js";

export const LOCAL_SNAPSHOT_MAX_FILES = 20_000;
export const LOCAL_SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;
export const LOCAL_SNAPSHOT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME = "local-repository-snapshot.v1.json.gz";

const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SERIALIZED_SNAPSHOT_BYTES = 80 * 1024 * 1024;

export interface CaptureLocalRepositorySnapshotOptions {
  sourceUri: string;
  workspaceRoot: string;
  baseRef?: string;
  baseCommit?: string;
  signal?: AbortSignal;
}

export interface CaptureLocalRepositoryCommitSnapshotOptions {
  sourceUri: string;
  workspaceRoot: string;
  baseCommit: string;
  baseRef?: string;
  verifyBaseRef?: boolean;
  signal?: AbortSignal;
}

export interface ResolveLocalRepositoryBaseOptions {
  sourceUri: string;
  workspaceRoot: string;
  baseRef?: string;
  signal?: AbortSignal;
}

export interface ResolvedLocalRepositoryBase {
  baseRef: string;
  baseCommitSha: string;
}

/** Resolves task provenance without reading file contents or mutating the checkout. */
export async function resolveLocalRepositoryBase(
  options: ResolveLocalRepositoryBaseOptions,
): Promise<ResolvedLocalRepositoryBase> {
  const repositoryPath = await resolveAllowedRepository(options.sourceUri, options.workspaceRoot);
  const branch =
    options.baseRef === undefined
      ? await runGit(
          repositoryPath,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          options.signal,
          true,
        )
      : undefined;
  const baseRef = options.baseRef ?? (branch?.exitCode === 0 ? branch.stdout.trim() : "HEAD");
  const revision = await runGit(
    repositoryPath,
    ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
    options.signal,
    true,
  );
  const baseCommitSha = revision.stdout.trim().toLowerCase();
  if (revision.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(baseCommitSha)) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: `LOCAL repository base ref '${baseRef}' could not be resolved to a full 40-character commit SHA.`,
      details: { sourceKind: "LOCAL", baseRef },
    });
  }
  return { baseRef, baseCommitSha };
}

/**
 * Captures the immutable tree of a Git commit without checking it out or
 * consulting the developer's working tree. This is the P11 benchmark input
 * path: dirty/untracked host files can never affect a benchmark case.
 */
export async function captureLocalRepositoryCommitSnapshot(
  options: CaptureLocalRepositoryCommitSnapshotOptions,
): Promise<LocalRepositorySnapshot> {
  const repositoryPath = await resolveAllowedRepository(options.sourceUri, options.workspaceRoot);
  const requested = options.baseCommit.toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(requested)) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Benchmark LOCAL repositories require a full immutable Git commit SHA.",
    });
  }
  const resolved = (
    await runGit(
      repositoryPath,
      ["rev-parse", "--verify", "--end-of-options", `${requested}^{commit}`],
      options.signal,
    )
  ).stdout
    .trim()
    .toLowerCase();
  if (resolved !== requested) throw revisionMismatch("base commit", requested, resolved);
  if (options.baseRef !== undefined && options.verifyBaseRef !== false) {
    const resolvedRef = (
      await runGit(
        repositoryPath,
        ["rev-parse", "--verify", "--end-of-options", `${options.baseRef}^{commit}`],
        options.signal,
      )
    ).stdout
      .trim()
      .toLowerCase();
    if (resolvedRef !== requested) throw revisionMismatch("base ref", options.baseRef, requested);
  }

  const tree = await runGit(
    repositoryPath,
    ["ls-tree", "-rz", "--full-tree", requested, "--"],
    options.signal,
  );
  const entries = parseCommitTree(tree.stdout);
  if (entries.length > LOCAL_SNAPSHOT_MAX_FILES) {
    throw snapshotLimit(
      `Benchmark snapshot contains ${String(entries.length)} files; the limit is ${String(LOCAL_SNAPSHOT_MAX_FILES)}.`,
    );
  }
  const files: LocalRepositorySnapshot["files"][number][] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    assertNotAborted(options.signal);
    validateSnapshotPath(entry.path);
    const content = await runGitBinary(
      repositoryPath,
      ["cat-file", "blob", entry.objectId],
      options.signal,
      LOCAL_SNAPSHOT_MAX_FILE_BYTES,
    );
    totalBytes += content.length;
    assertTotalSize(totalBytes);
    if (entry.mode === "120000") {
      files.push({
        kind: "SYMLINK",
        path: entry.path,
        mode: 0o777,
        sizeBytes: content.length,
        sha256: sha256(content),
        target: content.toString("utf8"),
      });
    } else {
      files.push({
        kind: "FILE",
        path: entry.path,
        mode: entry.mode === "100755" ? 0o755 : 0o644,
        sizeBytes: content.length,
        sha256: sha256(content),
        contentBase64: content.toString("base64"),
      });
    }
  }
  return validateSnapshotIntegrity({
    version: 1,
    sourceHead: requested,
    ...(options.baseRef === undefined ? {} : { requestedBaseRef: options.baseRef }),
    requestedBaseCommit: requested,
    totalBytes,
    files,
  });
}

/**
 * Captures tracked and non-ignored untracked files without mutating the source repository.
 * `.git`, ignored files, hooks and remote configuration are deliberately excluded.
 */
export async function captureLocalRepositorySnapshot(
  options: CaptureLocalRepositorySnapshotOptions,
): Promise<LocalRepositorySnapshot> {
  const repositoryPath = await resolveAllowedRepository(options.sourceUri, options.workspaceRoot);
  assertNotAborted(options.signal);

  const gitRoot = await runGit(repositoryPath, ["rev-parse", "--show-toplevel"], options.signal);
  const canonicalGitRoot = await realpath(gitRoot.stdout.trim()).catch(() => undefined);
  if (canonicalGitRoot === undefined || !isWithin(canonicalGitRoot, repositoryPath)) {
    throw new DevflowError({
      code: "SANDBOX_FAILED",
      message: "LOCAL repository source must be inside a Git working tree.",
      details: { repositoryPath },
    });
  }

  const head = (
    await runGit(repositoryPath, ["rev-parse", "--verify", "HEAD^{commit}"], options.signal)
  ).stdout
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(head)) {
    throw new DevflowError({
      code: "SANDBOX_FAILED",
      message: "LOCAL repository HEAD did not resolve to a commit.",
    });
  }

  if (options.baseCommit !== undefined && !head.startsWith(options.baseCommit.toLowerCase())) {
    if (!/^[0-9a-f]{40}$/iu.test(options.baseCommit)) {
      throw revisionMismatch("base commit", options.baseCommit, head);
    }
    // A Task pins its immutable base when it is created. If the developer later
    // checks out or advances another branch, restore the pinned commit tree
    // instead of forcing the host checkout back to that ref.
    return await captureLocalRepositoryCommitSnapshot({
      sourceUri: options.sourceUri,
      workspaceRoot: options.workspaceRoot,
      baseCommit: options.baseCommit,
      ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
      verifyBaseRef: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
  // A LOCAL run snapshots the effective checked-out worktree: current HEAD plus
  // tracked modifications and non-ignored untracked files. `baseRef` is task
  // provenance only and must not force developers to checkout a default branch.
  // An explicitly pinned baseCommit remains a strict reproducibility boundary.

  const branchResult = await runGit(
    repositoryPath,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    options.signal,
    true,
  );
  const sourceBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : undefined;
  const listed = await runGit(
    repositoryPath,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"],
    options.signal,
  );
  const stageOutput = await runGit(
    repositoryPath,
    ["ls-files", "-z", "--stage", "--cached", "--"],
    options.signal,
  );
  const trackedModes = parseTrackedModes(stageOutput.stdout);
  const relativePaths = [...new Set(splitNull(listed.stdout))].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  if (relativePaths.length > LOCAL_SNAPSHOT_MAX_FILES) {
    throw snapshotLimit(
      `LOCAL snapshot contains ${String(relativePaths.length)} files; the limit is ${String(LOCAL_SNAPSHOT_MAX_FILES)}.`,
    );
  }

  const files: LocalRepositorySnapshot["files"][number][] = [];
  let totalBytes = 0;
  for (const relativePath of relativePaths) {
    assertNotAborted(options.signal);
    validateSnapshotPath(relativePath);
    const absolutePath = path.resolve(repositoryPath, ...relativePath.split("/"));
    if (!isWithin(repositoryPath, absolutePath)) {
      throw new DevflowError({
        code: "PERMISSION_DENIED",
        message: `Git returned a path outside the LOCAL repository: ${relativePath}`,
      });
    }
    const before = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    // A tracked file deleted in the working tree is intentionally absent from the snapshot.
    if (before === undefined) continue;

    const gitMode = trackedModes.get(relativePath);
    const mode = gitMode === "100755" ? 0o755 : before.mode & 0o777;
    if (before.isFile()) {
      if (before.size > LOCAL_SNAPSHOT_MAX_FILE_BYTES) {
        throw snapshotLimit(
          `LOCAL snapshot file '${relativePath}' exceeds ${String(LOCAL_SNAPSHOT_MAX_FILE_BYTES)} bytes.`,
        );
      }
      const content = await readFile(absolutePath);
      await assertUnchanged(absolutePath, before.size, before.mtimeMs);
      totalBytes += content.length;
      assertTotalSize(totalBytes);
      files.push({
        kind: "FILE",
        path: relativePath,
        mode,
        sizeBytes: content.length,
        sha256: sha256(content),
        contentBase64: content.toString("base64"),
      });
      continue;
    }
    if (before.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      const content = Buffer.from(target, "utf8");
      await assertUnchanged(absolutePath, before.size, before.mtimeMs);
      totalBytes += content.length;
      assertTotalSize(totalBytes);
      files.push({
        kind: "SYMLINK",
        path: relativePath,
        mode,
        sizeBytes: content.length,
        sha256: sha256(content),
        target,
      });
      continue;
    }
    throw new DevflowError({
      code: "SANDBOX_FAILED",
      message: `LOCAL snapshot does not support repository entry '${relativePath}'.`,
      details: { path: relativePath, gitMode },
    });
  }

  const finalHead = (
    await runGit(repositoryPath, ["rev-parse", "--verify", "HEAD^{commit}"], options.signal)
  ).stdout
    .trim()
    .toLowerCase();
  const finalListing = await runGit(
    repositoryPath,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"],
    options.signal,
  );
  if (finalHead !== head || finalListing.stdout !== listed.stdout) {
    throw new DevflowError({
      code: "SANDBOX_FAILED",
      message: "LOCAL repository changed while its run snapshot was being captured; retry the run.",
      retryable: true,
    });
  }

  return LocalRepositorySnapshotSchema.parse({
    version: 1,
    sourceHead: head,
    ...(sourceBranch === undefined || sourceBranch.length === 0 ? {} : { sourceBranch }),
    ...(options.baseRef === undefined ? {} : { requestedBaseRef: options.baseRef }),
    ...(options.baseCommit === undefined
      ? {}
      : { requestedBaseCommit: options.baseCommit.toLowerCase() }),
    totalBytes,
    files,
  });
}

export function encodeLocalRepositorySnapshot(snapshot: LocalRepositorySnapshot): string {
  const checked = validateSnapshotIntegrity(snapshot);
  return gzipSync(Buffer.from(JSON.stringify(checked), "utf8"), { level: 9 }).toString("base64");
}

export function localRepositorySnapshotMetadata(
  snapshot: LocalRepositorySnapshot,
): Record<string, string | number> {
  return {
    version: snapshot.version,
    sourceHead: snapshot.sourceHead,
    ...(snapshot.sourceBranch === undefined ? {} : { sourceBranch: snapshot.sourceBranch }),
    ...(snapshot.requestedBaseRef === undefined
      ? {}
      : { requestedBaseRef: snapshot.requestedBaseRef }),
    ...(snapshot.requestedBaseCommit === undefined
      ? {}
      : { requestedBaseCommit: snapshot.requestedBaseCommit }),
    fileCount: snapshot.files.length,
    totalBytes: snapshot.totalBytes,
    contentEncoding: "base64+gzip",
  };
}

export function decodeLocalRepositorySnapshot(encoded: string): LocalRepositorySnapshot {
  try {
    if (Buffer.byteLength(encoded, "utf8") > MAX_SERIALIZED_SNAPSHOT_BYTES * 2) {
      throw snapshotLimit("Encoded LOCAL snapshot exceeds the supported size.");
    }
    const serialized = gunzipSync(Buffer.from(encoded, "base64"), {
      maxOutputLength: MAX_SERIALIZED_SNAPSHOT_BYTES,
    }).toString("utf8");
    return validateSnapshotIntegrity(LocalRepositorySnapshotSchema.parse(JSON.parse(serialized)));
  } catch (error) {
    if (error instanceof DevflowError) throw error;
    throw toDevflowError(error, {
      code: "SANDBOX_FAILED",
      message: "Persisted LOCAL repository snapshot is invalid.",
    });
  }
}

export function validateSnapshotIntegrity(
  snapshot: LocalRepositorySnapshot,
): LocalRepositorySnapshot {
  const checked = LocalRepositorySnapshotSchema.parse(snapshot);
  if (checked.files.length > LOCAL_SNAPSHOT_MAX_FILES) {
    throw snapshotLimit("Persisted LOCAL snapshot exceeds the file-count limit.");
  }
  let totalBytes = 0;
  let previousPath: string | undefined;
  for (const entry of checked.files) {
    validateSnapshotPath(entry.path);
    if (previousPath !== undefined && entry.path.localeCompare(previousPath, "en") <= 0) {
      throw new DevflowError({
        code: "SANDBOX_FAILED",
        message: "Persisted LOCAL snapshot paths must be unique and sorted.",
      });
    }
    previousPath = entry.path;
    const content =
      entry.kind === "FILE"
        ? Buffer.from(entry.contentBase64, "base64")
        : Buffer.from(entry.target, "utf8");
    if (content.length !== entry.sizeBytes || sha256(content) !== entry.sha256) {
      throw new DevflowError({
        code: "SANDBOX_FAILED",
        message: `Persisted LOCAL snapshot entry '${entry.path}' failed its integrity check.`,
      });
    }
    if (entry.kind === "FILE" && content.length > LOCAL_SNAPSHOT_MAX_FILE_BYTES) {
      throw snapshotLimit(`Persisted LOCAL snapshot file '${entry.path}' is too large.`);
    }
    totalBytes += content.length;
    assertTotalSize(totalBytes);
  }
  if (totalBytes !== checked.totalBytes) {
    throw new DevflowError({
      code: "SANDBOX_FAILED",
      message: "Persisted LOCAL snapshot total size does not match its manifest.",
    });
  }
  return checked;
}

async function resolveAllowedRepository(sourceUri: string, workspaceRoot: string): Promise<string> {
  const sourcePath = resolveLocalFilesystemPath(sourceUri);
  const rootPath = resolveLocalFilesystemPath(workspaceRoot);
  const repositoryPath = await realpath(sourcePath).catch(() => undefined);
  const allowedRoot = await realpath(rootPath).catch(() => undefined);
  if (repositoryPath === undefined || allowedRoot === undefined) {
    throw new DevflowError({
      code: "NOT_FOUND",
      message: "Repository directory or configured workspace root does not exist.",
      details: {
        repositoryPath: sourcePath,
        workspaceRoot: rootPath,
        repositoryExists: repositoryPath !== undefined,
        workspaceRootExists: allowedRoot !== undefined,
      },
    });
  }
  if (!isWithin(allowedRoot, repositoryPath)) {
    throw new DevflowError({
      code: "PERMISSION_DENIED",
      message: "Repository source resolves outside the configured workspace root.",
    });
  }
  return repositoryPath;
}

/** Converts a LOCAL source path or file URL to one native absolute path. */
export function resolveLocalFilesystemPath(value: string, baseDirectory = process.cwd()): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "LOCAL repository paths cannot be empty.",
    });
  }
  let filesystemPath: string;
  try {
    filesystemPath = /^file:/iu.test(trimmed) ? fileURLToPath(trimmed) : trimmed;
  } catch (error) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Repository file URI is invalid.",
      cause: error,
    });
  }
  return path.isAbsolute(filesystemPath)
    ? path.normalize(filesystemPath)
    : path.resolve(baseDirectory, filesystemPath);
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CommitTreeEntry {
  mode: "100644" | "100755" | "120000";
  objectId: string;
  path: string;
}

function parseCommitTree(output: string): CommitTreeEntry[] {
  const entries: CommitTreeEntry[] = [];
  for (const record of splitNull(output)) {
    const tab = record.indexOf("\t");
    const metadata = tab < 0 ? [] : record.slice(0, tab).split(" ");
    const [mode, type, objectId] = metadata;
    const entryPath = tab < 0 ? undefined : record.slice(tab + 1);
    if (
      (mode !== "100644" && mode !== "100755" && mode !== "120000") ||
      type !== "blob" ||
      objectId === undefined ||
      !/^[0-9a-f]{40,64}$/iu.test(objectId) ||
      entryPath === undefined
    ) {
      throw new DevflowError({
        code: "SANDBOX_FAILED",
        message: "Benchmark base commit contains an unsupported Git tree entry.",
        details: { record },
      });
    }
    entries.push({ mode, objectId, path: entryPath });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function runGitBinary(
  repositoryPath: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<Buffer> {
  assertNotAborted(signal);
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      "git",
      ["--no-optional-locks", "-c", "safe.directory=*", "-C", repositoryPath, ...args],
      {
        windowsHide: true,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    const abort = (): void => {
      child.kill();
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) child.kill();
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted === true) {
        reject(new DevflowError({ code: "CANCELLED", message: "Git snapshot was cancelled." }));
      } else if (bytes > maxBytes) {
        reject(snapshotLimit("A file in the benchmark base commit exceeds the file-size limit."));
      } else if (exitCode !== 0) {
        reject(
          new DevflowError({
            code: "SANDBOX_FAILED",
            message: `Could not read benchmark Git object: ${Buffer.concat(errors).toString("utf8").trim() || "git failed"}`,
          }),
        );
      } else {
        resolve(Buffer.concat(output));
      }
    });
  });
}

async function runGit(
  repositoryPath: string,
  args: readonly string[],
  signal?: AbortSignal,
  allowFailure = false,
): Promise<GitResult> {
  assertNotAborted(signal);
  return await new Promise<GitResult>((resolve, reject) => {
    const child = spawn(
      "git",
      ["--no-optional-locks", "-c", "safe.directory=*", "-C", repositoryPath, ...args],
      {
        windowsHide: true,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    const abort = (): void => {
      child.kill();
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted === true) {
        reject(new DevflowError({ code: "CANCELLED", message: "LOCAL snapshot was cancelled." }));
        return;
      }
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        reject(snapshotLimit("Git metadata for the LOCAL snapshot exceeds the output limit."));
        return;
      }
      const result = {
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.exitCode !== 0 && !allowFailure) {
        reject(
          new DevflowError({
            code: "SANDBOX_FAILED",
            message: `Could not inspect LOCAL repository: ${result.stderr.trim() || "git failed"}`,
          }),
        );
        return;
      }
      resolve(result);
    });
  });
}

function parseTrackedModes(output: string): ReadonlyMap<string, string> {
  const modes = new Map<string, string>();
  for (const record of splitNull(output)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const metadata = record.slice(0, tab).split(" ");
    const mode = metadata[0];
    const stage = metadata[2];
    if (mode !== undefined && stage === "0") modes.set(record.slice(tab + 1), mode);
  }
  return modes;
}

function splitNull(output: string): string[] {
  return output.split("\0").filter((value) => value.length > 0);
}

function validateSnapshotPath(value: string): void {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    value.includes("\\") ||
    normalized.startsWith("/") ||
    path.win32.isAbsolute(normalized) ||
    segments.includes("..") ||
    segments.includes(".git") ||
    normalized.includes("\0")
  ) {
    throw new DevflowError({
      code: "PERMISSION_DENIED",
      message: `Unsafe LOCAL snapshot path '${value}'.`,
    });
  }
}

async function assertUnchanged(
  absolutePath: string,
  expectedSize: number,
  expectedMtimeMs: number,
): Promise<void> {
  const after = await lstat(absolutePath);
  if (after.size !== expectedSize || after.mtimeMs !== expectedMtimeMs) {
    throw new DevflowError({
      code: "SANDBOX_FAILED",
      message: "LOCAL repository changed while its run snapshot was being captured; retry the run.",
      retryable: true,
    });
  }
}

function revisionMismatch(kind: string, requested: string, head: string): DevflowError {
  return new DevflowError({
    code: "SANDBOX_FAILED",
    message: `LOCAL repository ${kind} '${requested}' does not resolve to snapshot HEAD '${head}'.`,
    details: { kind, requested, actualHead: head },
  });
}

function snapshotLimit(message: string): DevflowError {
  return new DevflowError({
    code: "SANDBOX_FAILED",
    message,
    details: {
      maxFiles: LOCAL_SNAPSHOT_MAX_FILES,
      maxBytes: LOCAL_SNAPSHOT_MAX_BYTES,
      maxFileBytes: LOCAL_SNAPSHOT_MAX_FILE_BYTES,
    },
  });
}

function assertTotalSize(totalBytes: number): void {
  if (totalBytes > LOCAL_SNAPSHOT_MAX_BYTES) {
    throw snapshotLimit(
      `LOCAL snapshot exceeds the ${String(LOCAL_SNAPSHOT_MAX_BYTES)} byte total limit.`,
    );
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DevflowError({ code: "CANCELLED", message: "LOCAL snapshot was cancelled." });
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
