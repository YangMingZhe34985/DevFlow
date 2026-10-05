import { createHash } from "node:crypto";
import { GitHubShaSchema, type GitHubProvider, type GitHubRepository } from "@devflow/github";
import { exclusionReason, hash, type IndexEntry, type IndexSource } from "./contracts.js";

/** Read-only fixed Git objects; credentials stay inside GitHubProvider, before sandbox approval. */
export async function githubRepositorySource(
  input: {
    github: GitHubProvider;
    repository: GitHubRepository;
    baseCommitSha: string;
    maxFileBytes?: number;
  },
  signal: AbortSignal,
): Promise<IndexSource> {
  const baseCommitSha = GitHubShaSchema.parse(input.baseCommitSha).toLowerCase();
  const maxBytes = input.maxFileBytes ?? 512 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024)
    throw Error("Invalid GitHub source byte limit");
  signal.throwIfAborted();
  const tree = await input.github.readRepositoryTree(
    { repository: input.repository, baseCommitSha },
    signal,
  );
  signal.throwIfAborted();
  const entries = new Map<string, IndexEntry>();
  for (const item of tree.entries) {
    if (entries.has(item.path)) throw Error("Duplicate immutable Git tree path");
    entries.set(item.path, {
      path: item.path,
      kind: item.kind,
      sizeBytes: item.sizeBytes ?? maxBytes + 1,
      ...(item.blobSha ? { blobId: item.blobSha.toLowerCase() } : {}),
    });
  }
  const contents = new Map<string, string>();
  return {
    identity: `github:${input.repository.owner}/${input.repository.name}@${baseCommitSha}`,
    fileCount: tree.entries.filter((e) => e.kind === "FILE").length,
    async manifest(readSignal) {
      readSignal.throwIfAborted();
      return { entries: [...entries.values()].map((e) => ({ ...e })), incomplete: tree.truncated };
    },
    async lookup(path, readSignal) {
      readSignal.throwIfAborted();
      const entry = entries.get(path);
      return entry ? { ...entry } : undefined;
    },
    async read(path, readSignal) {
      readSignal.throwIfAborted();
      const entry = entries.get(path);
      if (
        exclusionReason(path) !== undefined ||
        /(?:^|\/)(?:hidden-acceptance|hidden-tests?)(?:\/|$)/iu.test(path) ||
        !entry ||
        entry.kind !== "FILE" ||
        !entry.blobId ||
        entry.sizeBytes > maxBytes
      )
        throw Error(
          "GitHub source path is absent, protected, linked, oversized or lacks immutable blob identity",
        );
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index++)
        if (entries.get(parts.slice(0, index).join("/"))?.kind === "SYMLINK")
          throw Error("GitHub source parent is a symbolic link");
      let content = contents.get(path);
      if (content === undefined) {
        const result = await input.github.readRepositoryFile(
          { repository: input.repository, blobSha: entry.blobId, maxBytes },
          readSignal,
        );
        readSignal.throwIfAborted();
        const bytes = Buffer.from(result.content);
        const actual = createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex");
        if (
          result.blobSha !== entry.blobId ||
          actual !== entry.blobId ||
          result.sizeBytes !== bytes.length ||
          bytes.length !== entry.sizeBytes ||
          bytes.length > maxBytes ||
          result.content.includes("\0")
        )
          throw Error("GitHub source identity changed or content is incomplete");
        content = result.content;
        contents.set(path, content);
        entry.contentHash = hash(content);
      }
      return { content, truncated: false };
    },
  };
}
