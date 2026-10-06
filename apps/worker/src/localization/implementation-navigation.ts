import { posix } from "node:path";
import {
  EntrySchema,
  extractIssueSignals,
  hash,
  issueSearchTerms,
  sourcePathPriority,
  sourceRole,
  type IndexEntry,
  type IndexSource,
} from "./contracts.js";
import { graphPathAllowed, RepositoryRelationGraph } from "./relation-graph.js";
import type { RelationParse } from "./relation-parser.js";
import { issueSymbolHints } from "./implementation-anchors.js";

export interface ImplementationWindow {
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  contentHash: string;
  snippet: string;
  reason: string;
  kind: "IMPLEMENTATION" | "REFERENCE";
}
export interface NavigationResult {
  windows: ImplementationWindow[];
  missing: string[];
  observations: string[];
  metrics: {
    reads: number;
    sourceBytes: number;
    windows: number;
    implementationWindows: number;
    newRelations: number;
    snippetBytes: number;
    exitReason: string;
  };
}
const normal = (name: string) => name.replace(/[^a-z0-9]/giu, "").toLowerCase();
const matches = (name: string, requested: string) =>
  normal(name) === normal(requested) ||
  (normal(requested).length >= 4 && normal(name).endsWith(normal(requested))) ||
  (normal(requested).length >= 8 && normal(name).includes(normal(requested)));
const codePath = (path: string) => /\.(?:[cm]?[jt]sx?)$/iu.test(path);
// A forwarding filename may also contain real bodies. Role affects ranking;
// verified AST bodies, rather than the filename alone, establish this evidence kind.
const implementationKind = (path: string): ImplementationWindow["kind"] =>
  ["IMPLEMENTATION", "ENTRY"].includes(sourceRole(path)) ? "IMPLEMENTATION" : "REFERENCE";
const lexicalCommon = new Set([
  "return",
  "const",
  "function",
  "schema",
  "schemas",
  "string",
  "object",
  "number",
  "true",
  "false",
  "undefined",
  "expected",
  "actual",
  "should",
  "this",
  "that",
  "with",
  "from",
  "when",
  "using",
  "issue",
  "shape",
]);

/** Shared bounded, read-only symbol navigation. Static matches are hypotheses;
 * only complete SHA-checked source windows are returned as observed evidence. */
export async function navigateImplementation(input: {
  repositoryId: string;
  baseCommitSha: string;
  source: IndexSource;
  description: string;
  candidates?: readonly {
    path: string;
    symbol?: string | null | undefined;
    reason?: string;
    explanation?: string;
  }[];
  graph?: RepositoryRelationGraph;
  signal: AbortSignal;
  maxReads?: number;
  maxSourceBytes?: number;
  maxSnippetBytes?: number;
  maxWindows?: number;
  maxLines?: number;
  onFile?(path: string, content: string): Promise<void>;
}): Promise<NavigationResult> {
  const result: NavigationResult = {
    windows: [],
    missing: [],
    observations: [],
    metrics: {
      reads: 0,
      sourceBytes: 0,
      windows: 0,
      implementationWindows: 0,
      newRelations: 0,
      snippetBytes: 0,
      exitReason: "COMPLETE",
    },
  };
  const signal = input.signal;
  const limits = {
    reads: input.maxReads ?? 8,
    bytes: input.maxSourceBytes ?? 1024 * 1024,
    snippets: input.maxSnippetBytes ?? 10 * 1024,
    windows: input.maxWindows ?? 6,
    lines: input.maxLines ?? 96,
  };
  const signals = extractIssueSignals(input.description);
  const focus = issueSymbolHints(input.description.split("\n")[0] ?? "");
  const candidateNames = (input.candidates ?? []).flatMap((c) =>
    c.symbol && !lexicalCommon.has(c.symbol.toLowerCase()) ? [c.symbol] : [],
  );
  const names = [...new Set([...focus, ...signals.symbols, ...candidateNames])].slice(0, 24);
  const listing = await input.source.manifest(signal);
  const entries = new Map<string, IndexEntry>();
  for (const raw of listing.entries.slice(0, 50_000)) {
    const parsed = EntrySchema.safeParse(raw);
    if (parsed.success && parsed.data.kind === "FILE" && graphPathAllowed(parsed.data.path))
      entries.set(parsed.data.path, parsed.data);
  }
  const graph =
    input.graph ??
    new RepositoryRelationGraph({
      repositoryId: input.repositoryId,
      baseCommitSha: input.baseCommitSha,
      source: input.source,
      maxReadBytes: limits.bytes,
    });
  // Initialize metadata without following arbitrary import branches.
  await graph.inspect([], signal, false);
  const initialEdges = graph.snapshot().edges.length;
  const contentCache = new Map<string, { content: string; digest: string }>();
  const queue: {
    path: string;
    names: string[];
    priority: number;
    depth: number;
    reason: string;
  }[] = [];
  const seen = new Set<string>();
  const basePriority = (path: string) =>
    sourcePathPriority(path, signals) +
    ((entries.get(path)?.sizeBytes ?? 0) > 64 * 1024 && sourceRole(path) === "IMPLEMENTATION"
      ? 12
      : 0);
  const enqueue = (
    path: string,
    requested: string[],
    boost: number,
    depth: number,
    reason: string,
  ) => {
    if (!graphPathAllowed(path) || !codePath(path) || !entries.has(path) || depth > 6) return;
    const key = `${path}:${[...requested].sort().join(",")}`;
    if (seen.has(key)) return;
    const existing = queue.find(
      (q) => q.path === path && [...q.names].sort().join(",") === [...requested].sort().join(","),
    );
    const priority = basePriority(path) + boost - depth * 8;
    if (existing) {
      if (priority > existing.priority) Object.assign(existing, { priority, depth, reason });
      return;
    }
    queue.push({
      path,
      names: [...new Set(requested)].slice(0, 24),
      priority,
      depth,
      reason,
    });
  };
  for (const c of input.candidates ?? []) {
    const candidateBoost =
      (c.symbol && candidateNames.includes(c.symbol)) ||
      sourceRole(c.path) === "ENTRY" ||
      focus.some((n) => normal(n).length >= 8 && normal(c.path).includes(normal(n)))
        ? 35
        : 0;
    if (entries.has(c.path))
      enqueue(
        c.path,
        c.symbol ? [c.symbol, ...names] : names,
        candidateBoost,
        0,
        c.reason ?? c.explanation ?? "Observed candidate",
      );
    else {
      result.observations.push(
        `Missing candidate ${c.path}; alternatives require a new proposal before writing.`,
      );
      const stem = normal(posix.basename(c.path).replace(/\.[^.]+$/u, ""));
      const alternatives = [...entries.keys()]
        .filter((p) => normal(posix.basename(p).replace(/\.[^.]+$/u, "")) === stem)
        .sort((a, b) => basePriority(b) - basePriority(a) || a.localeCompare(b));
      for (const alternative of alternatives.slice(0, 3))
        enqueue(
          alternative,
          c.symbol ? [c.symbol, ...names] : names,
          25,
          0,
          "Observed filename alternative to a missing hypothesis",
        );
      for (let parent = posix.dirname(c.path); parent !== "."; parent = posix.dirname(parent)) {
        if (entries.has(parent + ".ts"))
          enqueue(parent + ".ts", names, 25, 0, "Observed parent implementation file");
      }
    }
  }
  for (const path of signals.paths) enqueue(path, names, 40, 0, "Public Issue path");
  // Repository-wide path/role recall remains bounded and is never an allowlist.
  if (names.length)
    for (const path of [...entries.keys()]
      .filter((p) => codePath(p) && sourceRole(p) === "IMPLEMENTATION")
      .sort((a, b) => basePriority(b) - basePriority(a) || a.localeCompare(b))
      .slice(0, 12))
      enqueue(path, names, 0, 0, "Bounded implementation fallback");
  const addWindow = (
    path: string,
    file: { content: string; digest: string },
    start: number,
    end: number,
    symbol: string | null,
    kind: ImplementationWindow["kind"],
    reason: string,
  ) => {
    if (result.windows.length >= limits.windows) return;
    const lines = file.content.split(/\r?\n/u);
    const startLine = Math.max(1, start),
      last = Math.min(lines.length, end, startLine + limits.lines - 1);
    const selected: string[] = [];
    const remaining = Math.min(4096, limits.snippets - result.metrics.snippetBytes);
    for (let line = startLine; line <= last; line++) {
      const next = [...selected, lines[line - 1]!].join("\n");
      if (Buffer.byteLength(next) > remaining) break;
      selected.push(lines[line - 1]!);
    }
    const snippet = selected.join("\n"),
      endLine = startLine + selected.length - 1;
    if (
      !snippet.trim() ||
      result.windows.some(
        (w) =>
          w.path === path &&
          w.contentHash === file.digest &&
          startLine >= w.startLine &&
          endLine <= w.endLine,
      )
    )
      return;
    result.windows.push({
      path,
      symbol,
      contentHash: file.digest,
      startLine,
      endLine,
      snippet,
      kind,
      reason,
    });
    result.metrics.snippetBytes += Buffer.byteLength(snippet);
  };
  const evidenceTerms = issueSearchTerms(signals).filter(
    (t) => t.length > 3 && !lexicalCommon.has(t),
  );
  for (
    let tasks = 0;
    queue.length && tasks < 40 && result.windows.length < limits.windows;
    tasks++
  ) {
    signal.throwIfAborted();
    const missingFocus = focus.filter(
      (n) =>
        !result.windows.some(
          (w) => w.kind === "IMPLEMENTATION" && w.symbol && matches(w.symbol, n),
        ),
    );
    const priority = (item: (typeof queue)[number]) =>
      item.priority -
      (result.windows.some((w) => w.kind === "IMPLEMENTATION") &&
      missingFocus.length &&
      item.depth &&
      !item.names.some((n) => missingFocus.some((f) => matches(n, f)))
        ? 60
        : 0);
    queue.sort(
      (a, b) => priority(b) - priority(a) || a.depth - b.depth || a.path.localeCompare(b.path),
    );
    const observedName = (name: string) =>
      result.windows.some(
        (w) => w.kind === "IMPLEMENTATION" && w.symbol && matches(w.symbol, name),
      );
    if (
      focus.length &&
      focus.every(observedName) &&
      !queue.some(
        (q) =>
          q.reason.startsWith("Observed symbol forwarding") &&
          q.names.some((n) => !observedName(n)),
      )
    ) {
      result.metrics.exitReason = "EVIDENCE_FOUND";
      break;
    }
    if (result.windows.some((w) => w.kind === "IMPLEMENTATION") && queue[0]!.priority < 35) {
      result.metrics.exitReason = "EVIDENCE_FOUND";
      break;
    }
    const item = queue.shift()!;
    const key = `${item.path}:${[...item.names].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let file = contentCache.get(item.path);
    if (!file) {
      const entry = entries.get(item.path)!;
      if (
        entry.sizeBytes > 512 * 1024 ||
        result.metrics.reads >= limits.reads ||
        result.metrics.sourceBytes + entry.sizeBytes > limits.bytes
      ) {
        result.metrics.exitReason = "SOURCE_BUDGET";
        continue;
      }
      try {
        const current = await input.source.read(item.path, signal);
        result.metrics.reads++;
        result.metrics.sourceBytes += Buffer.byteLength(current.content);
        const digest = hash(current.content);
        if (
          current.truncated ||
          current.content.includes("\0") ||
          Buffer.byteLength(current.content) > 512 * 1024 ||
          result.metrics.sourceBytes > limits.bytes ||
          (entry.contentHash && entry.contentHash !== digest)
        ) {
          throw Error(`Incomplete or stale navigation source: ${item.path}`);
        }
        file = { content: current.content, digest };
        contentCache.set(item.path, file);
        await graph.observe(item.path, current.content, signal);
        await input.onFile?.(item.path, current.content);
      } catch (error) {
        if (signal.aborted || (error instanceof Error && "code" in error)) throw error;
        result.observations.push(
          error instanceof Error ? error.message : `Source unavailable: ${item.path}`,
        );
        continue;
      }
    }
    const node = graph
      .snapshot()
      .files.find((f) => f.path === item.path && f.state === "CURRENT" && f.sha256 === file.digest);
    const parsed = node?.parse;
    if (!parsed || parsed.status !== "PARSED") {
      result.observations.push(
        `No verified AST for ${item.path}; ordinary reads remain available.`,
      );
      continue;
    }
    const resolvedNames = [
      ...new Set([
        ...item.names,
        ...parsed.exports
          .filter((e) => !e.specifier && e.local && item.names.includes(e.name))
          .map((e) => e.local!),
      ]),
    ];
    const desired = item.depth ? resolvedNames : [...new Set([...focus, ...candidateNames])];
    const definitions = parsed.symbols
      .filter(
        (s) =>
          s.implementation &&
          (desired.length ? desired : resolvedNames).some((n) => matches(s.name, n)),
      )
      .sort((a, b) => {
        const score = (s: RelationParse["symbols"][number]) =>
          Math.max(
            ...resolvedNames.map(
              (n, i) => (normal(s.name) === normal(n) ? 100 : matches(s.name, n) ? 60 : 0) - i * 3,
            ),
          );
        return score(b) - score(a) || a.startLine - b.startLine;
      });
    const before = result.windows.length;
    const lines = file.content.split(/\r?\n/u);
    for (const definition of definitions.slice(0, 2)) {
      addWindow(
        item.path,
        file,
        Math.max(1, definition.startLine - 4),
        definition.endLine,
        definition.name,
        implementationKind(item.path),
        `Observed AST ${definition.kind ?? "definition"}; static name relevance only, root cause unverified.`,
      );
      if (definition.endLine - definition.startLine > limits.lines) {
        const hits = lines
          .slice(definition.startLine - 1, definition.endLine)
          .map((line, i) => ({
            line: definition.startLine + i,
            score:
              evidenceTerms.filter((t) => line.toLowerCase().includes(t)).length * 4 +
              (/\b(?:if|throw|return)\b|\.run\s*=/u.test(line) ? 2 : 0),
          }))
          .filter((h) => h.line > definition.startLine + limits.lines && h.score > 2)
          .sort((a, b) => b.score - a.score || a.line - b.line);
        if (hits[0])
          addWindow(
            item.path,
            file,
            Math.max(definition.startLine, hits[0].line - 12),
            Math.min(definition.endLine, hits[0].line + limits.lines - 13),
            definition.name,
            implementationKind(item.path),
            "Behavioral search within the observed definition; requires semantic verification.",
          );
      }
    }
    const observed = result.windows
      .slice(before)
      .map((w) => w.snippet)
      .join("\n");
    const localCalls = [
      ...observed.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(|(\$[A-Za-z_]\w*)\.(?:init|run|parse)\s*\(/gu),
    ]
      .map((m) => m[1] ?? m[2]!)
      .filter((n) => !lexicalCommon.has(n));
    const helper = parsed.symbols.find(
      (s) =>
        s.implementation &&
        (s.kind === "FUNCTION" || s.kind === "METHOD" || s.kind === "CLASS") &&
        localCalls.includes(s.name) &&
        !definitions.includes(s),
    );
    if (helper && result.windows.length - before < 2)
      addWindow(
        item.path,
        file,
        Math.max(1, helper.startLine - 4),
        helper.endLine,
        helper.name,
        implementationKind(item.path),
        "Observed call to a local helper; behavior remains a hypothesis.",
      );
    for (const dependency of parsed.imports.filter(
      (e) => e.resolution === "RESOLVED" && e.resolvedPath,
    )) {
      const wanted: string[] = [];
      let namedForwarding = false;
      for (const binding of dependency.bindings) {
        if (binding.imported === "*")
          wanted.push(
            ...[
              ...observed.matchAll(
                new RegExp(
                  `\\b${binding.local.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.([\\w$]+)`,
                  "gu",
                ),
              ),
            ].map((m) => m[1]!),
          );
        else if (
          item.names.includes(binding.local) ||
          localCalls.includes(binding.local) ||
          new RegExp(
            `(?:^|[^\\w$])${binding.local.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=[^\\w$]|$)`,
            "u",
          ).test(observed)
        )
          wanted.push(binding.imported);
        if (wanted.length) namedForwarding = true;
      }
      for (const exported of parsed.exports.filter((e) => e.specifier === dependency.specifier)) {
        if (exported.name === "*" && exported.local === null) wanted.push(...item.names);
        else if (item.names.includes(exported.name) && exported.local) {
          wanted.push(exported.local);
          namedForwarding = true;
        }
      }
      if (wanted.length)
        enqueue(
          dependency.resolvedPath!,
          wanted,
          namedForwarding ? 45 : 35,
          item.depth + 1,
          `Observed ${namedForwarding ? "symbol forwarding" : "star export"} from ${item.path}:${dependency.line}`,
        );
    }
    if (!definitions.length && !parsed.exports.length)
      result.observations.push(
        `No implementation for requested symbols in ${item.path}; another branch remains eligible.`,
      );
  }
  result.metrics.windows = result.windows.length;
  result.metrics.implementationWindows = result.windows.filter(
    (w) => w.kind === "IMPLEMENTATION",
  ).length;
  result.metrics.newRelations = Math.max(0, graph.snapshot().edges.length - initialEdges);
  for (const name of names.slice(0, 8))
    if (
      !result.windows.some(
        (w) => w.kind === "IMPLEMENTATION" && w.symbol && matches(w.symbol, name),
      )
    )
      result.missing.push(
        `Implementation not observed for ${name}; bounded coverage is not proof of absence.`,
      );
  if (listing.incomplete)
    result.missing.push("Source manifest incomplete; outside-graph reads remain available.");
  if (queue.length && result.metrics.exitReason === "COMPLETE")
    result.metrics.exitReason = "WINDOW_BUDGET";
  return result;
}
