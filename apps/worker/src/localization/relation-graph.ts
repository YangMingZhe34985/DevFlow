import { posix } from "node:path";
import ts from "typescript";
import { z } from "zod";
import {
  exclusionReason,
  hash,
  isTestFile,
  type IndexEntry,
  type IndexSource,
} from "./contracts.js";
import { workspacePackages } from "./workspace-packages.js";
import {
  parseRelations,
  RELATION_PARSER_VERSION,
  RelationParseSchema,
  type RelationParse,
} from "./relation-parser.js";

export const GRAPH_VERSION = "repository-relations-v1";
const CONFIG = {
  maxFiles: 32,
  maxReadBytes: 2 * 1024 * 1024,
  maxMetadata: 32,
  maxFileBytes: 512 * 1024,
  depth: 2,
  factsVersion: 2,
};
export function graphPathAllowed(path: string) {
  return (
    exclusionReason(path) === undefined &&
    !/(?:^|\/)(?:\.devflow[^/]*|hidden-acceptance|hidden-tests?)(?:\/|$)/i.test(path) &&
    ![...path].some((c) => c.charCodeAt(0) < 32) &&
    !/[:*?]/.test(path) &&
    posix.normalize(path) === path
  );
}
const codeFile = (path: string) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path);
const fileType = (path: string) =>
  isTestFile(path) ? "TEST" : codeFile(path) ? "SOURCE" : "CONFIG";
const FileSchema = z.object({
  path: z.string(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  state: z.enum(["CURRENT", "STALE", "UNREAD", "UNAVAILABLE"]),
  fileType: z.string(),
  parse: RelationParseSchema.nullable(),
});
const EdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  kind: z.enum(["IMPORT", "REEXPORT", "DYNAMIC_IMPORT", "REQUIRE"]),
  specifier: z.string().nullable(),
  line: z.number(),
  sourceSha256: z.string(),
  configurationHash: z.string(),
  resolution: z.enum(["RESOLVED", "EXTERNAL", "UNRESOLVED", "DYNAMIC"]),
  reason: z.string(),
  stale: z.boolean(),
});
export const RelationGraphSchema = z.object({
  version: z.literal(GRAPH_VERSION),
  parserVersion: z.literal(RELATION_PARSER_VERSION),
  repositoryId: z.string(),
  baseCommitSha: z.string(),
  sourceIdentity: z.string().nullable(),
  workspaceRevision: z.number().int().nonnegative(),
  manifestHash: z.string(),
  configurationHash: z.string(),
  configHash: z.string(),
  files: z.array(FileSchema).max(2000),
  edges: z.array(EdgeSchema).max(16000),
  packages: z.array(
    z.object({
      path: z.string(),
      name: z.string().nullable(),
      sha256: z.string(),
      dependencies: z.array(z.object({ name: z.string(), kind: z.string() })).default([]),
    }),
  ),
  moduleEdges: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        kind: z.string(),
        sourcePath: z.string(),
        sourceSha256: z.string(),
        sourceLine: z.number().nullable(),
      }),
    )
    .max(32000)
    .default([]),
  coverage: z.object({
    manifestFiles: z.number(),
    parsedFiles: z.number(),
    incomplete: z.boolean(),
    reasons: z.array(z.string()),
  }),
  cycles: z.array(z.array(z.string())),
  baselineSha256: z.string().nullable(),
  invalidatedPaths: z.array(z.string()),
  metrics: z.object({
    wallMs: z.number(),
    readBytes: z.number(),
    reads: z.number(),
    cacheHits: z.number(),
    coldParses: z.number(),
  }),
});
export type RelationGraphArtifact = z.infer<typeof RelationGraphSchema>;
/** Facts identity excludes timing/cache counters; the persisted artifact also has its full content SHA. */
export const relationGraphDigest = (graph: RelationGraphArtifact) => {
  const { metrics: _metrics, ...facts } = graph;
  return hash(JSON.stringify(facts));
};
export interface IssueGraphReference {
  version: "issue-local-graph-v1";
  repositoryId: string;
  baseCommitSha: string;
  workspaceRevision: number;
  graphSha256: string;
  artifactId?: string;
  seeds: string[];
  candidatePaths: string[];
  relatedTests: string[];
  files: {
    path: string;
    sha256: string | null;
    state: string;
    symbols: { id: string; name: string; startLine: number; endLine: number }[];
    exports: RelationParse["exports"];
  }[];
  relations: { from: string; to: string | null; kind: string; resolution: string; line: number }[];
  hypotheses: { explanation: string; evidenceId: string; status: "CANDIDATE" }[];
  incomplete: boolean;
  viewTruncated: boolean;
  stale: boolean;
  limitations: string[];
}
const cache = new Map<string, RelationParse>();

/** A partial static file/package/export graph. It never claims a runtime call graph or root cause. */
export class RepositoryRelationGraph {
  private manifest = new Map<string, IndexEntry>();
  private configuration: Record<string, string> = {};
  private artifact: RelationGraphArtifact;
  private started = Date.now();
  private initialized = false;
  constructor(
    private readonly input: {
      repositoryId: string;
      baseCommitSha: string;
      source: IndexSource;
      workspaceRevision?: number;
      onRead?(bytes: number): Promise<void>;
      maxReadBytes?: number;
      baseline?: RelationGraphArtifact;
    },
  ) {
    const baseline = input.baseline && RelationGraphSchema.parse(input.baseline);
    if (
      baseline &&
      (baseline.repositoryId !== input.repositoryId ||
        baseline.baseCommitSha !== input.baseCommitSha)
    )
      throw new Error("Graph baseline identity mismatch");
    this.artifact = baseline
      ? structuredClone(baseline)
      : {
          version: GRAPH_VERSION,
          parserVersion: RELATION_PARSER_VERSION,
          repositoryId: input.repositoryId,
          baseCommitSha: input.baseCommitSha,
          sourceIdentity: input.source.identity ?? null,
          workspaceRevision: input.workspaceRevision ?? 0,
          manifestHash: "",
          configurationHash: "",
          configHash: hash(JSON.stringify(CONFIG)),
          files: [],
          edges: [],
          packages: [],
          moduleEdges: [],
          cycles: [],
          baselineSha256: null,
          invalidatedPaths: [],
          coverage: { manifestFiles: 0, parsedFiles: 0, incomplete: true, reasons: [] },
          metrics: { wallMs: 0, readBytes: 0, reads: 0, cacheHits: 0, coldParses: 0 },
        };
    if (baseline) {
      this.artifact.baselineSha256 = hash(JSON.stringify(baseline));
      this.artifact.metrics = { wallMs: 0, reads: 0, readBytes: 0, cacheHits: 0, coldParses: 0 };
      this.invalidate([], input.workspaceRevision ?? baseline.workspaceRevision + 1, true);
    }
    this.artifact.sourceIdentity = input.source.identity ?? null;
    this.artifact.configHash = hash(
      JSON.stringify({ ...CONFIG, maxReadBytes: input.maxReadBytes ?? CONFIG.maxReadBytes }),
    );
  }
  private reason(message: string) {
    if (!this.artifact.coverage.reasons.includes(message))
      this.artifact.coverage.reasons.push(message);
  }
  async initialize(signal: AbortSignal) {
    if (this.initialized) return;
    signal.throwIfAborted();
    let manifest: Awaited<ReturnType<IndexSource["manifest"]>>;
    try {
      manifest = await this.input.source.manifest(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      manifest = { entries: [], incomplete: true };
      this.reason("Graph manifest unavailable; ordinary evidence reads remain available");
    }
    this.manifest = new Map(
      manifest.entries
        .filter((e) => e.kind === "FILE" && graphPathAllowed(e.path))
        .map((e) => [e.path, e]),
    );
    this.artifact.manifestHash = hash(
      JSON.stringify([...this.manifest.values()].sort((a, b) => a.path.localeCompare(b.path))),
    );
    this.artifact.coverage.manifestFiles = this.manifest.size;
    if (manifest.incomplete)
      this.reason("Manifest incomplete; absence is not proof of a missing file");
    this.configuration = {};
    const metadata = [...this.manifest.keys()]
      .filter((p) =>
        /(?:^|\/)(?:(?:tsconfig|jsconfig)[^/]*\.json|package\.json|pnpm-workspace\.yaml)$/.test(p),
      )
      .sort();
    if (metadata.length > CONFIG.maxMetadata)
      this.reason(
        "Metadata budget reached; some package/configuration relationships are unresolved",
      );
    const queue = metadata.slice(0, CONFIG.maxMetadata),
      seen = new Set<string>();
    this.artifact.packages = [];
    while (queue.length && seen.size < CONFIG.maxMetadata) {
      const path = queue.shift()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const content = await this.read(path, signal, 64 * 1024);
      if (content === undefined) continue;
      this.configuration[path] = content;
      if (path.endsWith("package.json")) {
        try {
          const pkg = JSON.parse(content) as Record<string, unknown>;
          this.artifact.packages.push({
            path,
            name: typeof pkg.name === "string" ? pkg.name : null,
            sha256: hash(content),
            dependencies: [
              "dependencies",
              "devDependencies",
              "peerDependencies",
              "optionalDependencies",
            ]
              .flatMap((kind) =>
                typeof pkg[kind] === "object" && pkg[kind] !== null
                  ? Object.keys(pkg[kind])
                      .slice(0, 200)
                      .map((name) => ({ name, kind }))
                  : [],
              )
              .slice(0, 200),
          });
        } catch {
          this.reason(`Invalid package metadata: ${path}`);
        }
      } else if (path.endsWith(".json")) {
        const parsed = ts.parseConfigFileTextToJson(path, content);
        const extensions = parsed.config?.extends as unknown;
        for (const ext of typeof extensions === "string"
          ? [extensions]
          : Array.isArray(extensions)
            ? extensions
            : [])
          if (typeof ext === "string" && ext.startsWith(".")) {
            const target = posix.normalize(
              posix.join(posix.dirname(path), ext.endsWith(".json") ? ext : ext + ".json"),
            );
            if (graphPathAllowed(target) && this.manifest.has(target)) queue.push(target);
            else this.reason(`Unresolved compiler configuration: ${path}`);
          }
      }
    }
    if (queue.length) this.reason("Compiler configuration traversal incomplete");
    this.artifact.packages = [...new Map(this.artifact.packages.map((p) => [p.path, p])).values()];
    this.artifact.configurationHash = hash(
      JSON.stringify(Object.entries(this.configuration).sort()),
    );
    this.initialized = true;
  }
  private async read(
    path: string,
    signal: AbortSignal,
    cap = CONFIG.maxFileBytes,
  ): Promise<string | undefined> {
    const entry = this.manifest.get(path);
    if (
      !entry ||
      entry.sizeBytes > cap ||
      this.artifact.metrics.readBytes + entry.sizeBytes >
        (this.input.maxReadBytes ?? CONFIG.maxReadBytes)
    ) {
      this.reason(`File unavailable within graph read budget: ${path}`);
      return undefined;
    }
    try {
      const file = await this.input.source.read(path, signal);
      const size = Buffer.byteLength(file.content);
      this.artifact.metrics.readBytes += size;
      this.artifact.metrics.reads++;
      await this.input.onRead?.(size);
      if (
        file.truncated ||
        size > cap ||
        this.artifact.metrics.readBytes > (this.input.maxReadBytes ?? CONFIG.maxReadBytes) ||
        (entry.contentHash && hash(file.content) !== entry.contentHash)
      ) {
        this.reason(`Truncated/stale graph source: ${path}`);
        return undefined;
      }
      return file.content;
    } catch (error) {
      if (signal.aborted || (error instanceof Error && "code" in error)) throw error;
      this.reason(`Graph source unreadable: ${path}`);
      return undefined;
    }
  }
  async inspect(paths: readonly string[], signal: AbortSignal, expand = true) {
    await this.initialize(signal);
    const queue = [...new Set(paths)].filter(graphPathAllowed).map((path) => ({ path, depth: 0 })),
      seen = new Set<string>();
    while (
      queue.length &&
      this.artifact.metrics.coldParses + this.artifact.metrics.cacheHits < CONFIG.maxFiles
    ) {
      signal.throwIfAborted();
      const { path, depth } = queue.shift()!;
      if (seen.has(path) || !codeFile(path)) continue;
      seen.add(path);
      const existing = this.artifact.files.find((f) => f.path === path);
      if (existing?.state !== "CURRENT") {
        const content = await this.read(path, signal);
        if (content !== undefined) await this.observe(path, content, signal);
        else
          this.upsert({
            path,
            sha256: null,
            state: "UNAVAILABLE",
            fileType: fileType(path),
            parse: null,
          });
      }
      if (expand && depth < CONFIG.depth)
        for (const edge of this.artifact.edges.filter((e) => e.from === path && !e.stale && e.to))
          queue.push({ path: edge.to!, depth: depth + 1 });
    }
    if (queue.length)
      this.reason("Local graph expansion budget reached; outside-graph reads remain allowed");
    this.updateCoverage();
  }
  private upsert(file: RelationGraphArtifact["files"][number]) {
    this.artifact.files = this.artifact.files.filter((f) => f.path !== file.path);
    this.artifact.files.push(file);
  }
  async observe(path: string, content: string, signal: AbortSignal) {
    if (!graphPathAllowed(path) || !codeFile(path)) return;
    await this.initialize(signal);
    const sha256 = hash(content);
    if (
      this.artifact.files.some(
        (f) => f.path === path && f.sha256 === sha256 && f.state === "CURRENT",
      )
    )
      return;
    if (this.artifact.metrics.coldParses + this.artifact.metrics.cacheHits >= CONFIG.maxFiles) {
      this.reason("Graph parse budget reached");
      return;
    }
    this.manifest.set(path, {
      path,
      kind: "FILE",
      sizeBytes: Buffer.byteLength(content),
      contentHash: sha256,
    });
    const configPath = Object.keys(this.configuration)
      .filter(
        (p) =>
          /(?:^|\/)(?:tsconfig|jsconfig)\.json$/.test(p) &&
          (posix.dirname(p) === "." || path.startsWith(posix.dirname(p) + "/")),
      )
      .sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
    const key = hash(
      `${this.input.repositoryId}:${this.artifact.manifestHash}:${this.artifact.configurationHash}:${path}:${sha256}:${RELATION_PARSER_VERSION}`,
    );
    let parsed = cache.get(key);
    try {
      if (parsed) this.artifact.metrics.cacheHits++;
      else {
        parsed = await parseRelations(
          {
            path,
            content,
            paths: [...this.manifest.keys()],
            configuration: this.configuration,
            ...(configPath ? { configPath } : {}),
          },
          signal,
        );
        this.artifact.metrics.coldParses++;
        if (cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(key, parsed);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      this.reason(`Relation parsing failed: ${path}`);
      this.upsert({ path, sha256, state: "UNAVAILABLE", fileType: fileType(path), parse: null });
      return;
    }
    this.upsert({
      path,
      sha256,
      state: "CURRENT",
      fileType: fileType(path),
      parse: structuredClone(parsed),
    });
    this.artifact.edges = this.artifact.edges.filter((e) => e.from !== path);
    if (parsed.status === "PARSED")
      for (const row of parsed.imports) {
        const to = row.resolvedPath && graphPathAllowed(row.resolvedPath) ? row.resolvedPath : null;
        this.artifact.edges.push({
          id: hash(`${path}:${sha256}:${row.kind}:${row.line}:${row.specifier}`),
          from: path,
          to,
          kind: row.kind,
          specifier: row.specifier,
          line: row.line,
          sourceSha256: sha256,
          configurationHash: this.artifact.configurationHash,
          resolution: to
            ? "RESOLVED"
            : row.resolution === "RESOLVED"
              ? "UNRESOLVED"
              : row.resolution,
          reason: row.reason,
          stale: false,
        });
        if (to && !this.artifact.files.some((f) => f.path === to))
          this.upsert({
            path: to,
            sha256: null,
            state: "UNREAD",
            fileType: fileType(to),
            parse: null,
          });
      }
    else this.reason(`Parse error; dependencies are not promoted to facts: ${path}`);
    if (parsed.configurationErrors.length)
      this.reason(`Compiler configuration incomplete: ${path}`);
    if (parsed.truncated) this.reason(`Relations truncated: ${path}`);
    this.updateCoverage();
  }
  invalidate(paths: readonly string[], revision: number, all = false) {
    this.artifact.workspaceRevision = revision;
    const changed = new Set(paths);
    const configurationChanged = paths.some((p) => /\.json$/.test(p));
    const affected = new Set(paths);
    let progress = true;
    while (progress) {
      progress = false;
      for (const edge of this.artifact.edges)
        if (edge.to && affected.has(edge.to) && !affected.has(edge.from)) {
          affected.add(edge.from);
          progress = true;
        }
    }
    for (const file of this.artifact.files)
      if (all || configurationChanged || affected.has(file.path)) file.state = "STALE";
    for (const edge of this.artifact.edges)
      if (
        all ||
        configurationChanged ||
        affected.has(edge.from) ||
        (edge.to && changed.has(edge.to))
      )
        edge.stale = true;
    this.artifact.invalidatedPaths = [
      ...new Set([...this.artifact.invalidatedPaths, ...affected]),
    ].slice(0, 2000);
    if (configurationChanged || all) {
      this.configuration = {};
      this.artifact.packages = [];
    }
    // observe() caches full content hashes. Refresh the manifest before reading
    // after a mutation so new bytes are checked against the current workspace.
    this.initialized = false;
    this.reason(
      "Graph overlay invalidated after workspace change; stale relations are excluded from model views",
    );
    this.updateCoverage();
  }
  private updateCoverage() {
    const owner = (path: string) =>
      this.artifact.packages
        .filter(
          (pkg) =>
            posix.dirname(pkg.path) === "." || path.startsWith(posix.dirname(pkg.path) + "/"),
        )
        .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? "repository";
    const moduleEdges: RelationGraphArtifact["moduleEdges"] = [];
    const workspaces = workspacePackages(this.configuration);
    for (const pkg of this.artifact.packages) {
      let declarations: Record<string, Record<string, unknown>> = {};
      try {
        declarations = JSON.parse(this.configuration[pkg.path] ?? "{}");
      } catch {
        // Only captured, valid metadata can establish a workspace target.
      }
      for (const dep of pkg.dependencies) {
        const specifier = declarations[dep.kind]?.[dep.name];
        let to = `external:${dep.name}`;
        if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
          const range = specifier.slice("workspace:".length);
          const alias = /^((?:@[\w.-]+\/)?[\w.-]+)@(.+)$/.exec(range);
          const name = alias?.[1] ?? dep.name;
          const relative = range.startsWith(".")
            ? posix.normalize(posix.join(posix.dirname(pkg.path), range, "package.json"))
            : undefined;
          const targets = workspaces.filter((p) =>
            relative ? p.path === relative : p.name === name,
          );
          if (targets.length === 1) to = targets[0]!.path;
          else {
            to = `unresolved:${dep.name}`;
            this.reason(
              `Workspace dependency ${targets.length ? "ambiguous" : "unavailable"}: ${pkg.path} -> ${dep.name}`,
            );
          }
        }
        moduleEdges.push({
          from: pkg.path,
          to,
          kind: `DECLARED_${dep.kind}`,
          sourcePath: pkg.path,
          sourceSha256: pkg.sha256,
          sourceLine: null,
        });
      }
    }
    for (const edge of this.artifact.edges)
      if (!edge.stale) {
        const from = owner(edge.from),
          to = edge.to
            ? owner(edge.to)
            : edge.resolution === "EXTERNAL" && edge.specifier
              ? `external:${edge.specifier.startsWith("@") ? edge.specifier.split("/").slice(0, 2).join("/") : edge.specifier.split("/")[0]}`
              : null;
        if (to && to !== from)
          moduleEdges.push({
            from,
            to,
            kind: `STATIC_${edge.kind}`,
            sourcePath: edge.from,
            sourceSha256: edge.sourceSha256,
            sourceLine: edge.line,
          });
      }
    this.artifact.moduleEdges = moduleEdges.slice(0, 32000);
    this.artifact.coverage.parsedFiles = this.artifact.files.filter(
      (f) => f.state === "CURRENT" && f.parse?.status === "PARSED",
    ).length;
    this.artifact.coverage.incomplete =
      this.artifact.coverage.reasons.length > 0 ||
      this.artifact.coverage.parsedFiles < [...this.manifest.keys()].filter(codeFile).length;
    const adjacency = new Map<string, string[]>();
    for (const edge of this.artifact.edges)
      if (!edge.stale && edge.to)
        adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    const cycles: string[][] = [],
      visited = new Set<string>(),
      stack: string[] = [];
    const visit = (path: string) => {
      const idx = stack.indexOf(path);
      if (idx >= 0) {
        const cycle = stack.slice(idx);
        if (
          cycles.length < 32 &&
          !cycles.some((c) => c.length === cycle.length && c.every((p) => cycle.includes(p)))
        )
          cycles.push(cycle);
        return;
      }
      if (visited.has(path) || stack.length > 64) return;
      visited.add(path);
      stack.push(path);
      for (const next of adjacency.get(path) ?? []) visit(next);
      stack.pop();
    };
    for (const path of adjacency.keys()) visit(path);
    this.artifact.cycles = cycles;
    this.artifact.metrics.wallMs = Date.now() - this.started;
  }
  snapshot(): RelationGraphArtifact {
    this.updateCoverage();
    return structuredClone(this.artifact);
  }
  issueView(
    seeds: string[],
    candidates: { path: string; explanation: string; evidenceId?: string }[] = [],
    maxBytes = 8192,
    symbolNames: readonly string[] = [],
  ): IssueGraphReference {
    const graph = this.snapshot();
    const matchesSymbol = (name: string) =>
      !symbolNames.length ||
      symbolNames.some((requested) => name === requested || name === `$${requested}`);
    let viewTruncated = false;
    const limit = <T>(rows: T[], maximum: number): T[] => {
      if (rows.length > maximum) viewTruncated = true;
      return rows.slice(0, maximum);
    };
    const chosen = new Set([...seeds, ...candidates.map((c) => c.path)]);
    const relations = limit(
      graph.edges.filter((e) => !e.stale && (chosen.has(e.from) || (e.to && chosen.has(e.to)))),
      20,
    );
    const view: IssueGraphReference = {
      version: "issue-local-graph-v1",
      repositoryId: graph.repositoryId,
      baseCommitSha: graph.baseCommitSha,
      workspaceRevision: graph.workspaceRevision,
      graphSha256: relationGraphDigest(graph),
      seeds: limit([...new Set(seeds)].filter(graphPathAllowed), 16),
      candidatePaths: limit(
        candidates.map((c) => c.path),
        8,
      ),
      relatedTests: limit(
        graph.files
          .filter((f) => f.fileType === "TEST" && f.state === "CURRENT")
          .map((f) => f.path),
        8,
      ),
      files: limit(
        graph.files.filter(
          (f) =>
            f.state === "CURRENT" && (chosen.has(f.path) || relations.some((e) => e.to === f.path)),
        ),
        8,
      ).map((f) => ({
        path: f.path,
        sha256: f.sha256,
        state: f.state,
        symbols: limit(
          (f.parse?.symbols ?? []).filter((s) => matchesSymbol(s.name)),
          20,
        ).map((s) => ({
          id: hash(`${f.path}:${f.sha256}:${s.offset}:${s.name}`),
          name: s.name,
          startLine: s.startLine,
          endLine: s.endLine,
        })),
        exports: limit(
          (f.parse?.exports ?? []).filter((e) => matchesSymbol(e.name)),
          20,
        ),
      })),
      relations: relations.map((e) => ({
        from: e.from,
        to: e.to,
        kind: e.kind,
        resolution: e.resolution,
        line: e.line,
      })),
      hypotheses: candidates.map((c) => ({
        explanation: c.explanation,
        evidenceId: c.evidenceId ?? hash(c.path),
        status: "CANDIDATE" as const,
      })),
      incomplete: graph.coverage.incomplete,
      viewTruncated: false,
      stale: graph.files.some((f) => f.state === "STALE"),
      limitations: [
        ...graph.coverage.reasons.slice(0, 8).map((reason) => reason.slice(0, 300)),
        "Static file dependencies and exports; no complete runtime call graph or proof of root cause",
      ],
    };
    view.viewTruncated = viewTruncated;
    view.incomplete ||= viewTruncated;
    for (const key of [
      "files",
      "relations",
      "hypotheses",
      "relatedTests",
      "candidatePaths",
      "seeds",
    ] as const) {
      while (Buffer.byteLength(JSON.stringify(view)) > maxBytes && view[key].length) {
        view[key].pop();
        view.viewTruncated = true;
        view.incomplete = true;
      }
    }
    return view;
  }
  async publicTests(seeds: string[], signal: AbortSignal) {
    await this.initialize(signal);
    const names = seeds.map((p) => posix.basename(p).replace(/\.[^.]+$/, ""));
    const directories = new Set(seeds.map((p) => posix.dirname(p)));
    const adjacent = (path: string) =>
      directories.has(posix.dirname(path)) && /^(?:test|spec)\./iu.test(posix.basename(path));
    const tests = [...this.manifest.keys()]
      .filter(
        (p) =>
          fileType(p) === "TEST" &&
          codeFile(p) &&
          (adjacent(p) || names.some((n) => n.length > 2 && posix.basename(p).includes(n))),
      )
      .sort((a, b) => Number(adjacent(b)) - Number(adjacent(a)))
      .slice(0, 4);
    await this.inspect(tests, signal, false);
  }
}
