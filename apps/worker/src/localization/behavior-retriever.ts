import {
  hash,
  isTestFile,
  sourceRole,
  tokens,
  type EvidenceItem,
  type EvidencePack,
  type IndexSource,
} from "./contracts.js";
import { rankAtlasRegions, atlasPage, type RepositoryAtlas } from "./repository-atlas.js";
import type { LocalizationInvestigationState } from "./investigation-state.js";

/** A complete host frontier, bounded per-query source acquisition. Metadata ranking is
 * a hypothesis only. All reads use the supplied accounting/graph-observation source. */
export class BehaviorRetriever {
  private rows: NonNullable<LocalizationInvestigationState["frontier"]>;
  private queries: string[] = [];
  private missing: string[] = [];
  private readonly contents = new Map<string, string>();
  constructor(
    private readonly atlas: RepositoryAtlas,
    query: string,
    saved?: LocalizationInvestigationState["frontier"],
    sourceCache?: LocalizationInvestigationState["sourceCache"],
  ) {
    this.rows = saved
      ? structuredClone(saved)
      : rankAtlasRegions(atlas, query).filter((n) => n.kind === "FILE");
    for (const [path, file] of sourceCache ?? []) {
      const entry = atlas.entries.find((e) => e.path === path);
      if (!file.truncated && entry?.contentHash === hash(file.content))
        this.contents.set(path, file.content);
    }
    // An inspected marker without verifiable content cannot hide a candidate after recovery.
    for (const row of this.rows)
      if (row.status === "INSPECTED" && !this.contents.has(row.path)) row.status = "HYPOTHESIS";
  }
  frontier() {
    return structuredClone(this.rows);
  }
  view() {
    const regions = new Map<
      string,
      {
        path: string;
        score: number;
        files: number;
        indexedFiles: number;
        boundary: string | null;
        status: "INFERRED";
      }
    >();
    const modules = this.atlas.nodes
      .filter((n) => n.kind === "MODULE")
      .sort((a, b) => b.path.length - a.path.length);
    for (const row of this.rows) {
      const module = modules.find((m) => row.path.startsWith(m.path + "/"));
      const path = module?.path ?? row.path.split("/").slice(0, -1).join("/");
      const region = regions.get(path) ?? {
        path,
        score: 0,
        files: 0,
        indexedFiles: 0,
        boundary: module?.moduleEvidence ?? null,
        status: "INFERRED" as const,
      };
      region.score = Math.max(region.score, row.score);
      region.files++;
      region.indexedFiles += Number(this.contents.has(row.path));
      regions.set(path, region);
    }
    return {
      atlas: atlasPage(this.atlas),
      regions: [...regions.values()]
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, 6),
      candidates: this.rows.filter((r) => r.status !== "INSPECTED").slice(0, 12),
      totalCandidates: this.rows.length,
      indexedFiles: this.contents.size,
      queries: this.queries.slice(-4),
      missing: this.missing.slice(-8),
      rule: "Regions are read-only hypotheses, not resolved root causes. Ask for paths, symbols, behavior queries, tests or consumers. Unparsed reverse relationships remain unknown.",
    };
  }
  async retrieve(input: {
    query: string;
    source: IndexSource;
    signal: AbortSignal;
    template: EvidencePack;
    repositoryId: string;
    baseCommitSha: string;
  }) {
    this.queries.push(input.query);
    const terms = tokens(input.query);
    const scores = new Map(rankAtlasRegions(this.atlas, input.query).map((r) => [r.path, r.score]));
    for (const row of this.rows) row.score = Math.max(row.score, scores.get(row.path) ?? 0);
    this.rows.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const available = this.rows.filter(
      (r) =>
        r.status !== "INSPECTED" &&
        ["IMPLEMENTATION", "ENTRY", "TEST"].includes(sourceRole(r.path)),
    );
    // Tests and implementation/consumer candidates receive interleaved opportunities.
    const tests = available.filter((r) => isTestFile(r.path));
    const sources = available.filter((r) => !isTestFile(r.path));
    const batch = [sources[0], tests[0], sources[1], sources[2]].filter(
      (r): r is NonNullable<typeof r> => !!r,
    );
    const evidence: EvidenceItem[] = [];
    let bytes = 0,
      reads = 0;
    const started = Date.now();
    for (const row of batch) {
      input.signal.throwIfAborted();
      const entry = this.atlas.entries.find((e) => e.path === row.path)!;
      if (entry.sizeBytes > 512 * 1024 || bytes + entry.sizeBytes > 512 * 1024) {
        this.missing.push(`Uninspected ${row.path}: source exceeds remaining query byte envelope.`);
        continue;
      }
      const file = await input.source.read(row.path, input.signal);
      reads++;
      bytes += Buffer.byteLength(file.content);
      if (
        file.truncated ||
        bytes > 512 * 1024 ||
        file.content.includes("\0") ||
        (entry.contentHash && entry.contentHash !== hash(file.content))
      ) {
        this.missing.push(`Unverified current source: ${row.path}`);
        continue;
      }
      row.status = "INSPECTED";
      this.contents.set(row.path, file.content);
    }
    // Re-query previously indexed content in memory; a new query does not reread old files.
    for (const [path, content] of this.contents) {
      const lines = content.split(/\r?\n/u);
      const hits = lines
        .map((line, i) => ({ i, score: tokens(line).filter((t) => terms.includes(t)).length }))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score || a.i - b.i);
      if (!hits.length) continue;
      const startLine = Math.max(1, hits[0]!.i + 1 - 10);
      let snippet = "",
        endLine = startLine - 1;
      for (let i = startLine - 1; i < Math.min(lines.length, startLine + 59); i++) {
        const next = snippet + (snippet ? "\n" : "") + lines[i]!;
        if (Buffer.byteLength(next) > 4096) break;
        snippet = next;
        endLine = i + 1;
      }
      if (!snippet) continue;
      evidence.push({
        repositoryId: input.repositoryId,
        baseCommitSha: input.baseCommitSha,
        viewRevision: this.atlas.identity,
        path,
        contentHash: hash(content),
        startLine,
        endLine,
        symbol: null,
        reason: "PRG behavior retrieval: lexical support, causal relationship unverified",
        retrievalSource: [
          "prg-behavior",
          isTestFile(path) ? "test-assertion" : "implementation-or-consumer",
        ],
        score: hits[0]!.score,
        snippet,
        language: path.split(".").at(-1) ?? "text",
        module: path.split("/").slice(0, -1).join("/"),
        fileType: isTestFile(path) ? "TEST" : "SOURCE",
        parseStatus: "LEXICAL",
        signature: null,
        directImports: [],
        truncated: startLine > 1 || endLine < lines.length,
      });
    }
    evidence.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    // Bound the query view, not the indexed content or frontier.
    const selected = evidence.slice(0, 4);
    return {
      ...input.template,
      evidence: selected,
      incomplete: true,
      missingInformation: [
        ...this.missing.slice(-8),
        "Reverse-reference and content coverage remain partial; uninspected frontier is retained.",
      ],
      metrics: {
        ...input.template.metrics,
        readBytes: bytes,
        filesInspected: reads,
        wallMs: Date.now() - started,
        toolExecutions: reads,
        parsedFiles: 0,
        cacheHits: Math.max(0, this.contents.size - reads),
      },
      prg: {
        atlasIdentity: this.atlas.identity,
        coverage: this.atlas.coverage,
        frontierSize: this.rows.length,
        inspectedFiles: this.rows.filter((r) => r.status === "INSPECTED").length,
      },
    } satisfies EvidencePack;
  }
}
