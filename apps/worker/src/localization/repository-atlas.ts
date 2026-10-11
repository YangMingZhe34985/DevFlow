import path from "node:path";
import type { RepositoryIndexStore } from "@devflow/database";
import { z } from "zod";
import {
  EntrySchema,
  exclusionReason,
  hash,
  INDEX_CONFIG,
  tokens,
  type IndexEntry,
  type IndexSource,
} from "./contracts.js";

export const ATLAS_VERSION = "prg-atlas-v1";
const SHARD_SIZE = 256;
const ManifestSchema = z.object({
  entries: z.array(EntrySchema).max(INDEX_CONFIG.maxFiles),
  incomplete: z.boolean(),
});
const RootSchema = z.object({
  version: z.literal(ATLAS_VERSION),
  identity: z.string(),
  shards: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(196),
  count: z.number().int().nonnegative(),
});
export interface AtlasNode {
  id: string;
  kind: "REPOSITORY" | "DIRECTORY" | "MODULE" | "FILE";
  path: string;
  parent: string | null;
  language?: string;
  sourceSha?: string;
  /** A manifest boundary is structural evidence, not an inferred responsibility. */
  moduleEvidence?: string;
}
export interface RepositoryAtlas {
  version: typeof ATLAS_VERSION;
  identity: string;
  coverage: "COMPLETE" | "PARTIAL";
  entries: IndexEntry[];
  nodes: AtlasNode[];
  metrics: { manifestCalls: number; sourceReads: number; cacheHits: number; excluded: number };
}
const language = (p: string) =>
  /\.[cm]?[jt]sx?$/iu.test(p)
    ? "typescript-javascript"
    : /\.py$/iu.test(p)
      ? "python"
      : /\.java$/iu.test(p)
        ? "java"
        : /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/iu.test(p)
          ? "cpp"
          : "other";
const boundary =
  /(?:^|\/)(?:package\.json|pyproject\.toml|pom\.xml|build\.gradle(?:\.kts)?|CMakeLists\.txt)$/u;
const immutable = (source: IndexSource) =>
  !source.changes &&
  /^(?:[a-f0-9]{64}|git:[a-f0-9]{40,64}|github:[^@]+@[a-f0-9]{40,64})$/iu.test(
    source.identity ?? "",
  );

/** Manifest-only: source parsing is a separately admitted operation. No directory IO here. */
export async function buildRepositoryAtlas(input: {
  source: IndexSource;
  scope: string;
  signal: AbortSignal;
  store?: RepositoryIndexStore;
}): Promise<RepositoryAtlas> {
  const metrics = { manifestCalls: 0, sourceReads: 0, cacheHits: 0, excluded: 0 };
  const scope = `${input.scope}:${ATLAS_VERSION}`;
  const key = `root:${hash(input.source.identity ?? "unknown")}`;
  let manifest: z.infer<typeof ManifestSchema> | undefined;
  if (immutable(input.source) && input.store) {
    const root = RootSchema.safeParse(await input.store.get(scope, key));
    if (root.success && root.data.identity === input.source.identity) {
      const entries: IndexEntry[] = [];
      let valid = true;
      for (const digest of root.data.shards) {
        input.signal.throwIfAborted();
        const shard = z
          .array(EntrySchema)
          .max(SHARD_SIZE)
          .safeParse(await input.store.get(scope, `shard:${digest}`));
        if (!shard.success || hash(JSON.stringify(shard.data)) !== digest) {
          valid = false;
          break;
        }
        entries.push(...shard.data);
      }
      if (valid && entries.length === root.data.count && entries.length <= INDEX_CONFIG.maxFiles) {
        manifest = { entries, incomplete: false };
        metrics.cacheHits++;
      }
    }
  }
  if (!manifest) {
    input.signal.throwIfAborted();
    metrics.manifestCalls++;
    const raw = await input.source.manifest(input.signal);
    const entries: IndexEntry[] = [];
    let incomplete = raw.incomplete || raw.entries.length > INDEX_CONFIG.maxFiles;
    const seen = new Set<string>();
    for (const row of raw.entries.slice(0, INDEX_CONFIG.maxFiles)) {
      if (typeof row.path === "string" && exclusionReason(row.path)) {
        metrics.excluded++;
        continue;
      }
      const parsed = EntrySchema.safeParse(row);
      if (!parsed.success) {
        incomplete = true;
        continue;
      }
      const entry = parsed.data;
      if (exclusionReason(entry.path) || entry.kind !== "FILE") {
        metrics.excluded++;
        continue;
      }
      if (
        entry.path.includes("\\") ||
        entry.path.split("/").some((p) => !p || p === ".") ||
        seen.has(entry.path)
      ) {
        incomplete = true;
        continue;
      }
      seen.add(entry.path);
      entries.push(entry);
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    manifest = { entries, incomplete };
    // Publish immutable complete shards before root. Partial/overlay results never poison shared facts.
    if (!incomplete && immutable(input.source) && input.store) {
      const shards: string[] = [];
      for (let i = 0; i < entries.length; i += SHARD_SIZE) {
        const rows = entries.slice(i, i + SHARD_SIZE);
        const digest = hash(JSON.stringify(rows));
        await input.store.publish(scope, `shard:${digest}`, rows);
        shards.push(digest);
      }
      await input.store.publish(scope, key, {
        version: ATLAS_VERSION,
        identity: input.source.identity,
        shards,
        count: entries.length,
      });
    }
  }
  const nodes = new Map<string, AtlasNode>();
  nodes.set("", { id: "repository:", path: "", kind: "REPOSITORY", parent: null });
  for (const entry of manifest.entries) {
    input.signal.throwIfAborted();
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const directory = parts.slice(0, i).join("/");
      if (!nodes.has(directory))
        nodes.set(directory, {
          id: `directory:${directory}`,
          kind: "DIRECTORY",
          path: directory,
          parent: parts.slice(0, i - 1).join("/"),
        });
    }
    const parent = path.posix.dirname(entry.path) === "." ? "" : path.posix.dirname(entry.path);
    nodes.set(entry.path, {
      id: `file:${entry.path}`,
      kind: "FILE",
      path: entry.path,
      parent,
      language: language(entry.path),
      ...(entry.contentHash ? { sourceSha: entry.contentHash } : {}),
    });
    if (boundary.test(entry.path) && parent)
      Object.assign(nodes.get(parent)!, { kind: "MODULE", moduleEvidence: entry.path });
  }
  return {
    version: ATLAS_VERSION,
    identity: input.source.identity ?? hash(JSON.stringify(manifest)),
    coverage: manifest.incomplete ? "PARTIAL" : "COMPLETE",
    entries: manifest.entries,
    nodes: [...nodes.values()],
    metrics,
  };
}

/** Stable pagination, not a permanent Top-K cut of the investigation frontier. */
export function atlasPage(atlas: RepositoryAtlas, parent = "", offset = 0, limit = 24) {
  const children = atlas.nodes.filter((n) => n.parent === parent);
  const start = Math.max(0, Math.floor(offset));
  const size = Math.max(1, Math.min(48, Math.floor(limit)));
  return {
    identity: atlas.identity,
    coverage: atlas.coverage,
    parent,
    nodes: children.slice(start, start + size),
    nextOffset: start + size < children.length ? start + size : null,
    total: children.length,
  };
}

export function rankAtlasRegions(atlas: RepositoryAtlas, query: string) {
  const terms = tokens(query);
  return atlas.nodes
    .filter((n) => n.kind !== "REPOSITORY")
    .map((node) => ({
      path: node.path,
      kind: node.kind,
      score: tokens(node.path).reduce((sum, term) => sum + Number(terms.includes(term)), 0),
      status: "HYPOTHESIS" as const,
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/** Reuses the acquired manifest while preserving the source's read/accounting boundary. */
export function atlasSource(source: IndexSource, atlas: RepositoryAtlas): IndexSource {
  const entries = new Map(atlas.entries.map((e) => [e.path, e]));
  return {
    ...source,
    manifest: async (signal) => {
      signal.throwIfAborted();
      return { entries: atlas.entries, incomplete: atlas.coverage === "PARTIAL" };
    },
    lookup: async (p, signal) => {
      signal.throwIfAborted();
      return (
        entries.get(p) ?? (atlas.coverage === "PARTIAL" ? source.lookup?.(p, signal) : undefined)
      );
    },
  };
}
