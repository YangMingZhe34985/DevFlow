import type { AgentPlan, ReviewResult } from "@devflow/shared";
import { z } from "zod";
import {
  hash,
  extractIssueSignals,
  issueSearchTerms,
  type IndexSource,
} from "../localization/contracts.js";
import { navigateImplementation } from "../localization/implementation-navigation.js";
import {
  graphPathAllowed,
  RepositoryRelationGraph,
  type RelationGraphArtifact,
} from "../localization/relation-graph.js";
import { planSourcePath } from "./plan-agent-context.js";
import type { ReviewEvidence } from "./review-evidence.js";

export interface ReviewSupplementUsage {
  rounds: number;
  reads: number;
  sourceBytes: number;
  snippetBytes: number;
}
export const ReviewSupplementUsageSchema = z.object({
  rounds: z.number().int().min(0).max(2),
  reads: z.number().int().min(0).max(8),
  sourceBytes: z
    .number()
    .int()
    .min(0)
    .max(1024 * 1024),
  snippetBytes: z
    .number()
    .int()
    .min(0)
    .max(32 * 1024),
});
export const REVIEW_SUPPLEMENT_LIMITS = {
  rounds: 2,
  reads: 8,
  sourceBytes: 1024 * 1024,
  snippetBytes: 32 * 1024,
};
export function remainingReviewSupplement(usage: ReviewSupplementUsage) {
  return {
    reads: Math.max(0, REVIEW_SUPPLEMENT_LIMITS.reads - usage.reads),
    bytes: Math.max(0, REVIEW_SUPPLEMENT_LIMITS.sourceBytes - usage.sourceBytes),
    snippets: Math.max(0, REVIEW_SUPPLEMENT_LIMITS.snippetBytes - usage.snippetBytes),
  };
}
export interface ReviewSourceCache {
  key: string;
  content: string;
  sha256: string;
}

/** Requests are optional in the compatible result. A source-linked gap still
 * gets one bounded attempt, rather than silently skipping the host supplement. */
export function reviewSupplementRequests(
  review: ReviewResult,
): NonNullable<ReviewResult["evidenceRequests"]> {
  // A protocol/scope correction precedes any further reads or public execution.
  if (review.hostFeedback?.some((f) => f.category !== "SOURCE")) return [];
  if (review.evidenceRequests?.length) return review.evidenceRequests;
  const requests: NonNullable<ReviewResult["evidenceRequests"]> = [];
  for (const finding of review.findings.filter(
    (f) => f.kind === "EVIDENCE_GAP" && f.severity !== "INFO",
  )) {
    const paths = [
      ...new Set([
        ...(finding.path ? [finding.path] : []),
        ...extractIssueSignals(finding.message).paths,
      ]),
    ];
    for (const path of paths) {
      if (requests.some((r) => r.path === path)) continue;
      requests.push({ path, question: finding.message.slice(0, 2000) });
      if (requests.length === 3) return requests;
    }
  }
  return requests;
}

export function newReviewCorrections(review: ReviewResult, seen: ReadonlySet<string>) {
  return (review.hostFeedback ?? [])
    .filter((f) => f.category !== "SOURCE")
    .map((feedback) => ({
      feedback,
      key: JSON.stringify([
        feedback.findingId,
        feedback.category,
        feedback.code,
        feedback.field,
        feedback.value,
      ]),
    }))
    .filter((row) => !seen.has(row.key));
}

/** One host-owned supplement; graph metadata and all requests share the limits. */
export async function collectReviewSupplement(input: {
  source: IndexSource;
  repositoryId: string;
  baseCommitSha: string;
  workspaceRevision: number;
  plan: AgentPlan;
  requests: NonNullable<ReviewResult["evidenceRequests"]>;
  signal: AbortSignal;
  baseline?: RelationGraphArtifact;
  baselineSource?: IndexSource | undefined;
  limits?: { reads: number; bytes: number; snippets: number };
  cacheEntries?: readonly ReviewSourceCache[];
  readCurrent?(
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): ReturnType<IndexSource["read"]>;
}): Promise<
  Pick<
    ReviewEvidence,
    "sources" | "unavailable" | "supplement" | "toolExecutions" | "toolLatencyMs"
  > & { cacheEntries: ReviewSourceCache[] }
> {
  const started = Date.now(),
    limits = input.limits ?? { reads: 4, bytes: 512 * 1024, snippets: 16 * 1024 };
  let reads = 0,
    bytes = 0,
    snippets = 0;
  const sources: ReviewEvidence["sources"] = [],
    unresolved: string[] = [];
  const cache = new Map<string, Awaited<ReturnType<IndexSource["read"]>>>();
  const sharedCache = new Map(
    (input.cacheEntries ?? []).filter((e) => hash(e.content) === e.sha256).map((e) => [e.key, e]),
  );
  const manifest = await input.source.manifest(input.signal);
  const entries = new Map(
    manifest.entries
      .filter((e) => e.kind === "FILE" && graphPathAllowed(e.path))
      .map((e) => [e.path, e]),
  );
  const seeds = input.plan.approvalScope?.files.map((f) => f.path) ?? [];
  const proximity = (path: string) =>
    Math.max(
      0,
      ...seeds.map((seed) => {
        const parts = seed.split("/"),
          target = path.split("/");
        let length = 0;
        while (length < Math.min(parts.length, target.length) && parts[length] === target[length])
          length++;
        return length;
      }),
    );
  const requests = input.requests.slice(0, 3).map((request) => {
    if (!request.path || entries.has(request.path) || request.path.includes("/")) return request;
    const path = [...entries.keys()]
      .filter((p) => p.split("/").at(-1) === request.path)
      .sort((a, b) => proximity(b) - proximity(a) || a.localeCompare(b))[0];
    return path ? { ...request, path } : request;
  });
  const bounded: IndexSource = {
    manifest: async () => ({ entries: [...entries.values()], incomplete: manifest.incomplete }),
    lookup: async (path) => entries.get(path),
    read: async (rawPath, signal) => {
      const path = planSourcePath(rawPath),
        entry = entries.get(path);
      if (!entry || !graphPathAllowed(path)) throw Error("Public source unavailable: " + path);
      const cacheKey = `CURRENT:${input.workspaceRevision}:${path}`;
      const cached = cache.get(path) ?? sharedCache.get(cacheKey);
      if (cached) return { content: cached.content, truncated: false };
      if (reads >= limits.reads || bytes + entry.sizeBytes > limits.bytes)
        throw Error("Shared Review source budget exhausted");
      reads++;
      const file = await (input.readCurrent
        ? input.readCurrent(path, limits.bytes - bytes, signal)
        : input.source.read(path, signal));
      bytes += Buffer.byteLength(file.content);
      if (
        file.truncated ||
        bytes > limits.bytes ||
        file.content.includes("\0") ||
        (entry.contentHash && hash(file.content) !== entry.contentHash)
      )
        throw Error("Incomplete or stale Review source: " + path);
      cache.set(path, file);
      sharedCache.set(cacheKey, {
        key: cacheKey,
        content: file.content,
        sha256: hash(file.content),
      });
      return file;
    },
  };
  const graph = new RepositoryRelationGraph({
    repositoryId: input.repositoryId,
    baseCommitSha: input.baseCommitSha,
    source: bounded,
    workspaceRevision: input.workspaceRevision,
    ...(input.baseline ? { baseline: input.baseline } : {}),
  });
  const add = (
    path: string,
    content: string,
    fileSha256: string,
    startLine: number,
    endLine: number,
    view: "CURRENT" | "BASELINE" = "CURRENT",
  ) => {
    if (
      sources.some(
        (s) =>
          s.path === path &&
          (s.view ?? "CURRENT") === view &&
          s.fileSha256 === fileSha256 &&
          startLine >= s.startLine &&
          endLine <= (s.endLine ?? 0),
      )
    )
      return;
    if (snippets + Buffer.byteLength(content) > limits.snippets) return;
    snippets += Buffer.byteLength(content);
    sources.push({ path, content, fileSha256, startLine, endLine, partial: true, view });
  };
  // Reserve the explicit public files before metadata can consume the allowance.
  for (const request of requests) {
    if (request.view === "BASELINE") continue;
    if (!request.path) continue;
    try {
      await bounded.read(request.path, input.signal);
    } catch (error) {
      if (input.signal.aborted) throw error;
    }
  }
  // Symbol-only queries keep one approved source seed ahead of metadata reads.
  if (requests.some((r) => r.symbol && !r.path) && seeds[0]) {
    try {
      await bounded.read(seeds[0], input.signal);
    } catch (error) {
      if (input.signal.aborted) throw error;
    }
  }
  for (const request of requests) {
    input.signal.throwIfAborted();
    if (!request.path && !request.symbol) {
      unresolved.push("Request needs a public path or symbol: " + request.question);
      continue;
    }
    const before = sources.length;
    try {
      if (request.view === "BASELINE") {
        if (!request.path || !input.baselineSource)
          throw Error("Immutable baseline source unavailable");
        const path = planSourcePath(request.path);
        if (!graphPathAllowed(path)) throw Error("Forbidden baseline source");
        const key = `BASELINE:${input.baseCommitSha}:${path}`;
        let cached = sharedCache.get(key);
        if (!cached) {
          const entry =
            (await input.baselineSource.lookup?.(path, input.signal)) ??
            (await input.baselineSource.manifest(input.signal)).entries.find(
              (e) => e.path === path,
            );
          if (
            !entry ||
            entry.kind !== "FILE" ||
            reads >= limits.reads ||
            bytes + entry.sizeBytes > limits.bytes
          )
            throw Error("Shared Review baseline budget exhausted or source missing");
          reads++;
          const file = await input.baselineSource.read(path, input.signal);
          bytes += Buffer.byteLength(file.content);
          if (
            file.truncated ||
            bytes > limits.bytes ||
            (entry.contentHash && hash(file.content) !== entry.contentHash)
          )
            throw Error("Incomplete or stale baseline source");
          cached = { key, content: file.content, sha256: hash(file.content) };
          sharedCache.set(key, cached);
        }
        const lines = cached.content.split("\n");
        const focus = request.symbol
          ? Math.max(
              0,
              lines.findIndex((l) => l.includes(request.symbol!)),
            )
          : 0;
        const start = Math.max(0, focus - 8),
          selected: string[] = [];
        for (const line of lines.slice(start, start + 300)) {
          if (Buffer.byteLength([...selected, line].join("\n")) > limits.snippets - snippets) break;
          selected.push(line);
        }
        add(
          path,
          selected.join("\n"),
          cached.sha256,
          start + 1,
          start + selected.length,
          "BASELINE",
        );
        continue;
      }
      // Prioritize an explicit request before graph configuration reads.
      const explicit = request.path ? await bounded.read(request.path, input.signal) : undefined;
      const navigation = await navigateImplementation({
        repositoryId: input.repositoryId,
        baseCommitSha: input.baseCommitSha,
        source: bounded,
        graph,
        signal: input.signal,
        description: (request.symbol ? request.symbol + "()\n" : "") + request.question,
        candidates: request.path
          ? [{ path: request.path, symbol: request.symbol }]
          : (input.plan.approvalScope?.files ?? []).map((f) => ({
              path: f.path,
              symbol: request.symbol,
            })),
        maxReads: limits.reads,
        maxSourceBytes: limits.bytes,
        maxSnippetBytes: limits.snippets - snippets,
        maxWindows: 4,
      });
      for (const w of navigation.windows)
        add(w.path, w.snippet, w.contentHash, w.startLine, w.endLine);
      if (explicit && !sources.slice(before).some((s) => s.path === request.path)) {
        // Tests/non-TS sources may have no graph definition; preserve exact text.
        const lines = explicit.content.split(/\r?\n/u),
          terms = issueSearchTerms(extractIssueSignals(request.question)).filter(
            (t) => t.length > 3,
          ),
          scored = lines.map((line, index) => ({
            index,
            score: terms.filter((t) => line.toLowerCase().includes(t.toLowerCase())).length,
          })),
          focus = request.symbol
            ? lines.findIndex((l) => l.includes(request.symbol!))
            : (scored.sort((a, b) => b.score - a.score || a.index - b.index)[0]?.index ?? 0);
        const start = Math.max(0, focus - 12),
          selected: string[] = [];
        for (const line of lines.slice(start, start + 96)) {
          if (
            Buffer.byteLength([...selected, line].join("\n")) >
            Math.min(4096, limits.snippets - snippets)
          )
            break;
          selected.push(line);
        }
        if (selected.length)
          add(
            request.path!,
            selected.join("\n"),
            hash(explicit.content),
            start + 1,
            start + selected.length,
          );
      }
      if (sources.length === before)
        unresolved.push("No new current source supplied: " + request.question);
    } catch (error) {
      if (input.signal.aborted) throw error;
      unresolved.push(error instanceof Error ? error.message : "Review source unavailable");
    }
  }
  return {
    cacheEntries: [...sharedCache.values()],
    sources,
    unavailable: unresolved,
    supplement: {
      used: true,
      requests: Math.min(3, input.requests.length),
      reads,
      sourceBytes: bytes,
      snippetBytes: snippets,
      unresolved,
    },
    toolExecutions: reads + 1,
    toolLatencyMs: Date.now() - started,
  };
}
