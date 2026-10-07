import { setImmediate } from "node:timers/promises";
import { performance } from "node:perf_hooks";

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
  isTestFile,
  issueSearchTerms,
  sourcePathPriority,
  type EvidenceItem,
  type EvidencePack,
  type IndexEntry,
  type IndexSource,
} from "./contracts.js";
import { parseCandidate, ParsedFileSchema, PARSER_VERSION, type ParsedFile } from "./parser.js";
import { routeQuery, ROUTER_DEFAULTS, type RouterConfig } from "./query-index.js";

export interface LocalizationRequest {
  repositoryId: string;
  accessScope: string;
  baseCommitSha: string;
  runId: string;
  workspaceRevision: number;
  description: string;
  source: IndexSource;
  signal: AbortSignal;
  tokenBudget?: number;
  parserVersion?: string;
}

/** Bounded RRF: absence contributes zero; ties use a locale-independent path ordering. */
export function reciprocalRankFusion(
  lanes: readonly (readonly string[])[],
  anchors: readonly string[] = [],
): { path: string; score: number; sources: string[] }[] {
  const rows = new Map<string, { path: string; score: number; sources: string[] }>();
  const names = ["path", "symbol", "lexical"];
  lanes.forEach((lane, source) =>
    [...new Set(lane)].slice(0, INDEX_CONFIG.maxCandidates).forEach((path, index) => {
      const row = rows.get(path) ?? { path, score: 0, sources: [] };
      row.score += 1 / (60 + index + 1);
      row.sources.push(names[source] ?? "anchor");
      rows.set(path, row);
    }),
  );
  for (const path of anchors)
    if (!rows.has(path)) rows.set(path, { path, score: 0, sources: ["anchor"] });
  return [...rows.values()]
    .sort(
      (a, b) =>
        Number(anchors.includes(b.path)) - Number(anchors.includes(a.path)) ||
        b.score - a.score ||
        compare(a.path, b.path),
    )
    .slice(0, INDEX_CONFIG.fusedCandidates);
}

export class IssueLocalizer {
  private readonly routerConfig: RouterConfig;
  constructor(
    private readonly store?: RepositoryIndexStore,
    config: Partial<RouterConfig> = {},
  ) {
    this.routerConfig = { ...ROUTER_DEFAULTS, ...config };
  }

  async retrieve(input: LocalizationRequest): Promise<EvidencePack> {
    const started = performance.now();
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]);
    const scope = hash(`${input.accessScope}:${input.repositoryId}`);
    const signals = extractIssueSignals(input.description);
    const terms = issueSearchTerms(signals);
    const metrics: EvidencePack["metrics"] = {
      indexMs: 0,
      retrievalMs: 0,
      contextMs: 0,
      wallMs: 0,
      readBytes: 0,
      fileCount: 0,
      indexedBytes: 0,
      parsedFiles: 0,
      cacheHits: 0,
      duplicateQueries: 0,
      cacheState: "COLD",
      excluded: {},
      peakRssBytes: process.memoryUsage().rss,
      estimatedTokens: 0,
      tokenCounting: "UTF8_BYTES_UPPER_BOUND",
      exitReason: "COMPLETE",
      toolExecutions: 0,
    };
    const routed = await routeQuery(
      input.source,
      input.description,
      `${scope}:${input.baseCommitSha}`,
      this.store,
      signal,
      this.routerConfig,
      input.parserVersion,
    );
    const source = routed.source;
    const listing = routed.listing;
    metrics.manifestEntriesVisited = routed.manifestEntriesVisited;
    metrics.postingsVisited = routed.postingsVisited;
    metrics.indexBuildReadBytes = routed.indexBuildReadBytes;
    metrics.targetedSearchFiles = routed.targetedSearchFiles;
    metrics.readBytes = routed.indexBuildReadBytes;
    metrics.parsedFiles += routed.anchorParses;
    metrics.toolExecutions++;
    const entries: IndexEntry[] = [];
    const missing: string[] = [];
    let incomplete = listing.incomplete;
    for (let i = 0; i < Math.min(listing.entries.length, INDEX_CONFIG.maxFiles); i++) {
      if (i % 500 === 0) {
        signal.throwIfAborted();
        await setImmediate();
      }
      const parsed = EntrySchema.safeParse(listing.entries[i]);
      const entry = parsed.success ? parsed.data : undefined;
      const reason =
        entry === undefined
          ? "FORBIDDEN"
          : entry.kind !== "FILE"
            ? "NON_FILE"
            : (exclusionReason(entry.path) ??
              (entry.sizeBytes > INDEX_CONFIG.maxFileBytes ? "OVERSIZE" : undefined));
      if (reason !== undefined) {
        metrics.excluded[reason] = (metrics.excluded[reason] ?? 0) + 1;
        continue;
      }
      entries.push(entry!);
    }
    entries.sort((a, b) => compare(a.path, b.path));
    for (const path of signals.paths) {
      if (
        entries.some((entry) => entry.path === path) ||
        source.lookup === undefined ||
        exclusionReason(path) !== undefined
      )
        continue;
      try {
        const entry = EntrySchema.safeParse(await source.lookup(path, signal));
        metrics.toolExecutions++;
        if (
          entry.success &&
          entry.data.kind === "FILE" &&
          entry.data.sizeBytes <= INDEX_CONFIG.maxFileBytes
        )
          entries.push(entry.data);
      } catch (error) {
        if (signal.aborted) throw error;
        missing.push(`Anchor lookup unavailable: ${path}`);
      }
    }
    entries.sort((a, b) => compare(a.path, b.path));
    metrics.fileCount = entries.length;
    metrics.indexedBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    const manifestHash = hash(JSON.stringify(entries));
    const snapshotKey = hash(
      `${scope}:${input.baseCommitSha}:${INDEX_VERSION}:${INDEX_CONFIG_HASH}:${manifestHash}`,
    );
    const viewRevision = hash(`${snapshotKey}:${input.runId}:${input.workspaceRevision}`);
    const manifestKey = `manifest:${snapshotKey}`;
    const previousManifest =
      routed.route === "FAST_PATH" ? undefined : await this.store?.get(scope, manifestKey);
    if (previousManifest !== undefined) metrics.cacheHits++;
    else if (this.store !== undefined && routed.route !== "FAST_PATH") {
      const chunks: string[] = [];
      for (let offset = 0; offset < entries.length; offset += 500) {
        signal.throwIfAborted();
        const chunk = entries.slice(offset, offset + 500).map((entry) => ({
          ...entry,
          language: entry.path.split(".").at(-1) ?? "text",
          module: entry.path.split("/").slice(0, -1).join("/") || ".",
        }));
        const key = `manifest-chunk:${hash(JSON.stringify(chunk))}`;
        if ((await this.store.get(scope, key)) === undefined)
          await this.store.publish(scope, key, chunk);
        chunks.push(key);
      }
      signal.throwIfAborted();
      // Publish the root last. An interrupted builder leaves only unreachable immutable chunks.
      await this.store.publish(scope, manifestKey, {
        version: INDEX_VERSION,
        config: INDEX_CONFIG_HASH,
        manifestHash,
        chunks,
        state: incomplete ? "PARTIAL" : "READY",
        fileCount: entries.length,
        incomplete,
        excluded: metrics.excluded,
      });
    }
    metrics.indexMs = performance.now() - started;
    const retrievalStarted = performance.now();
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const anchors = [
      ...new Set([...signals.paths.filter((path) => byPath.has(path)), ...routed.verifiedPaths]),
    ];
    for (const path of signals.paths)
      if (!byPath.has(path)) missing.push(`Anchor unavailable or excluded: ${path}`);
    // Strong anchors first, then hinted modules, with a cross-module quota below.
    const scored: { entry: IndexEntry; score: number }[] = [];
    for (let index = 0; index < entries.length; index++) {
      if (index % 500 === 0) {
        signal.throwIfAborted();
        await setImmediate();
      }
      const entry = entries[index]!;
      scored.push({
        entry,
        score: terms.reduce(
          (sum, term) => sum + (entry.path.toLowerCase().includes(term) ? 1 : 0),
          0,
        ),
      });
    }
    const rankedPaths = scored.sort(
      (a, b) =>
        Number(anchors.includes(b.entry.path)) - Number(anchors.includes(a.entry.path)) ||
        b.score - a.score ||
        sourcePathPriority(b.entry.path, signals) - sourcePathPriority(a.entry.path, signals) ||
        compare(a.entry.path, b.entry.path),
    );
    const pathLane = rankedPaths
      .filter((entry) => entry.score > 0)
      .slice(0, 40)
      .map(({ entry }) => entry.path);
    const selected = [
      ...new Set([
        ...anchors,
        ...pathLane,
        ...rankedPaths.slice(0, 24).map(({ entry }) => entry.path),
        ...entries
          .filter((entry) => !signals.moduleHints.some((hint) => entry.path.startsWith(hint + "/")))
          .slice(0, 8)
          .map((entry) => entry.path),
      ]),
    ];
    const queryKey = `query:${hash(`${snapshotKey}:${JSON.stringify(signals)}:${input.parserVersion ?? PARSER_VERSION}:${INDEX_CONFIG_HASH}`)}`;
    // Only immutable, fully hashed views may persist a query (including no-results) across Runs.
    const immutable = entries.every((entry) => entry.contentHash !== undefined);
    const querySchema = z.object({
      paths: z.array(z.string()).max(96),
      incomplete: z.boolean(),
      ranking: z
        .array(
          z.object({
            path: z.string(),
            score: z.number().nonnegative(),
            sources: z.array(z.string()).max(3),
          }),
        )
        .max(60),
    });
    const cachedQuery =
      immutable && routed.route !== "FAST_PATH"
        ? querySchema.safeParse(await this.store?.get(scope, queryKey))
        : undefined;
    if (cachedQuery?.success) {
      metrics.cacheHits++;
      metrics.duplicateQueries++;
    }
    const read = new Map<
      string,
      { content: string; hash: string; parsed?: ParsedFile; lexical: number }
    >();
    let reservedBytes = routed.indexBuildReadBytes;
    let readCount = 0;
    const scan = async (paths: string[]) => {
      // Reserve before concurrency so the byte/call limits cannot be overrun by parallel reads.
      const permitted: string[] = [];
      for (const path of paths) {
        const entry = byPath.get(path);
        if (entry === undefined || read.has(path)) continue;
        if (
          readCount >= 96 ||
          reservedBytes + INDEX_CONFIG.maxFileBytes >
            INDEX_CONFIG.maxReadBytes - INDEX_CONFIG.maxEvidenceFiles * INDEX_CONFIG.maxFileBytes
        ) {
          incomplete = true;
          break;
        }
        readCount++;
        // Size metadata can become stale while a command is running. Reserve the read cap.
        reservedBytes += INDEX_CONFIG.maxFileBytes;
        permitted.push(path);
      }
      await mapBounded(permitted, async (path) => {
        signal.throwIfAborted();
        try {
          const file = await source.read(path, signal);
          metrics.toolExecutions++;
          const bytes = Buffer.byteLength(file.content);
          metrics.readBytes += bytes;
          if (file.truncated || bytes > INDEX_CONFIG.maxFileBytes || file.content.includes("\0")) {
            missing.push(`Incomplete/binary source: ${path}`);
            incomplete = true;
            return;
          }
          const digest = hash(file.content);
          const expected = byPath.get(path)?.contentHash;
          if (expected !== undefined && expected !== digest) {
            missing.push(`Version changed: ${path}`);
            incomplete = true;
            return;
          }
          const lower = file.content.toLowerCase();
          const lexical =
            routed.route === "FAST_PATH"
              ? 0
              : terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0) +
                signals.errorStrings.reduce(
                  (sum, term) => sum + (file.content.includes(term) ? 8 : 0),
                  0,
                );
          read.set(path, { content: file.content, hash: digest, lexical });
        } catch (error) {
          if (signal.aborted) throw error;
          missing.push(`Source unavailable: ${path}`);
          incomplete = true;
        }
      });
    };
    await scan(
      cachedQuery?.success ? cachedQuery.data.paths.filter((path) => byPath.has(path)) : selected,
    );
    // At most two deterministic expansions; no model round trip and no extra agent step budget.
    for (
      let expansion = 0;
      !cachedQuery?.success &&
      routed.route !== "FAST_PATH" &&
      expansion < 2 &&
      ![...read.values()].some((file) => file.lexical > 1);
      expansion++
    ) {
      await scan(
        entries
          .filter((entry) => !read.has(entry.path))
          .slice(0, 24)
          .map((entry) => entry.path),
      );
    }
    incomplete ||= cachedQuery?.success ? cachedQuery.data.incomplete : read.size < entries.length;
    const lexicalLane = [...read]
      .filter(([, file]) => file.lexical > 0)
      .sort(
        ([a, av], [b, bv]) =>
          bv.lexical +
            sourcePathPriority(b, signals) / 4 -
            (av.lexical + sourcePathPriority(a, signals) / 4) || compare(a, b),
      )
      .slice(0, 40)
      .map(([path]) => path);
    const candidates = [...new Set([...anchors, ...pathLane, ...lexicalLane])]
      .filter((path) => read.has(path))
      .sort(
        (a, b) =>
          Number(anchors.includes(b)) - Number(anchors.includes(a)) ||
          sourcePathPriority(b, signals) - sourcePathPriority(a, signals) ||
          lexicalLane.indexOf(a) - lexicalLane.indexOf(b),
      )
      .slice(0, 40);
    await mapBounded(candidates.slice(0, INDEX_CONFIG.maxEvidenceFiles), async (path) => {
      const file = read.get(path)!;
      const extension = path.split(".").at(-1) ?? "";
      const key = `parse:${hash(`${file.hash}:${extension}:${input.parserVersion ?? PARSER_VERSION}:${INDEX_CONFIG_HASH}`)}`;
      const cached = ParsedFileSchema.safeParse(await this.store?.get(scope, key));
      if (cached.success) {
        file.parsed = cached.data;
        metrics.cacheHits++;
        return;
      }
      try {
        file.parsed = await parseCandidate(file.content, extension, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        missing.push(`Parser unavailable; lexical fallback: ${path}`);
        incomplete = true;
        file.parsed = { status: "LEXICAL", symbols: [], imports: [] };
        return;
      }
      metrics.parsedFiles++;
      metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage().rss);
      signal.throwIfAborted();
      await this.store?.publish(scope, key, file.parsed);
    });
    const symbolLane = candidates
      .filter((path) =>
        read
          .get(path)
          ?.parsed?.symbols.some(
            (symbol) =>
              signals.symbols.includes(symbol.name.replace(/^\$/u, "")) ||
              terms.includes(symbol.name.toLowerCase()),
          ),
      )
      .slice(0, 40);
    const ranked =
      routed.route === "FAST_PATH"
        ? [...entries]
            .sort(
              (a, b) =>
                Number(anchors.includes(b.path)) - Number(anchors.includes(a.path)) ||
                compare(a.path, b.path),
            )
            .map((entry) => ({
              path: entry.path,
              score: anchors.includes(entry.path) ? 1 : 0.5,
              sources: [anchors.includes(entry.path) ? "verified-anchor" : "direct-support"],
            }))
        : cachedQuery?.success
          ? cachedQuery.data.ranking
          : reciprocalRankFusion([pathLane, symbolLane, lexicalLane], anchors).sort(
              (a, b) =>
                Number(anchors.includes(b.path)) - Number(anchors.includes(a.path)) ||
                b.score +
                  sourcePathPriority(b.path, signals) / 1000 -
                  (a.score + sourcePathPriority(a.path, signals) / 1000) ||
                compare(a.path, b.path),
            );
    if (immutable && !cachedQuery?.success && routed.route !== "FAST_PATH")
      await this.store?.publish(scope, queryKey, {
        paths: ranked
          .filter((row) => read.has(row.path))
          .slice(0, INDEX_CONFIG.maxEvidenceFiles)
          .map((row) => row.path),
        incomplete,
        ranking: ranked,
      });
    metrics.retrievalMs = performance.now() - retrievalStarted;
    const contextStarted = performance.now();
    const evidence: EvidenceItem[] = [];
    const hashes = new Set<string>();
    for (const row of ranked) {
      if (evidence.length >= INDEX_CONFIG.maxEvidenceFiles) break;
      const file = read.get(row.path);
      if (file === undefined) continue;
      if (hashes.has(file.hash)) {
        if (anchors.includes(row.path))
          missing.push(
            `Duplicate-content anchor: ${row.path}; see matching content hash in evidence.`,
          );
        continue;
      }
      // Read again at publication. Never substitute a baseline snippet for a changed workspace file.
      const current = await source.read(row.path, signal);
      metrics.toolExecutions++;
      metrics.readBytes += Buffer.byteLength(current.content);
      if (current.truncated || hash(current.content) !== file.hash) {
        missing.push(`Stale evidence rejected: ${row.path}`);
        incomplete = true;
        continue;
      }
      const lines = file.content.split(/\r?\n/u);
      const symbol = file.parsed?.symbols
        .filter(
          (s) =>
            signals.symbols.includes(s.name.replace(/^\$/u, "")) ||
            terms.includes(s.name.toLowerCase()),
        )
        .sort(
          (a, b) =>
            signals.symbols.indexOf(a.name.replace(/^\$/u, "")) -
            signals.symbols.indexOf(b.name.replace(/^\$/u, "")),
        )[0];
      const requestedHit =
        signals.stackFrames.find((frame) => frame.path === row.path)?.line ??
        symbol?.startLine ??
        bestEvidenceLine(lines, terms, signals.errorStrings);
      const hit = Math.max(1, Math.min(lines.length, requestedHit));
      if (requestedHit !== hit) {
        missing.push(`Stack line outside current file: ${row.path}`);
        incomplete = true;
      }
      const startLine = Math.max(1, hit - 4);
      const endLine = Math.min(
        lines.length,
        symbol !== undefined && symbol.endLine - startLine < 80 ? symbol.endLine : hit + 20,
      );
      const snippet = lines
        .slice(startLine - 1, endLine)
        .join("\n")
        .slice(0, 4096);
      evidence.push({
        repositoryId: input.repositoryId,
        baseCommitSha: input.baseCommitSha,
        viewRevision,
        path: row.path,
        contentHash: file.hash,
        startLine,
        endLine: startLine + snippet.split("\n").length - 1,
        symbol: symbol?.name ?? null,
        language: row.path.split(".").at(-1) ?? "text",
        module: row.path.split("/").slice(0, -1).join("/") || ".",
        fileType: isTestFile(row.path)
          ? "TEST"
          : /\.(?:md|txt)$/u.test(row.path)
            ? "DOCUMENT"
            : /(?:config|package\.json)/u.test(row.path)
              ? "CONFIG"
              : "SOURCE",
        parseStatus: file.parsed?.status ?? "LEXICAL",
        signature: symbol?.signature ?? null,
        directImports: file.parsed?.imports ?? [],
        reason: anchors.includes(row.path)
          ? "Exact Issue anchor; candidate, not verified root cause"
          : "Bounded reciprocal rank fusion; candidate only",
        retrievalSource: row.sources,
        score: row.score,
        snippet,
        truncated: startLine > 1 || endLine < lines.length || snippet.length >= 4096,
      });
      hashes.add(file.hash);
    }
    if (evidence.length === 0)
      missing.push(
        "No supported evidence found within retrieval limits; use targeted existing tools.",
      );
    if (anchors.length > 8)
      missing.push(
        "More than 8 strong anchors: remaining anchors require a subsequent targeted read.",
      );
    const pack: EvidencePack = {
      route: routed.route,
      evidenceSufficient:
        routed.route === "FAST_PATH" &&
        evidence.some(
          (item) => item.snippet.trim().length > 0 && item.parseStatus !== "PARSE_ERROR",
        ),
      sufficiencyReasons:
        routed.route === "FAST_PATH"
          ? [
              "Current path verified; bounded source and available direct imports/tests included. Candidate hypothesis only, not confirmed root cause.",
            ]
          : ["No exact path verified; bounded retrieval may require targeted follow-up."],
      indexVersion: INDEX_VERSION,
      indexConfigHash: INDEX_CONFIG_HASH,
      viewRevision,
      issueSummary: input.description.slice(0, 1000),
      moduleScope: signals.moduleHints.slice(0, 8).map((hint) => hint.slice(0, 128)),
      rootCauseCandidates: evidence.map((item) => item.path),
      evidence,
      excludedHypotheses: [],
      missingInformation: missing.slice(0, 12).map((message) => message.slice(0, 256)),
      truncated: incomplete || ranked.length > evidence.length,
      incomplete,
      metrics,
    };
    // UTF-8 bytes is a conservative token upper bound including JSON framing. Caller reserves other messages/tools/output.
    const budget = Math.max(
      0,
      Math.min(
        input.tokenBudget ?? INDEX_CONFIG.contextBudgetTokens,
        INDEX_CONFIG.contextBudgetTokens,
      ),
    );
    while (Buffer.byteLength(JSON.stringify(pack)) + 128 > budget && pack.evidence.length > 0) {
      const omitted = pack.evidence.pop();
      const warning =
        "Context budget omitted strong anchors; retrieve the remaining explicit paths individually.";
      if (
        omitted !== undefined &&
        anchors.includes(omitted.path) &&
        !pack.missingInformation.includes(warning)
      )
        pack.missingInformation.unshift(warning);
      pack.rootCauseCandidates = pack.evidence.map((item) => item.path);
      pack.truncated = true;
    }
    while (
      Buffer.byteLength(JSON.stringify(pack)) + 128 > budget &&
      pack.missingInformation.length > 1
    ) {
      pack.missingInformation.pop();
      pack.truncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(pack)) + 128 > budget) {
      pack.issueSummary = pack.issueSummary.slice(0, 120);
      pack.moduleScope = [];
      pack.truncated = true;
    }
    if (budget < 1500)
      throw new Error("Insufficient remaining context budget for an evidence envelope");
    pack.rootCauseCandidates = pack.evidence.map((item) => item.path);
    pack.evidenceSufficient &&=
      pack.evidence.length > 0 &&
      !pack.incomplete &&
      anchors.every((path) => pack.evidence.some((item) => item.path === path));
    metrics.cacheState =
      metrics.cacheHits === 0 ? "COLD" : metrics.parsedFiles === 0 ? "WARM" : "PARTIAL";
    metrics.filesInspected = read.size;
    metrics.astParsedFiles = [...read.values()].filter((f) => f.parsed?.status === "PARSED").length;
    metrics.lexicalFiles = [...read.values()].filter((f) => f.parsed?.status === "LEXICAL").length;
    metrics.parseErrorFiles = [...read.values()].filter(
      (f) => f.parsed?.status === "PARSE_ERROR",
    ).length;
    metrics.estimatedTokens = Buffer.byteLength(JSON.stringify(pack)) + 128;
    metrics.contextMs = performance.now() - contextStarted;
    metrics.wallMs = performance.now() - started;
    metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage().rss);
    metrics.exitReason = pack.incomplete ? "BOUNDED_INCOMPLETE" : "COMPLETE";
    return pack;
  }
}

async function mapBounded<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(INDEX_CONFIG.concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await work(items[index]!);
      }
    }),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bestEvidenceLine(lines: string[], terms: string[], errors: string[]): number {
  const common = new Set([
    "from",
    "import",
    "const",
    "return",
    "function",
    "the",
    "this",
    "that",
    "with",
    "should",
    "have",
    "test",
    "tests",
    "expected",
    "actual",
    "file",
    "files",
  ]);
  const specific = terms.filter((term) => term.length > 3 && !common.has(term));
  let best = 1,
    score = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!,
      lower = line.toLowerCase();
    const value =
      specific.reduce(
        (sum, term) => sum + (lower.includes(term) ? Math.min(term.length, 24) : 0),
        0,
      ) + errors.reduce((sum, error) => sum + (line.includes(error) ? 100 : 0), 0);
    if (value > score) {
      best = index + 1;
      score = value;
    }
  }
  return best;
}
