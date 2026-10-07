import { staticSourceLanguage } from "./source-units.js";
import { posix } from "node:path";
import {
  EntrySchema,
  extractIssueSignals,
  hash,
  issueSearchTerms,
  tokens,
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
  parser?: "AST" | "LEXICAL_STATIC";
  completeness?: "COMPLETE_UNIT" | "PARTIAL";
  sourceRole?: "FORWARDER" | "IMPLEMENTATION" | "REFERENCE";
}
export interface NavigationResult {
  windows: ImplementationWindow[];
  relations?: {
    from: string;
    to: string;
    sourceHash: string;
    targetHash: string | null;
    kind: string;
    line: number;
  }[];
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
const codePath = (path: string) =>
  /\.(?:[cm]?[jt]sx?)$/iu.test(path) || staticSourceLanguage(path) !== undefined;
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
    startLine?: number;
    endLine?: number;
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
  /** Planner follow-up: explicit requested files take precedence over another speculative hop. */
  prioritizeCandidates?: boolean;
  behaviorNavigation?: boolean;
  /** SHA-verified earlier projection; reuse behavior names without rereading assertions. */
  observedWindows?: readonly { path: string; snippet: string }[];
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
  const requested = new Set(
    input.prioritizeCandidates
      ? (input.candidates ?? []).map((c) => c.path).filter((p) => entries.has(p))
      : [],
  );
  const pendingRequested = () =>
    [...requested].filter((p) => !result.windows.some((w) => w.path === p));
  const queue: {
    path: string;
    names: string[];
    priority: number;
    depth: number;
    reason: string;
  }[] = [];
  const seen = new Set<string>();
  const publicMembers = new Set<string>();
  for (const row of input.observedWindows ?? []) {
    if (
      !/\.(?:test|spec)\.[^.]+$/u.test(row.path) &&
      !(input.candidates ?? []).some((c) => c.path === row.path)
    )
      continue;
    for (const match of row.snippet.matchAll(/\b(?:this\.)?([#\w$]+)\.([\w$]+)\s*\(/gu))
      if (!/^(?:expect|assert|console|Object|JSON|Array)$/u.test(match[1]!))
        publicMembers.add(match[2]!);
  }
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
        : ["IMPLEMENTATION", "ENTRY"].includes(sourceRole(c.path))
          ? 30
          : 0;
    if (entries.has(c.path)) {
      if (staticSourceLanguage(c.path)) {
        const peers = [...entries.keys()].filter(
          (p) =>
            p !== c.path &&
            posix.basename(p) === posix.basename(c.path) &&
            sourceRole(p) === "IMPLEMENTATION",
        );
        for (const peer of peers.slice(0, 2))
          enqueue(
            peer,
            names,
            40,
            0,
            "Same filename candidate; no confirmed dependency or call edge",
          );
        if (peers.length)
          result.missing.push(
            `Same filename alternatives for ${c.path}: ${peers.slice(0, 2).join(", ")}; relationship unverified.`,
          );
      }
      enqueue(
        c.path,
        c.symbol ? [c.symbol, ...names] : names,
        candidateBoost,
        0,
        c.reason ?? c.explanation ?? "Observed candidate",
      );
    } else {
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
  if (
    (input.behaviorNavigation || input.prioritizeCandidates) &&
    ![...(input.candidates ?? []), ...(input.observedWindows ?? [])].some((c) =>
      /\.(?:test|spec)\.[^.]+$/u.test(c.path),
    )
  ) {
    const tests = [...entries.keys()]
      .filter(
        (p) =>
          sourceRole(p) === "TEST" &&
          (/(?:^|\/)regression\//u.test(p) ||
            issueSearchTerms(signals).some(
              (t) => t.length > 3 && p.toLowerCase().includes(t.toLowerCase()),
            )),
      )
      .sort(
        (a, b) =>
          Number(/(?:^|\/)regression\//u.test(b)) - Number(/(?:^|\/)regression\//u.test(a)) ||
          basePriority(b) - basePriority(a) ||
          a.localeCompare(b),
      )
      .slice(0, 1);
    for (const path of tests)
      enqueue(path, names, 45, 0, "Public behavior test candidate; relation unverified");
  }
  // Repository-wide path/role recall remains bounded and is never an allowlist.
  if (names.length)
    for (const path of [...entries.keys()]
      .filter(
        (p) =>
          codePath(p) &&
          sourceRole(p) === "IMPLEMENTATION" &&
          !/(?:^|\/)(?:third_party|third-party|external|deps)(?:\/|$)/u.test(p),
      )
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
    parser: "AST" | "LEXICAL_STATIC" = "AST",
    forwarding = false,
  ) => {
    // Merge nearby units before spending another window. A local declaration
    // already inside a displayed function is not another useful evidence unit.
    const neighbour = result.windows.find(
      (w) =>
        w.path === path &&
        w.contentHash === file.digest &&
        w.kind === kind &&
        Math.max(w.endLine, end) - Math.min(w.startLine, start) < limits.lines &&
        start <= w.endLine + 8 &&
        end >= w.startLine - 8,
    );
    if (neighbour) {
      const first = Math.min(neighbour.startLine, start);
      const last = Math.max(neighbour.endLine, end);
      const snippet = file.content
        .split(/\r?\n/u)
        .slice(first - 1, last)
        .join("\n");
      const delta = Buffer.byteLength(snippet) - Buffer.byteLength(neighbour.snippet);
      if (result.metrics.snippetBytes + delta <= limits.snippets) {
        Object.assign(neighbour, { startLine: first, endLine: last, snippet });
        result.metrics.snippetBytes += delta;
        return;
      }
    }
    if (result.windows.length >= limits.windows) return;
    const pendingOthers = pendingRequested().filter((p) => p !== path).length;
    if (
      requested.size &&
      result.windows.some((w) => w.path === path) &&
      limits.windows - result.windows.length <= pendingOthers
    )
      return;
    const lines = file.content.split(/\r?\n/u);
    const startLine = Math.max(1, start),
      last = Math.min(lines.length, end, startLine + limits.lines - 1);
    const selected: string[] = [];
    const remaining = Math.max(
      0,
      limits.snippets - result.metrics.snippetBytes - pendingOthers * 128,
    );
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
      parser,
      completeness: startLine <= start && endLine >= end ? "COMPLETE_UNIT" : "PARTIAL",
      sourceRole: forwarding ? "FORWARDER" : kind,
      reason,
    });
    result.metrics.snippetBytes += Buffer.byteLength(snippet);
    if (endLine < end)
      result.missing.push(
        `Unread definition continuation ${path}:${endLine + 1}-${end}; observed prefix is not a complete behavior implementation.`,
      );
  };
  const behaviorSections = [
    ...input.description.matchAll(
      /(?:^|\n)#{1,6}\s*(?:Expected|Observed)[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|$)/giu,
    ),
  ]
    .map((m) => m[1]!)
    .join("\n");
  const behaviorTerms = tokens(behaviorSections, 128).filter(
    (t) => t.length >= 5 && !lexicalCommon.has(t),
  );
  const evidenceTerms = [...new Set([...behaviorTerms, ...issueSearchTerms(signals)])].filter(
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
      item.priority +
      (/\.(?:test|spec)\.[^.]+$/u.test(item.path) ? 1100 : 0) +
      (item.reason.startsWith("Public test dependency") ? 1200 - item.depth * 120 : 0) +
      (requested.has(item.path) && !contentCache.has(item.path) ? 1000 : 0) -
      (staticSourceLanguage(item.path) &&
      result.windows.filter((w) => w.path === item.path).length >= 3 &&
      (input.candidates ?? []).some(
        (c) => c.path !== item.path && entries.has(c.path) && !contentCache.has(c.path),
      )
        ? 200
        : 0) -
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
      !pendingRequested().length &&
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
    if (
      !input.prioritizeCandidates &&
      !pendingRequested().length &&
      result.windows.some((w) => w.kind === "IMPLEMENTATION") &&
      priority(queue[0]!) < 35
    ) {
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
    if (node?.sourceUnit) {
      const unit = node.sourceUnit;
      const wanted = item.names.map((n) => n.split(/\.|::/u).at(-1)!);
      const hint =
        item.depth === 0
          ? input.candidates?.find((c) => c.path === item.path && c.startLine)
          : undefined;
      const terms = [...new Set([...behaviorTerms, ...issueSearchTerms(signals)])].filter(
        (term) => term.length > 3 && !lexicalCommon.has(term),
      );
      const lines = file.content.split("\n");
      const ownerWords = new Set(
        unit.definitions.filter((d) => d.kind === "CLASS").flatMap((d) => tokens(d.name)),
      );
      const score = (d: (typeof unit.definitions)[number]) => {
        const body = lines
          .slice(d.startLine - 1, d.endLine)
          .join("\n")
          .toLowerCase();
        const name = normal(d.name);
        return (
          (wanted.some((n) => matches(d.name, n)) && d.name !== d.qualifier?.split("::").at(-1)
            ? 100
            : wanted.includes(d.qualifier ?? "")
              ? 8
              : 0) +
          behaviorTerms.filter(
            (t) => name.includes(normal(t)) && (!ownerWords.has(t) || name === normal(t)),
          ).length *
            50 +
          terms.filter((t) => name.includes(normal(t).slice(0, 5))).length * 18 +
          Math.min(12, terms.filter((t) => body.includes(t)).length) +
          (hint && d.startLine <= (hint.endLine ?? hint.startLine!) && d.endLine >= hint.startLine!
            ? 4
            : 0) -
          ((/^(?:__init__|to_json|toString|hashCode)$/u.test(d.name) ||
            d.name === d.qualifier?.split("::").at(-1)) &&
          !/constructor|construction|initializ/iu.test(input.description.split("\n")[0] ?? "")
            ? 25
            : 0)
        );
      };
      let definitions = unit.definitions
        .filter((d) => d.implementation && score(d) > 0)
        .sort((a, b) => score(b) - score(a) || a.startLine - b.startLine);
      if (item.depth > 0) {
        const exact = unit.definitions.filter(
          (d) =>
            d.implementation &&
            d.name !== d.qualifier?.split("::").at(-1) &&
            wanted.includes(d.name),
        );
        if (exact.length)
          definitions = exact.sort((a, b) => score(b) - score(a) || a.startLine - b.startLine);
      }
      // Reserve window diversity for the remaining candidate branches. A large definition's
      // critical continuation can still add a second window below.
      const selectedDefinitions = definitions.slice(0, queue.length ? 1 : 2);
      const before = result.windows.length;
      for (const definition of selectedDefinitions) {
        addWindow(
          item.path,
          file,
          definition.startLine,
          definition.endLine,
          definition.name,
          definition.forwarding ? "REFERENCE" : implementationKind(item.path),
          `Observed ${unit.language} lexical definition${definition.forwarding ? " forwarding to another call" : ""}; runtime dispatch and root cause unverified.`,
          "LEXICAL_STATIC",
          definition.forwarding,
        );
        if (definition.endLine - definition.startLine >= limits.lines) {
          const lines = file.content.split("\n");
          const hit = lines
            .map((line, index) => ({
              line: index + 1,
              score: evidenceTerms.filter((t) => line.toLowerCase().includes(t)).length,
            }))
            .filter(
              (h) =>
                h.line > definition.startLine + limits.lines &&
                h.line <= definition.endLine &&
                h.score > 0,
            )
            .sort((a, b) => b.score - a.score)[0];
          if (hit)
            addWindow(
              item.path,
              file,
              Math.max(definition.startLine, hit.line - 12),
              Math.min(definition.endLine, hit.line + limits.lines - 13),
              definition.name,
              implementationKind(item.path),
              "Behavioral branch within a lexical definition; semantic verification required.",
              "LEXICAL_STATIC",
            );
        }
      }
      const observedCalls = selectedDefinitions
        .flatMap((d) => d.calls)
        .filter((c) => !/(?:Error|Exception)$/u.test(c.name) || wanted.includes(c.name));
      for (const dependency of unit.dependencies) {
        const requested = new Set<string>();
        for (const binding of dependency.bindings) {
          if (wanted.includes(binding.local))
            requested.add(binding.imported === "*" ? binding.local : binding.imported);
          for (const call of observedCalls) {
            const receiver = call.receiver
              ? (unit.receivers[call.receiver] ?? call.receiver)
              : null;
            if (
              (!receiver && call.name === binding.local) ||
              receiver === binding.local ||
              receiver?.startsWith(binding.local + ".")
            ) {
              requested.add(call.name);
              if (!receiver && binding.imported !== "*") requested.add(binding.imported);
            }
          }
        }
        if (unit.language === "C++" && dependency.kind === "IMPORT")
          observedCalls.forEach((call) => requested.add(call.name));
        if (dependency.kind === "IMPLEMENTATION_PAIR")
          wanted.forEach((name) => requested.add(name));
        if (!requested.size) continue;
        for (const target of dependency.paths.slice(0, 2))
          enqueue(
            target,
            [...requested],
            55,
            item.depth + 1,
            `Observed symbol forwarding from ${item.path}:${dependency.line}; ${dependency.resolution} ${dependency.provenance}`,
          );
        if (dependency.resolution !== "RESOLVED")
          result.missing.push(
            `${item.path}:${dependency.line} ${dependency.specifier}: ${dependency.resolution}; candidates=${dependency.paths.join(",")}; no definite runtime call edge.`,
          );
      }
      for (const call of observedCalls.filter(
        (c) => !c.receiver || c.receiver === "self" || c.receiver === "this",
      )) {
        if (
          unit.definitions.some(
            (d) => d.implementation && d.name === call.name && !selectedDefinitions.includes(d),
          )
        )
          enqueue(
            item.path,
            [call.name],
            /^\s*return\b/u.test(lines[call.line - 1] ?? "") ? 95 : 65,
            item.depth + 1,
            `Observed symbol forwarding through a local call from ${item.path}:${call.line}; overloads remain candidates`,
          );
      }
      const local = unit.definitions.find(
        (d) =>
          d.implementation &&
          !definitions.includes(d) &&
          observedCalls.some(
            (c) =>
              c.name === d.name && (!c.receiver || c.receiver === "self" || c.receiver === "this"),
          ),
      );
      if (local && !queue.length && result.windows.length - before < 2)
        addWindow(
          item.path,
          file,
          local.startLine,
          local.endLine,
          local.name,
          local.forwarding ? "REFERENCE" : implementationKind(item.path),
          "Observed local call candidate; lexical resolution only.",
          "LEXICAL_STATIC",
          local.forwarding,
        );
      result.observations.push(
        `${item.path}: ${unit.language} ${unit.parser} PARTIAL; ${unit.unknown.slice(0, 2).join(" ")}`,
      );
      if (requested.has(item.path) && !result.windows.some((w) => w.path === item.path))
        addWindow(
          item.path,
          file,
          1,
          Math.min(lines.length, limits.lines),
          null,
          "REFERENCE",
          "Explicit follow-up file; observed text only, no verified behavioral definition.",
          "LEXICAL_STATIC",
        );
      continue;
    }
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
    if (item.reason.startsWith("Public test dependency") || requested.has(item.path))
      desired.push(...publicMembers);
    let definitions = parsed.symbols
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
    const lines = file.content.split(/\r?\n/u);
    if (!definitions.length && requested.has(item.path)) {
      const relevance = (s: RelationParse["symbols"][number]) => {
        const body = lines
          .slice(s.startLine - 1, s.endLine)
          .join("\n")
          .toLowerCase();
        return evidenceTerms.filter((t) => body.includes(t.toLowerCase())).length;
      };
      definitions = parsed.symbols
        .filter((s) => s.implementation && s.kind !== "CLASS" && relevance(s) > 0)
        .sort((a, b) => relevance(b) - relevance(a) || a.startLine - b.startLine);
    }
    const assertionFile =
      /\.(?:test|spec)\.[^.]+$/u.test(item.path) && lines.length <= limits.lines;
    if (assertionFile)
      addWindow(
        item.path,
        file,
        1,
        lines.length,
        null,
        "REFERENCE",
        "Public test assertions and imports; expectations must be checked against the Issue.",
      );
    const methods = definitions.filter((d) => d.kind === "METHOD");
    if (methods.length) definitions = methods;
    for (const definition of assertionFile
      ? []
      : definitions.slice(0, methods.length ? limits.windows : 2)) {
      addWindow(
        item.path,
        file,
        Math.max(1, definition.startLine - 4),
        definition.endLine,
        definition.name,
        implementationKind(item.path),
        `Observed AST ${definition.kind ?? "definition"}; ${item.reason}; static relevance only, root cause unverified.`,
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
    // Establish the displayed fallback BEFORE deriving calls/imports from it. Public
    // tests commonly have no named AST definition but contain the best entry points.
    if (
      (requested.has(item.path) || sourceRole(item.path) === "TEST") &&
      !result.windows.some((w) => w.path === item.path)
    ) {
      const hit =
        sourceRole(item.path) === "TEST" && lines.length > limits.lines
          ? lines.findIndex(
              (line) =>
                !/^\s*(?:\/\/|import\b)/u.test(line) &&
                resolvedNames.some((name) => line.includes(name)),
            )
          : -1;
      const start = hit < 0 ? 1 : Math.max(1, hit - 8);
      addWindow(
        item.path,
        file,
        start,
        Math.min(lines.length, start + limits.lines - 1),
        null,
        "REFERENCE",
        "Public source entry observed; resolved imports guide investigation, not write authority.",
      );
    }
    const observed = result.windows
      .filter((w) => w.path === item.path)
      .map((w) => w.snippet)
      .join("\n");
    const localCalls = [
      ...observed.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(|(\$[A-Za-z_]\w*)\.(?:init|run|parse)\s*\(/gu),
    ]
      .map((m) => m[1] ?? m[2]!)
      .filter((n) => !lexicalCommon.has(n));
    if (assertionFile) {
      for (const match of observed.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/gu)) {
        // Assertion library members are expectations, not repository entry points.
        if (!/^(?:expect|assert|console|Object|JSON|Array)$/u.test(match[1]!))
          publicMembers.add(match[2]!);
      }
    }
    const receiverTypes = new Set<string>();
    if (item.reason.startsWith("Public test dependency") || requested.has(item.path)) {
      for (const call of observed.matchAll(/this\.([#\w$]+)\.([\w$]+)\s*\(/gu)) {
        publicMembers.add(call[2]!);
        const receiver = call[1]!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        const declaration = file.content.match(
          new RegExp(`${receiver}\\s*(?:[!?]?\\s*:\\s*|=\\s*new\\s+)([\\w$]+)`, "u"),
        );
        if (declaration) receiverTypes.add(declaration[1]!);
      }
    }
    const helper = parsed.symbols.find(
      (s) =>
        s.implementation &&
        (s.kind === "FUNCTION" ||
          s.kind === "METHOD" ||
          s.kind === "CLASS" ||
          s.kind === "VARIABLE") &&
        (localCalls.includes(s.name) ||
          (s.kind === "VARIABLE" &&
            new RegExp(
              `(?:^|[^\\w$])${s.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=[^\\w$]|$)`,
              "u",
            ).test(observed))) &&
        !definitions.includes(s) &&
        !parsed.symbols.some(
          (owner) =>
            owner !== s &&
            owner.implementation &&
            owner.startLine <= s.startLine &&
            owner.endLine >= s.endLine &&
            (owner.startLine < s.startLine || owner.endLine > s.endLine),
        ) &&
        !result.windows.some(
          (w) => w.path === item.path && w.startLine <= s.startLine && w.endLine >= s.endLine,
        ),
    );
    if (helper)
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
      (e) => e.resolution === "RESOLVED" && e.resolvedPath && !e.typeOnly,
    )) {
      const wanted: string[] = [];
      let namedForwarding = false;
      for (const binding of dependency.bindings) {
        if (binding.typeOnly) continue;
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
          receiverTypes.has(binding.local) ||
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
        if (exported.name === "*" && exported.local === null)
          wanted.push(
            ...item.names.filter(
              (name) =>
                !parsed.exports.some(
                  (e) => e.name === name && e.specifier !== dependency.specifier,
                ),
            ),
          );
        else if (item.names.includes(exported.name) && exported.local) {
          wanted.push(exported.local);
          namedForwarding = true;
        }
      }
      if (wanted.length)
        enqueue(
          dependency.resolvedPath!,
          wanted,
          dependency.bindings.some((b) => receiverTypes.has(b.local))
            ? 75
            : namedForwarding
              ? 45
              : 35,
          item.depth + 1,
          sourceRole(item.path) === "TEST" || item.reason.startsWith("Public test dependency")
            ? `Public test dependency from ${item.path}:${dependency.line}`
            : `Observed ${namedForwarding ? "symbol forwarding" : "star export"} from ${item.path}:${dependency.line}`,
        );
    }
    if (requested.has(item.path) && !result.windows.some((w) => w.path === item.path))
      addWindow(
        item.path,
        file,
        1,
        Math.min(lines.length, limits.lines),
        null,
        "REFERENCE",
        "Explicit requested entry/declaration observed; follow resolved dependencies for implementation.",
      );
    if (!definitions.length && !parsed.exports.length)
      result.observations.push(
        `No implementation for requested symbols in ${item.path}; another branch remains eligible.`,
      );
  }
  // A definition alone does not establish the behavior of its consumers.
  // Prefer observed reverse edges; a small lexical search is only a hypothesis.
  const anchors = result.windows.filter((w) => w.kind === "IMPLEMENTATION" && w.symbol).slice(0, 4);
  const anchorPaths = new Set(anchors.map((w) => w.path));
  const incoming = graph
    .snapshot()
    .edges.filter(
      (e) =>
        !e.stale &&
        e.resolution === "RESOLVED" &&
        e.to &&
        anchorPaths.has(e.to) &&
        !anchorPaths.has(e.from),
    );
  const consumerPaths = [
    ...new Set([
      ...incoming.map((e) => e.from),
      ...[...entries.keys()]
        .filter(
          (p) =>
            codePath(p) &&
            !anchorPaths.has(p) &&
            !graph
              .snapshot()
              .edges.some(
                (e) => !e.stale && e.kind === "REEXPORT" && e.to === p && !anchorPaths.has(e.to),
              ) &&
            sourceRole(p) === "IMPLEMENTATION" &&
            (anchors.some((a) => posix.dirname(a.path) === posix.dirname(p)) ||
              issueSearchTerms(signals).some(
                (t) =>
                  t.length > 3 &&
                  !lexicalCommon.has(t) &&
                  p.toLowerCase().includes(t.toLowerCase()),
              )),
        )
        .sort((a, b) => basePriority(b) - basePriority(a) || a.localeCompare(b))
        .slice(0, 4),
    ]),
  ];
  let consumerReads = 0;
  for (const path of consumerPaths) {
    if (!anchors.length || consumerReads >= 2) break;
    let current = contentCache.get(path);
    const entry = entries.get(path);
    if (!entry) continue;
    if (!current) {
      if (
        result.metrics.reads >= limits.reads ||
        entry.sizeBytes > 512 * 1024 ||
        result.metrics.sourceBytes + entry.sizeBytes > limits.bytes
      )
        break;
      const read = await input.source.read(path, signal);
      consumerReads++;
      result.metrics.reads++;
      result.metrics.sourceBytes += Buffer.byteLength(read.content);
      if (
        read.truncated ||
        read.content.includes("\0") ||
        Buffer.byteLength(read.content) > 512 * 1024 ||
        result.metrics.sourceBytes > limits.bytes ||
        (entry.contentHash && entry.contentHash !== hash(read.content))
      )
        continue;
      current = { content: read.content, digest: hash(read.content) };
      contentCache.set(path, current);
      await graph.observe(path, read.content, signal);
      await input.onFile?.(path, read.content);
    }
    const consumer = graph
      .snapshot()
      .files.find((f) => f.path === path && f.sha256 === current!.digest);
    const hasImportRelation =
      consumer?.parse?.imports.some((e) => e.resolvedPath && anchorPaths.has(e.resolvedPath)) ??
      false;
    if (consumer?.parse?.status === "PARSED" && !hasImportRelation) continue;
    const aliases =
      consumer?.parse?.imports
        .filter((e) => e.resolvedPath && anchorPaths.has(e.resolvedPath))
        .flatMap((e) => e.bindings.map((b) => b.local)) ?? [];
    const terms = [...anchors.map((a) => a.symbol!), ...aliases];
    const lines = current.content.split("\n");
    const hit = lines.findIndex(
      (line) =>
        !/^\s*(?:import|export\s+.*from)\b/u.test(line) &&
        terms.some((t) =>
          new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u").test(line),
        ),
    );
    if (hit < 0) continue;
    const definition = consumer?.parse?.symbols
      .filter((s) => s.kind !== "CLASS")
      .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))
      .find((s) => s.implementation && s.startLine <= hit + 1 && s.endLine >= hit + 1);
    if (result.windows.length >= limits.windows) {
      const redundant = result.windows.findLastIndex(
        (w) =>
          w.reason.startsWith("Observed call to a local helper") &&
          result.windows.some((other) => other !== w && other.path === w.path),
      );
      if (redundant < 0) break;
      result.metrics.snippetBytes -= Buffer.byteLength(result.windows[redundant]!.snippet);
      result.windows.splice(redundant, 1);
    }
    addWindow(
      path,
      current,
      definition?.startLine ?? Math.max(1, hit - 4),
      definition?.endLine ?? hit + 12,
      definition?.name ?? null,
      "REFERENCE",
      `Consumer reference to ${anchors.map((a) => a.symbol).join(", ")}; ${hasImportRelation ? "resolved import" : "bounded lexical match"}; behavior relation remains unverified.`,
      consumer?.parse?.status === "PARSED" ? "AST" : "LEXICAL_STATIC",
    );
  }
  if (anchors.length && !result.windows.some((w) => w.reason.startsWith("Consumer reference")))
    result.missing.push(
      "Consumers of observed definitions remain unverified; use bounded reference search when required by Issue behavior.",
    );
  result.metrics.windows = result.windows.length;
  result.metrics.implementationWindows = result.windows.filter(
    (w) => w.kind === "IMPLEMENTATION",
  ).length;
  result.metrics.newRelations = Math.max(0, graph.snapshot().edges.length - initialEdges);
  const snapshot = graph.snapshot();
  result.relations = snapshot.edges
    .filter((e) => !e.stale && e.to && e.resolution === "RESOLVED")
    .slice(0, 32)
    .map((e) => ({
      from: e.from,
      to: e.to!,
      sourceHash: e.sourceSha256,
      targetHash:
        snapshot.files.find((f) => f.path === e.to && f.state === "CURRENT")?.sha256 ?? null,
      kind: e.kind,
      line: e.line,
    }));
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
  result.missing = [...new Set(result.missing)].slice(0, 32);
  return result;
}
