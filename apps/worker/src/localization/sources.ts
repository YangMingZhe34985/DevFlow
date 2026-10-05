import type { LocalRepositorySnapshot, SandboxSession } from "@devflow/sandbox";

/** Shared by Planner and approved-plan bridge; retrieval retains its smaller cap. */
export const PLAN_SOURCE_MAX_FILE_BYTES = 512 * 1024;
export function planningSnapshotSource(snapshot: LocalRepositorySnapshot): IndexSource {
  return snapshotSource(snapshot, { maxFileBytes: PLAN_SOURCE_MAX_FILE_BYTES });
}

import {
  exclusionReason,
  hash,
  INDEX_CONFIG,
  type IndexEntry,
  type IndexSource,
} from "./contracts.js";

/** LOCAL base manifest plus Git dirty overlay; a tombstone removes its baseline path. */
export function overlaySource(
  snapshot: LocalRepositorySnapshot,
  sandbox: SandboxSession,
): IndexSource {
  const baseSource = snapshotSource(snapshot);
  return workspaceOverlaySource(baseSource, sandbox);
}

function workspaceOverlaySource(baseSource: IndexSource, sandbox: SandboxSession): IndexSource {
  const live = sandboxSource(sandbox);
  const changes: NonNullable<IndexSource["changes"]> = async (signal) => {
    const status = await sandbox.exec(
      {
        program: "git",
        args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        timeoutMs: 10_000,
        maxOutputBytes: 2_000_000,
      },
      signal,
    );
    const entries: IndexEntry[] = [],
      deleted: string[] = [];
    if (status.exitCode !== 0 || status.outputTruncated)
      return { entries, deleted, incomplete: true };
    const records = status.stdout.split("\0").filter(Boolean);
    if (records.length > 128) return { entries, deleted, incomplete: true };
    for (let index = 0; index < records.length; index++) {
      signal.throwIfAborted();
      const record = records[index]!;
      if (record.length < 4) return { entries, deleted, incomplete: true };
      const state = record.slice(0, 2),
        path = record.slice(3);
      if (state.includes("R") || state.includes("C")) {
        const old = records[++index];
        if (!old) return { entries, deleted, incomplete: true };
        if (state.includes("R")) deleted.push(old);
      }
      if (state.includes("D") || exclusionReason(path) !== undefined) {
        deleted.push(path);
        continue;
      }
      const entry = await live.lookup!(path, signal);
      if (entry?.kind !== "FILE") {
        deleted.push(path);
        continue;
      }
      // Content is read and verified later, only when selected for evidence.
      entries.push(entry);
    }
    return { entries, deleted, incomplete: false };
  };
  return {
    ...live,
    base: baseSource,
    ...(baseSource.fileCount === undefined ? {} : { fileCount: baseSource.fileCount }),
    changes,
    async manifest(signal) {
      const delta = await changes(signal);
      if (delta.incomplete) return await live.manifest(signal);
      const base = await baseSource.manifest(signal);
      const entries = new Map(base.entries.map((entry) => [entry.path, entry]));
      for (const path of delta.deleted) entries.delete(path);
      for (const entry of delta.entries) {
        const path = entry.path;
        if (entry.sizeBytes <= INDEX_CONFIG.maxFileBytes) {
          const current = await live.read(path, signal);
          entries.set(path, {
            ...entry,
            ...(current.truncated ? {} : { contentHash: hash(current.content) }),
          });
        } else entries.set(path, entry);
      }
      return { entries: [...entries.values()], incomplete: base.incomplete };
    },
  };
}

/** Fixed Git object identity is supplied by Workflow; current evidence still comes from the live overlay. */
export function gitWorkspaceSource(baseCommit: string, sandbox: SandboxSession): IndexSource {
  if (!/^[0-9a-f]{40,64}$/u.test(baseCommit)) throw new Error("Immutable Git commit required");
  const tree = async (signal: AbortSignal, path?: string) => {
    const result = await sandbox.exec(
      {
        program: "git",
        args: [
          "ls-tree",
          "-r",
          "-l",
          "-z",
          "--full-tree",
          baseCommit,
          ...(path === undefined ? [] : ["--", path]),
        ],
        maxOutputBytes: 8 * 1024 * 1024,
        timeoutMs: 10_000,
      },
      signal,
    );
    if (result.exitCode !== 0) throw new Error("Git base manifest unavailable");
    const entries: IndexEntry[] = [];
    for (const record of result.stdout.split("\0")) {
      const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/u.exec(record);
      if (!match) continue;
      entries.push({
        path: match[4]!,
        sizeBytes: Number(match[3]),
        blobId: match[2]!,
        kind: match[1] === "120000" ? "SYMLINK" : "FILE",
      });
    }
    return {
      entries: entries.slice(0, INDEX_CONFIG.maxFiles),
      incomplete: result.outputTruncated || entries.length > INDEX_CONFIG.maxFiles,
    };
  };
  const base: IndexSource = {
    identity: `git:${baseCommit}`,
    manifest: (signal) => tree(signal),
    async lookup(path, signal) {
      if (exclusionReason(path)) return undefined;
      return (await tree(signal, path)).entries.find((entry) => entry.path === path);
    },
    async read(path, signal) {
      if (exclusionReason(path)) throw new Error("Excluded Git blob path");
      const result = await sandbox.exec(
        {
          program: "git",
          args: ["show", "--no-ext-diff", "--no-textconv", `${baseCommit}:${path}`],
          maxOutputBytes: INDEX_CONFIG.maxFileBytes,
          timeoutMs: 10_000,
        },
        signal,
      );
      if (result.exitCode !== 0) throw new Error("Git blob unavailable");
      return { content: result.stdout, truncated: result.outputTruncated };
    },
  };
  return workspaceOverlaySource(base, sandbox);
}

export function snapshotSource(
  snapshot: LocalRepositorySnapshot,
  options: { maxFileBytes?: number } = {},
): IndexSource {
  // Snapshot integrity validation guarantees sorted unique paths. No per-query O(N) Map.
  const find = (path: string) => {
    let low = 0,
      high = snapshot.files.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1,
        file = snapshot.files[mid]!;
      const order = file.path.localeCompare(path, "en");
      if (order === 0) return file;
      if (order < 0) low = mid + 1;
      else high = mid - 1;
    }
    return undefined;
  };
  return {
    ...(snapshot.manifestHash === undefined ? {} : { identity: snapshot.manifestHash }),
    fileCount: snapshot.files.length,
    async lookup(path, signal) {
      signal.throwIfAborted();
      const file = find(path);
      return file === undefined
        ? undefined
        : { path: file.path, kind: file.kind, sizeBytes: file.sizeBytes, contentHash: file.sha256 };
    },
    async manifest(signal) {
      signal.throwIfAborted();
      return {
        entries: snapshot.files.slice(0, INDEX_CONFIG.maxFiles).map((file) => ({
          path: file.path,
          kind: file.kind,
          sizeBytes: file.sizeBytes,
          contentHash: file.sha256,
        })),
        incomplete: snapshot.files.length > INDEX_CONFIG.maxFiles,
      };
    },
    async read(path, signal) {
      signal.throwIfAborted();
      if (exclusionReason(path) !== undefined)
        throw new Error("Path excluded by localization policy");
      const file = find(path);
      if (file?.kind !== "FILE") throw new Error("Missing or symlink snapshot entry");
      if (file.sizeBytes > Math.min(512 * 1024, options.maxFileBytes ?? INDEX_CONFIG.maxFileBytes))
        throw new Error("Oversize snapshot entry");
      const content = Buffer.from(file.contentBase64, "base64").toString("utf8");
      if (hash(content) !== file.sha256)
        throw new Error("Snapshot content hash mismatch or binary encoding");
      return { content, truncated: false };
    },
  };
}

/** No host repository reads. Traversal is breadth-first, bounded and never follows symlinks. */
export function sandboxSource(
  sandbox: SandboxSession,
  options: { maxFileBytes?: number } = {},
): IndexSource {
  const maxFileBytes = Math.min(512 * 1024, options.maxFileBytes ?? INDEX_CONFIG.maxFileBytes);
  return {
    async lookup(path, signal) {
      if (exclusionReason(path) !== undefined) return undefined;
      const listing = await sandbox.listFiles({ path, recursive: false, maxEntries: 1 }, signal);
      const entry = listing.entries.find((candidate) => candidate.path === path);
      return entry === undefined ? undefined : { ...entry, sizeBytes: entry.sizeBytes ?? 0 };
    },
    async manifest(signal) {
      const entries: IndexEntry[] = [];
      const directories = ["."];
      let calls = 0;
      let incomplete = false;
      while (directories.length > 0 && entries.length < INDEX_CONFIG.maxFiles && calls < 128) {
        signal.throwIfAborted();
        const directory = directories.shift()!;
        const listed = await sandbox.listFiles(
          { path: directory, recursive: false, maxEntries: 2000 },
          signal,
        );
        calls++;
        incomplete ||= listed.truncated;
        for (const entry of listed.entries) {
          if (entries.length >= INDEX_CONFIG.maxFiles) {
            incomplete = true;
            break;
          }
          if (entry.path === directory || entry.path === ".") continue;
          if (exclusionReason(entry.path) === "FORBIDDEN") continue;
          if (entry.kind === "DIRECTORY") {
            if (exclusionReason(entry.path) === undefined) directories.push(entry.path);
          } else entries.push({ ...entry, sizeBytes: entry.sizeBytes ?? 0 });
        }
      }
      return { entries, incomplete: incomplete || directories.length > 0 };
    },
    async read(path, signal) {
      if (exclusionReason(path) !== undefined)
        throw new Error("Path excluded by localization policy");
      // Reject all symlinks, including links inside the workspace, before reading evidence.
      const metadata = await sandbox.listFiles({ path, recursive: false, maxEntries: 1 }, signal);
      const entry = metadata.entries.find((file) => file.path === path);
      if (entry?.kind !== "FILE" || (entry.sizeBytes ?? Infinity) > maxFileBytes)
        throw new Error("Missing, symlink, or oversize evidence file");
      return await sandbox.readFile({ path, maxBytes: maxFileBytes }, signal);
    },
  };
}

/** Conservatively invalidate even failed commands: a command can write before failing. */
export function revisionedSandbox(sandbox: SandboxSession): {
  sandbox: SandboxSession;
  revision: () => number;
} {
  let revision = 0;
  const observed = new Map<string, string>();
  const verify = async (path: string, signal?: AbortSignal) => {
    const expected = observed.get(path);
    if (expected === undefined) throw new Error(`Read the current file before patching: ${path}`);
    // This is edit-time version verification, not the small localization index
    // read. Match replaceText/prewrite verification's complete-file envelope.
    const current = await sandbox.readFile({ path, maxBytes: 1_000_000 }, signal);
    if (current.truncated || hash(current.content) !== expected)
      throw new Error(`File changed since evidence was read: ${path}`);
    return expected;
  };
  const wrapped: SandboxSession = {
    id: sandbox.id,
    workspacePath: sandbox.workspacePath,
    listFiles: (input, signal) => sandbox.listFiles(input, signal),
    async readFile(input, signal) {
      if (exclusionReason(input.path) === "FORBIDDEN") throw new Error("Forbidden evidence path");
      const readRevision = revision;
      const file = await sandbox.readFile(input, signal);
      if (revision !== readRevision)
        throw new Error("Workspace revision changed during the read; obtain fresh evidence.");
      if (file.fileSha256 || !file.truncated) {
        if (observed.size >= 128) observed.delete(observed.keys().next().value!);
        observed.set(input.path, file.fileSha256 ?? hash(file.content));
      }
      return { ...file, workspaceRevision: readRevision };
    },
    dispose: () => sandbox.dispose(),
    async exec(command, signal) {
      try {
        return await sandbox.exec(command, signal);
      } finally {
        revision++;
      }
    },
    async writeFile(input, signal) {
      try {
        if (exclusionReason(input.path) === "FORBIDDEN")
          throw new Error("Forbidden workspace path");
        const expectedSha256 = observed.has(input.path)
          ? await verify(input.path, signal)
          : input.expectedSha256;
        return await sandbox.writeFile(
          { ...input, ...(expectedSha256 === undefined ? {} : { expectedSha256 }) },
          signal,
        );
      } finally {
        revision++;
      }
    },
    async applyPatch(input, signal) {
      try {
        const targets = [...input.patch.matchAll(/^\+\+\+ (.+)$/gmu)];
        if (targets.length === 0) throw new Error("Patch requires explicit file headers");
        for (const header of targets) {
          const target = header[1]!.trim();
          if (
            target !== "/dev/null" &&
            (!target.startsWith("b/") || exclusionReason(target.slice(2)) === "FORBIDDEN")
          )
            throw new Error("Forbidden patch target");
        }
        for (const header of input.patch.matchAll(/^--- (.+)$/gmu)) {
          const source = header[1]!.trim();
          if (source === "/dev/null") continue;
          if (!source.startsWith("a/") || exclusionReason(source.slice(2)) !== undefined)
            throw new Error("Unsupported or excluded patch path; use a versioned writeFile");
          await verify(source.slice(2), signal);
        }
        return await sandbox.applyPatch(input, signal);
      } finally {
        revision++;
      }
    },
  };
  return { sandbox: wrapped, revision: () => revision };
}
