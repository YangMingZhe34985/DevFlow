import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { RepositoryIndexStore } from "@devflow/database";
import { z } from "zod";
import {
  EntrySchema,
  exclusionReason,
  extractIssueSignals,
  hash,
  INDEX_CONFIG,
  INDEX_CONFIG_HASH,
  INDEX_VERSION,
  tokens,
  type IndexEntry,
  type IndexSource,
} from "./contracts.js";
import { parseCandidate, ParsedFileSchema, PARSER_VERSION } from "./parser.js";

export const ROUTER_DEFAULTS = {
  smallRepoFiles: 64,
  fastFiles: 3,
  postingLimit: 40,
  queryCandidates: 60,
  indexContentFiles: 64,
  indexReadBytes: 1024 * 1024,
  maxTermsPerFile: 128,
  maxIndexTerms: 200_000,
  maxPostingBytes: 16 * 1024 * 1024,
} as const;
export type RouterConfig = { [K in keyof typeof ROUTER_DEFAULTS]: number };
type Lane = "path" | "token" | "symbol";
const Root = z.object({
  files: z.number(),
  bytes: z.number(),
  incomplete: z.boolean(),
  buckets: z.record(
    z.string().regex(/^[0-9a-f]{2}$/u),
    z.string().regex(/^posting-bucket:[0-9a-f]{64}$/u),
  ),
});
const Posting = z.object({ paths: z.array(z.string().max(4096)).max(40), truncated: z.boolean() });
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const bucket = (value: string) => hash(value).slice(0, 2);

/** O(K) bounded insertion; never collect/sort the repository-sized candidate set. */
export function topK(rows: Iterable<{ path: string; score: number }>, limit: number) {
  const best: { path: string; score: number }[] = [];
  for (const row of rows) {
    const at = best.findIndex(
      (other) =>
        row.score > other.score || (row.score === other.score && compare(row.path, other.path) < 0),
    );
    if (at >= 0) best.splice(at, 0, row);
    else if (best.length < limit) best.push(row);
    if (best.length > limit) best.pop();
  }
  return best;
}

export async function routeQuery(
  source: IndexSource,
  description: string,
  scope: string,
  store: RepositoryIndexStore | undefined,
  signal: AbortSignal,
  config: RouterConfig,
  parserVersion = PARSER_VERSION,
) {
  const signals = extractIssueSignals(description);
  let manifestEntriesVisited = 0,
    postingsVisited = 0,
    indexBuildReadBytes = 0,
    anchorParses = 0;
  let prepared: Awaited<ReturnType<IndexSource["manifest"]>> | undefined;
  const manifest = async () => {
    if (prepared === undefined) {
      prepared = await source.manifest(signal);
      manifestEntriesVisited += prepared.entries.length;
    }
    return prepared;
  };
  const lookup = async (name: string) => {
    if (exclusionReason(name) !== undefined) return undefined;
    const raw = source.lookup
      ? await source.lookup(name, signal)
      : (await manifest()).entries.find((entry) => entry.path === name);
    const result = EntrySchema.safeParse(raw);
    return result.success &&
      result.data.kind === "FILE" &&
      result.data.sizeBytes <= INDEX_CONFIG.maxFileBytes
      ? result.data
      : undefined;
  };
  const verified: IndexEntry[] = [];
  for (const name of signals.paths) {
    signal.throwIfAborted();
    try {
      const entry = await lookup(name);
      if (entry) verified.push(entry);
    } catch {
      signal.throwIfAborted();
    }
  }
  // An exact current path is a sufficient routing anchor, never proof of root cause.
  const fastPath = async (
    verified: IndexEntry[],
    prefetched?: Map<string, Awaited<ReturnType<IndexSource["read"]>>>,
  ) => {
    const selected = verified.slice(0, config.fastFiles);
    const prefetch = prefetched ?? new Map<string, Awaited<ReturnType<IndexSource["read"]>>>();
    for (const entry of selected.slice()) {
      const file = prefetch.get(entry.path) ?? (await source.read(entry.path, signal));
      prefetch.set(entry.path, file);
      if (file.truncated) continue;
      // Direct relative imports only, no graph traversal. Resolve common JS-to-TS source mappings.
      const imports = [
        ...file.content.matchAll(/(?:from\s*|import\s*|require\(\s*)["'](\.[^"'\n]+)["']/gu),
      ]
        .slice(0, 4)
        .map((match) => match[1]!);
      const ext = path.posix.extname(entry.path);
      const stem = entry.path.slice(0, -ext.length);
      const neighbors = [
        `${stem}.test${ext}`,
        `${stem}.spec${ext}`,
        `${path.posix.dirname(entry.path)}/__tests__/${path.posix.basename(entry.path)}`,
      ];
      const candidates = imports
        .flatMap((specifier) => {
          const name = path.posix.normalize(
            path.posix.join(path.posix.dirname(entry.path), specifier),
          );
          return [
            name,
            name.replace(/\.m?js$/u, ".ts"),
            `${name}.ts`,
            `${name}.js`,
            `${name}/index.ts`,
          ];
        })
        .concat(neighbors);
      for (const name of candidates) {
        if (selected.length >= config.fastFiles) break;
        if (selected.some((item) => item.path === name)) continue;
        try {
          const found = await lookup(name);
          if (found) selected.push(found);
        } catch {
          signal.throwIfAborted();
        }
      }
    }
    const routedSource: IndexSource = {
      ...source,
      async read(name, readSignal) {
        const cached = prefetch.get(name);
        prefetch.delete(name);
        return cached ?? (await source.read(name, readSignal));
      },
    };
    return {
      route: "FAST_PATH" as const,
      source: routedSource,
      listing: { entries: selected, incomplete: verified.length > selected.length },
      manifestEntriesVisited,
      postingsVisited,
      indexBuildReadBytes,
      skippedBroadSearch: true,
      verifiedPaths: verified.map((entry) => entry.path),
      anchorParses,
    };
  };
  if (verified.length > 0 && verified.length === signals.paths.length)
    return await fastPath(verified);
  const count =
    source.fileCount ??
    (source.identity || source.base?.identity ? Infinity : (await manifest()).entries.length);
  if (count <= config.smallRepoFiles)
    return {
      route: "DIRECT_SEARCH" as const,
      source,
      listing: await manifest(),
      manifestEntriesVisited,
      postingsVisited,
      indexBuildReadBytes,
      skippedBroadSearch: false,
      verifiedPaths: [] as string[],
      anchorParses,
    };

  const base = source.base ?? source;
  const local = new Map<string, unknown>();
  const get = async (key: string) => local.get(key) ?? (await store?.get(scope, key));
  const publish = async (key: string, value: unknown) => {
    local.set(key, value);
    await store?.publish(scope, key, value);
  };
  let baseManifest: Awaited<ReturnType<IndexSource["manifest"]>> | undefined;
  const loadBase = async () => {
    if (!baseManifest) {
      baseManifest = base === source ? await manifest() : await base.manifest(signal);
      if (base !== source) manifestEntriesVisited += baseManifest.entries.length;
    }
    return baseManifest;
  };
  const identity = base.identity ?? hash(JSON.stringify((await loadBase()).entries));
  const prefix = `posting-v2:${hash(`${identity}:${INDEX_VERSION}:${JSON.stringify(config)}`)}`;
  let root = Root.safeParse(await get(`${prefix}:root`));
  if (!root.success) {
    const input = await loadBase();
    const postings = new Map<string, { paths: string[]; truncated: boolean }>();
    let postingBytes = 0,
      transientFailure = false;
    let totalBytes = 0,
      files = 0,
      incomplete = input.incomplete,
      readFiles = 0;
    const add = (lane: Lane, term: string, file: string) => {
      const key = `${lane}:${term.toLowerCase()}`;
      const list = postings.get(key) ?? { paths: [], truncated: false };
      if (list.paths.includes(file)) return;
      if (list.paths.length >= config.postingLimit && compare(file, list.paths.at(-1)!) >= 0) {
        list.truncated = true;
        postings.set(key, list);
        return;
      }
      const addedBytes =
        Buffer.byteLength(file) + (postings.has(key) ? 0 : Buffer.byteLength(key)) + 32;
      if (
        (!postings.has(key) && postings.size >= config.maxIndexTerms) ||
        postingBytes + addedBytes > config.maxPostingBytes
      ) {
        incomplete = true;
        return;
      }
      postingBytes += addedBytes;
      // Stable bounded posting list even when the manifest order differs.
      const kept = topK(
        [...list.paths.map((path) => ({ path, score: 0 })), { path: file, score: 0 }],
        config.postingLimit,
      );
      list.truncated ||= list.paths.length >= config.postingLimit;
      list.paths = kept.map((entry) => entry.path);
      postings.set(key, list);
    };
    for (const raw of input.entries.slice(0, INDEX_CONFIG.maxFiles)) {
      if (files % 128 === 0) {
        signal.throwIfAborted();
        await setImmediate();
      }
      const result = EntrySchema.safeParse(raw);
      if (!result.success || result.data.kind !== "FILE" || exclusionReason(result.data.path))
        continue;
      const entry = result.data;
      files++;
      totalBytes += entry.sizeBytes;
      for (const term of tokens(entry.path)) add("path", term, entry.path);
      if (
        entry.sizeBytes > INDEX_CONFIG.maxFileBytes ||
        readFiles >= config.indexContentFiles ||
        indexBuildReadBytes + INDEX_CONFIG.maxFileBytes > config.indexReadBytes
      ) {
        incomplete = true;
        continue;
      }
      readFiles++;
      const lexicalKey =
        entry.contentHash || entry.blobId
          ? `lexical:${hash(`${entry.contentHash ? `sha256:${entry.contentHash}` : `git:${entry.blobId}`}:terms-v1`)}`
          : undefined;
      const lexicalSchema = z.object({
        tokens: z.array(z.string()).max(128),
        symbols: z.array(z.string()).max(128),
      });
      let lexical = lexicalSchema.safeParse(lexicalKey ? await get(lexicalKey) : undefined);
      if (!lexical.success) {
        try {
          const content = await base.read(entry.path, signal);
          indexBuildReadBytes += Buffer.byteLength(content.content);
          if (
            content.truncated ||
            content.content.includes("\0") ||
            (entry.contentHash && hash(content.content) !== entry.contentHash)
          ) {
            incomplete = true;
            continue;
          }
          // Lexical declarations are candidates; AST validation still happens only on selected files.
          lexical = lexicalSchema.safeParse({
            tokens: tokens(content.content).slice(0, config.maxTermsPerFile),
            symbols: [
              ...content.content.matchAll(
                /\b(?:class|function|interface|def|const|let)\s+([\w$]+)/gu,
              ),
            ]
              .slice(0, 128)
              .map((m) => m[1]!),
          });
          if (lexical.success && lexicalKey) await publish(lexicalKey, lexical.data);
        } catch {
          signal.throwIfAborted();
          transientFailure = true;
          incomplete = true;
          continue;
        }
      }
      if (lexical.success) {
        for (const term of lexical.data.tokens) add("token", term, entry.path);
        for (const term of lexical.data.symbols) add("symbol", term, entry.path);
      }
    }
    const buckets = new Map<string, Record<string, unknown>>();
    for (const [key, value] of postings) {
      const id = bucket(key),
        target = buckets.get(id) ?? (Object.create(null) as Record<string, unknown>);
      target[key] = value;
      buckets.set(id, target);
    }
    const published: Record<string, string> = {};
    for (const [id, value] of buckets) {
      signal.throwIfAborted();
      const key = `posting-bucket:${hash(JSON.stringify(value))}`;
      await publish(key, value);
      published[id] = key;
    }
    signal.throwIfAborted();
    const metadata = {
      files,
      bytes: totalBytes,
      incomplete: incomplete || input.entries.length > INDEX_CONFIG.maxFiles,
      buckets: published,
    };
    // Failed reads are retryable: never pin an incomplete transient build as the reusable root.
    if (transientFailure) local.set(`${prefix}:root`, metadata);
    else await publish(`${prefix}:root`, metadata); // root last; stale builders cannot overwrite immutable keys.
    root = Root.safeParse(metadata);
  }
  const lanes: Lane[] = ["path", "symbol", "token"];
  const scores = new Map<string, number>();
  const bucketCache = new Map<string, unknown>();
  let incomplete = root.success ? root.data.incomplete : true;
  const readPosting = async (lane: Lane, term: string) => {
    const key = `${lane}:${term.toLowerCase()}`,
      id = bucket(key);
    const reference = root.success ? root.data.buckets[id] : undefined;
    if (!bucketCache.has(id)) bucketCache.set(id, reference ? await get(reference) : undefined);
    const raw = bucketCache.get(id);
    return Posting.safeParse(
      raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined,
    );
  };
  // Symbols must be verified against the current AST, not accepted from a name match alone.
  // Only unique, non-truncated postings can short-circuit; ambiguous names keep bounded recall.
  for (const symbol of signals.symbols.slice(0, 2)) {
    const posting = await readPosting("symbol", symbol);
    if (
      !posting.success ||
      posting.data.truncated ||
      posting.data.paths.length !== 1 ||
      source.changes
    )
      continue;
    postingsVisited++;
    const name = posting.data.paths[0]!,
      entry = await lookup(name);
    if (!entry) continue;
    const file = await source.read(name, signal);
    if (file.truncated) continue;
    const extension = name.split(".").at(-1) ?? "";
    const key = `parse:${hash(`${hash(file.content)}:${extension}:${parserVersion}:${INDEX_CONFIG_HASH}`)}`;
    const parseScope = scope.split(":")[0]!;
    const cached = ParsedFileSchema.safeParse(await store?.get(parseScope, key));
    const parsed = cached.success
      ? cached.data
      : await parseCandidate(file.content, extension, signal);
    if (!cached.success) {
      anchorParses++;
      await store?.publish(parseScope, key, parsed);
    }
    if (parsed.status === "PARSED" && parsed.symbols.some((item) => item.name === symbol))
      return await fastPath([entry], new Map([[name, file]]));
    indexBuildReadBytes += Buffer.byteLength(file.content);
  }
  for (const error of signals.errorStrings.filter((value) => value.length >= 12).slice(0, 1)) {
    if (source.changes) break;
    let candidates: string[] | undefined;
    for (const term of tokens(error).slice(0, 8)) {
      const posting = await readPosting("token", term);
      if (!posting.success || posting.data.truncated) {
        candidates = [];
        break;
      }
      postingsVisited += posting.data.paths.length;
      candidates =
        candidates === undefined
          ? posting.data.paths
          : candidates.filter((name) => posting.data.paths.includes(name));
    }
    if (candidates?.length === 1 && /\.(?:[cm]?[jt]sx?|py)$/u.test(candidates[0]!)) {
      const name = candidates[0]!,
        entry = await lookup(name);
      if (!entry) continue;
      const file = await source.read(name, signal);
      if (!file.truncated && file.content.includes(error))
        return await fastPath([entry], new Map([[name, file]]));
      indexBuildReadBytes += Buffer.byteLength(file.content);
    }
  }
  for (const lane of lanes)
    for (const term of tokens(description)) {
      const key = `${lane}:${term}`,
        id = bucket(key);
      const reference = root.success ? root.data.buckets[id] : undefined;
      if (!bucketCache.has(id)) bucketCache.set(id, reference ? await get(reference) : undefined);
      const raw = bucketCache.get(id);
      const posting = Posting.safeParse(
        raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined,
      );
      if (!posting.success) continue;
      incomplete ||= posting.data.truncated;
      for (const name of posting.data.paths) {
        postingsVisited++;
        scores.set(name, (scores.get(name) ?? 0) + (lane === "symbol" ? 3 : 1));
      }
    }
  const changed = await source.changes?.(signal);
  if (changed) {
    incomplete ||= changed.incomplete;
    for (const name of changed.deleted) scores.delete(name);
    for (const entry of changed.entries) {
      // Changed content is never represented by baseline postings. Bounded dirty set gets direct recall.
      scores.set(entry.path, (scores.get(entry.path) ?? 0) + 4);
    }
  }
  const entries: IndexEntry[] = [];
  for (const row of topK(
    [...scores].map(([path, score]) => ({ path, score })),
    config.queryCandidates,
  )) {
    const entry = await lookup(row.path);
    if (entry) entries.push(entry);
  }
  return {
    route: "INDEXED_SEARCH" as const,
    source,
    listing: { entries, incomplete },
    manifestEntriesVisited,
    postingsVisited,
    indexBuildReadBytes,
    skippedBroadSearch: false,
    verifiedPaths: [] as string[],
    anchorParses,
  };
}
