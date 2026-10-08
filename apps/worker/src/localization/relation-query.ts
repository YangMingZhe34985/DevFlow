import { hash, sourcePathPriority, type IndexSource } from "./contracts.js";
import { navigateImplementation } from "./implementation-navigation.js";
import {
  graphPathAllowed,
  type RelationGraphArtifact,
  type RepositoryRelationGraph,
} from "./relation-graph.js";
import { staticSourceLanguage } from "./source-units.js";

type Manifest = Awaited<ReturnType<IndexSource["manifest"]>>;
const codePath = (path: string) =>
  /\.(?:[cm]?[jt]sx?)$/iu.test(path) || !!staticSourceLanguage(path);
const normal = (name: string) => name.replace(/[^a-z0-9]/giu, "").toLowerCase();

/** Resolve paths using existing inventory only. A directory is a bounded query scope,
 * never a request to walk the repository or a claim that any file is a root cause. */
export function resolveRelationPaths(input: {
  paths: readonly string[];
  symbols: readonly string[];
  manifest: Manifest;
  graph: RelationGraphArtifact;
  maxSeeds?: number;
}) {
  const entries = new Map(input.manifest.entries.map((entry) => [entry.path, entry]));
  const maxSeeds = input.maxSeeds ?? 4;
  const symbols = new Set(input.symbols.map(normal));
  const matches = new Map<string, string[]>();
  for (const node of input.graph.files) {
    if (node.state !== "CURRENT" || !node.sha256 || !entries.has(node.path)) continue;
    const names = [
      ...(node.parse?.symbols.map((symbol) => symbol.name) ?? []),
      ...(node.parse?.exports.map((symbol) => symbol.name) ?? []),
      ...(node.sourceUnit?.definitions.map((symbol) => symbol.name) ?? []),
    ].filter((name) => symbols.has(normal(name)));
    if (names.length) matches.set(node.path, [...new Set(names)]);
  }
  const consumers = new Set(
    input.graph.edges
      .filter(
        (edge) => !edge.stale && edge.resolution === "RESOLVED" && edge.to && matches.has(edge.to),
      )
      .map((edge) => edge.from),
  );
  const scope = new Set<string>();
  const seeds: string[] = [];
  const observations: string[] = [];
  const pathResolution = input.paths.map((requestedPath) => {
    const path = requestedPath.replace(/\/+$/u, "");
    const row = {
      requestedPath,
      path,
      kind: "UNKNOWN",
      source: "MANIFEST",
      manifestIncomplete: input.manifest.incomplete,
      candidateCount: 0,
      selectedPaths: [] as string[],
      omittedCandidates: 0,
      symbolMatches: [] as { path: string; symbols: string[] }[],
      ambiguousSymbols: [] as string[],
    };
    if (!path || !graphPathAllowed(path)) {
      row.kind = "REJECTED";
      observations.push(
        `Unsafe or unsupported query path ${requestedPath}; provide a repository-relative public source path.`,
      );
      return row;
    }
    const exact = entries.get(path);
    const children = [...entries.values()]
      .filter(
        (entry) =>
          entry.kind === "FILE" &&
          graphPathAllowed(entry.path) &&
          codePath(entry.path) &&
          entry.path.startsWith(path + "/"),
      )
      .map((entry) => entry.path);
    let candidates: string[];
    if (exact?.kind === "FILE") {
      row.kind = codePath(path) ? "FILE" : "UNSUPPORTED";
      candidates = codePath(path) ? [path] : [];
    } else if (exact?.kind === "DIRECTORY" || children.length) {
      row.kind = "DIRECTORY";
      row.source = exact?.kind === "DIRECTORY" ? "MANIFEST_DIRECTORY" : "MANIFEST_DESCENDANTS";
      candidates = children;
    } else {
      row.kind = input.manifest.incomplete ? "UNKNOWN" : "MISSING";
      observations.push(
        `${path}: ${row.kind === "UNKNOWN" ? "manifest incomplete; existence is unknown" : "not present in the complete source manifest"}. Provide an observed file or directory; no repository-wide fallback was performed.`,
      );
      return row;
    }
    for (const candidate of candidates) scope.add(candidate);
    const rank = (candidate: string) =>
      (matches.has(candidate) ? 10_000 : consumers.has(candidate) ? 5_000 : 0) +
      sourcePathPriority(candidate) +
      input.symbols.reduce(
        (score, symbol) => score + (normal(candidate).includes(normal(symbol)) ? 100 : 0),
        0,
      );
    candidates.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
    row.candidateCount = candidates.length;
    row.selectedPaths = candidates
      .filter((candidate) => !seeds.includes(candidate))
      .slice(0, Math.max(0, maxSeeds - seeds.length));
    seeds.push(...row.selectedPaths);
    row.omittedCandidates = candidates.filter((candidate) => !seeds.includes(candidate)).length;
    row.symbolMatches = row.selectedPaths.flatMap((candidate) =>
      matches.has(candidate) ? [{ path: candidate, symbols: matches.get(candidate)! }] : [],
    );
    row.ambiguousSymbols = input.symbols.filter(
      (symbol) =>
        candidates.filter((candidate) =>
          matches.get(candidate)?.some((name) => normal(name) === normal(symbol)),
        ).length > 1,
    );
    if (row.kind === "DIRECTORY")
      observations.push(
        `${path}: selected ${row.selectedPaths.length}/${row.candidateCount} source candidates from existing inventory${input.manifest.incomplete ? " (incomplete)" : ""}; symbol/consumer matches are navigation hints, not a confirmed root cause.`,
      );
    if (row.ambiguousSymbols.length)
      observations.push(
        `${path}: multiple source candidates define ${row.ambiguousSymbols.join(", ")}; do not infer one unique definition.`,
      );
    if (!candidates.length)
      observations.push(
        `${path}: no supported source files in the available manifest; no global fallback was performed.`,
      );
    return row;
  });
  return { seeds, fallbackPaths: [...scope], pathResolution, observations };
}

/** Shared production entry point: resolution itself performs no source reads. */
export async function queryRepositoryRelations(input: {
  repositoryId: string;
  source: IndexSource;
  graph: RepositoryRelationGraph;
  paths: readonly string[];
  symbols?: readonly string[];
  description: string;
  signal: AbortSignal;
}) {
  const manifest = await input.graph.manifestView(input.signal);
  const resolved = resolveRelationPaths({
    ...input,
    symbols: input.symbols ?? [],
    manifest,
    graph: input.graph.snapshot(),
  });
  const navigation =
    input.symbols?.length && resolved.seeds.length
      ? await navigateImplementation({
          repositoryId: input.repositoryId,
          baseCommitSha: input.graph.snapshot().baseCommitSha,
          source: input.source,
          graph: input.graph,
          manifest,
          description: `${input.symbols.map((symbol) => `${symbol}()`).join(" ")}\n${input.description}`,
          candidates: resolved.seeds.map((path) => ({ path, symbol: input.symbols![0] })),
          prioritizeCandidates: true,
          fallbackPaths: resolved.fallbackPaths,
          signal: input.signal,
          maxReads: 4,
          maxSourceBytes: 512 * 1024,
          maxSnippetBytes: 4096,
          maxWindows: 3,
        })
      : undefined;
  // Symbol navigation already reads/observes the selected files. Do not inspect
  // them first and spend the same IO allowance again.
  const directReads: string[] = [];
  let directBytes = 0;
  if (!navigation && resolved.seeds.length) {
    for (const path of resolved.seeds) {
      if (
        input.graph.snapshot().files.some((node) => node.path === path && node.state === "CURRENT")
      )
        continue;
      const entry = manifest.entries.find((candidate) => candidate.path === path)!;
      if (entry.sizeBytes > 512 * 1024 || directBytes + entry.sizeBytes > 512 * 1024) {
        resolved.observations.push(
          `SOURCE_BUDGET: ${path} does not fit the remaining 512 KiB query read allowance.`,
        );
        continue;
      }
      directReads.push(path);
      const read = await input.source.read(path, input.signal);
      directBytes += Buffer.byteLength(read.content);
      if (
        read.truncated ||
        directBytes > 512 * 1024 ||
        read.content.includes("\0") ||
        (entry.contentHash && entry.contentHash !== hash(read.content))
      ) {
        resolved.observations.push(
          `Incomplete or stale query source: ${path}; no current evidence was accepted.`,
        );
        continue;
      }
      await input.graph.observe(path, read.content, input.signal);
    }
  }
  const evidencePaths = [...new Set(navigation?.windows.map((window) => window.path) ?? [])];
  const view = input.graph.issueView(
    [...new Set([...resolved.seeds, ...evidencePaths])],
    [],
    4096,
    input.symbols,
  );
  const relatedPaths = new Set([
    ...resolved.seeds,
    ...evidencePaths,
    ...view.relations.flatMap((relation) =>
      relation.to ? [relation.from, relation.to] : [relation.from],
    ),
  ]);
  view.relatedTests = view.relatedTests.filter((path) => relatedPaths.has(path));
  const output = {
    ...view,
    pathResolution: resolved.pathResolution,
    actualScope: {
      resolvedSeeds: resolved.seeds,
      readPaths: navigation?.readPaths ?? directReads,
      evidencePaths,
    },
    observations: [...resolved.observations, ...(navigation?.observations ?? [])],
    implementationEvidence: navigation?.windows ?? [],
    missingInformation: navigation?.missing ?? [],
    navigationMetrics: navigation?.metrics ?? null,
    outputTruncated: false,
    omittedRecords: 0,
  };
  // Preserve complete records, including the path error, inside a total tool
  // response budget. Raw graph/source artifacts remain available to the host.
  while (Buffer.byteLength(JSON.stringify(output)) > 8192) {
    if (!output.outputTruncated) {
      output.outputTruncated = true;
      output.viewTruncated = true;
      output.incomplete = true;
      output.observations.unshift(
        "OUTPUT_BUDGET: complete records were omitted; omitted source is not model-visible evidence.",
      );
    }
    output.omittedRecords++;
    if (output.files.length > 1) output.files.pop();
    else if (output.missingInformation.length > 3) output.missingInformation.pop();
    else if (output.relations.length > 2) output.relations.pop();
    else if (output.limitations.length > 1) output.limitations.pop();
    else if (output.files.length) output.files.pop();
    else if (output.missingInformation.length) output.missingInformation.pop();
    else if (output.observations.length > 2) output.observations.pop();
    else if (output.relatedTests.length) output.relatedTests.pop();
    else if (output.limitations.length) output.limitations.pop();
    else if (output.relations.length) output.relations.pop();
    else if (output.implementationEvidence.length) output.implementationEvidence.pop();
    else if (output.seeds.length) output.seeds.pop();
    else if (output.actualScope.readPaths.length) output.actualScope.readPaths.pop();
    else if (output.actualScope.resolvedSeeds.length) output.actualScope.resolvedSeeds.pop();
    else if (output.pathResolution.length > 1) output.pathResolution.pop();
    else if (output.pathResolution[0]?.symbolMatches.length)
      output.pathResolution[0].symbolMatches.pop();
    else if (output.pathResolution[0]?.selectedPaths.length)
      output.pathResolution[0].selectedPaths.pop();
    else break;
    output.actualScope.evidencePaths = [
      ...new Set(output.implementationEvidence.map((window) => window.path)),
    ];
  }
  output.actualScope.evidencePaths = [
    ...new Set(output.implementationEvidence.map((window) => window.path)),
  ];
  return output;
}
