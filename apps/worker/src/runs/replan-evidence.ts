import { candidateRegion } from "./repair-tasks.js";
import { sha256 } from "@devflow/eval";
import { DevflowError, type RunResult } from "@devflow/shared";
import type { CommandResult, SandboxSession } from "@devflow/sandbox";
import type { DiagnosticResolution } from "./repair-diagnostics.js";
import { graphPathAllowed } from "../localization/relation-graph.js";
import type { CurrentSourceCache } from "./current-source-cache.js";

export interface ReplanReadState {
  reads: number;
  sourceBytes: number;
  cacheHits: number;
  readLimit?: number | undefined;
}
export interface ReplanFile {
  path: string;
  content: string;
  contentHash: string;
  sizeBytes: number;
}
/** Local source allowance, distinct from workflow cancellation or downstream reserves. */
export class ReplanSourceAllowanceExhausted extends DevflowError {
  readonly allowance: { reads: number; readLimit: number; sourceBytes: number };
  constructor(state: Readonly<ReplanReadState>) {
    const allowance = {
      reads: state.reads,
      readLimit: Math.min(8, state.readLimit ?? 8),
      sourceBytes: state.sourceBytes,
    };
    super({
      code: "EXECUTION_BUDGET_EXCEEDED",
      message: "REPLAN_SOURCE_READ_RESERVE_EXHAUSTED",
      details: {
        requestIssued: false,
        ...allowance,
      },
    });
    this.allowance = allowance;
  }
}
/** A single physical-read allowance shared by admission and Plan preparation. */
export class ReplanEvidenceReader {
  readonly files = new Map<string, ReplanFile>();
  readonly state: ReplanReadState;
  constructor(
    private readonly sandbox: SandboxSession,
    private readonly signal: AbortSignal,
    private readonly beforeRead: () => Promise<void>,
    state?: ReplanReadState,
    private readonly afterRead?: (state: ReplanReadState) => Promise<void>,
    private readonly sourceCache?: CurrentSourceCache,
  ) {
    this.state = state ?? { reads: 0, sourceBytes: 0, cacheHits: 0 };
  }
  assertActive() {
    this.signal.throwIfAborted();
  }
  async read(path: string): Promise<ReplanFile> {
    this.signal.throwIfAborted();
    if (!graphPathAllowed(path)) throw new Error("REPLAN_FORBIDDEN_SOURCE");
    const cached = this.files.get(path) ?? this.sourceCache?.source(this.sandbox, path);
    if (cached) {
      if (
        Buffer.byteLength(cached.content) > 512 * 1024 ||
        sha256(cached.content) !== cached.contentHash
      )
        throw new DevflowError({
          code: "VALIDATION_ERROR",
          message: "REPLAN_SOURCE_IDENTITY_UNVERIFIED",
          details: { path },
        });
      this.state.cacheHits++;
      this.files.set(path, cached);
      return cached;
    }
    if (
      this.state.reads >= Math.min(8, this.state.readLimit ?? 8) ||
      this.state.sourceBytes >= 1024 * 1024
    )
      throw new ReplanSourceAllowanceExhausted(this.state);
    this.state.reads++;
    try {
      await this.beforeRead(); // Reserve and persist before issuing IO.
    } catch (error) {
      this.state.reads--; // A rejected preflight is not a physical read.
      await this.afterRead?.(this.state);
      throw error;
    }
    const file = await this.sandbox.readFile(
      { path, maxBytes: Math.min(512 * 1024, 1024 * 1024 - this.state.sourceBytes) },
      this.signal,
    );
    this.state.sourceBytes += Buffer.byteLength(file.content);
    await this.afterRead?.(this.state);
    if (file.truncated || !file.fileSha256 || sha256(file.content) !== file.fileSha256)
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "REPLAN_SOURCE_IDENTITY_UNVERIFIED",
        details: { path },
      });
    const observed = {
      path,
      content: file.content,
      contentHash: file.fileSha256,
      sizeBytes: Buffer.byteLength(file.content),
    };
    this.files.set(path, observed);
    this.sourceCache?.remember(this.sandbox, observed);
    return observed;
  }
}
export interface ReplanEvidenceRecord {
  path: string;
  line?: number;
  currentSha256: string;
  hostRegion?: {
    startLine: number;
    endLine: number;
    quote: string;
    selection: "PUBLIC_SYMBOL_OVERLAP" | "MODEL_SYMBOL_HINT";
  };
  testEvidence?: {
    path: string;
    fileSha256: string;
    startLine: number;
    endLine: number;
    quote: string;
    source: "HOST_DIAGNOSTIC_READ" | "MODEL_CITATION";
  }[];
  basis: "DIRECT_DIAGNOSTIC" | "TEST_EVIDENCE";
  diagnosticPaths: string[];
  relationship: "HYPOTHESIS_FOR_PLANNER";
}
const isTest = (path: string) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|Test\.java$/u.test(path);

/** Select investigation evidence, not a proof of causality. The same list drives preflight and IO. */
export function replanEvidencePlan(input: {
  requested: readonly string[];
  oldPaths: readonly string[];
  resolution: DiagnosticResolution;
  completion: NonNullable<RunResult["phaseCompletion"]>;
}) {
  const candidates = [...new Set(input.requested)]
    .filter((p) => !input.oldPaths.includes(p))
    .slice(0, 8);
  const cited = new Set(
    [
      ...(input.completion.evidence ?? []),
      ...(input.completion.findingResponses?.flatMap((r) => r.evidence ?? []) ?? []),
    ].map((e) => e.path),
  );
  const tests = input.resolution.resolved.filter((d) => isTest(d.path));
  const needsTests = candidates.some((p) => !input.resolution.resolved.some((d) => d.path === p));
  const byPath = [...new Map(tests.map((d) => [d.path, d])).values()];
  const testLocations = needsTests
    ? byPath.sort((a, b) => Number(cited.has(b.path)) - Number(cited.has(a.path))).slice(0, 2)
    : [];
  return {
    candidates,
    testLocations,
    readPaths: [...new Set([...candidates, ...testLocations.map((d) => d.path)])],
    omittedTestPaths: byPath
      .filter((d) => !testLocations.some((s) => s.path === d.path))
      .map((d) => d.path),
  };
}
export async function verifyReplanEvidence(input: {
  requested: readonly string[];
  oldPaths: readonly string[];
  failure: CommandResult;
  resolution: DiagnosticResolution;
  completion: NonNullable<RunResult["phaseCompletion"]>;
  reader: ReplanEvidenceReader;
  allowed: (path: string) => boolean;
  preparationPlan?: ReturnType<typeof replanEvidencePlan>;
}) {
  const records: ReplanEvidenceRecord[] = [],
    rejected: { path: string; reason: string }[] = [];
  if (
    input.failure.exitCode === null ||
    input.failure.exitCode === 0 ||
    input.failure.timedOut ||
    input.failure.outputTruncated ||
    !input.resolution.resolved.length
  )
    return { records, rejected: [{ path: "", reason: "PUBLIC_FAILURE_UNCONFIRMED" }] };
  const citations = [
    ...(input.completion.evidence ?? []),
    ...(input.completion.findingResponses?.flatMap((r) => r.evidence ?? []) ?? []),
  ];
  const validate = async (citation: (typeof citations)[number]) => {
    const file = await input.reader.read(citation.path);
    if (citation.fileSha256 !== file.contentHash) throw new Error("SOURCE_STALE");
    const offset = file.content.indexOf(citation.quote);
    if (offset < 0) throw new Error("EVIDENCE_INVALID");
    const start = file.content.slice(0, offset).split("\n").length;
    return { start, end: start + citation.quote.split("\n").length - 1 };
  };
  const retainedTests = new Set<string>();
  let retainedTestBytes = 0;
  const preparation = input.preparationPlan ?? replanEvidencePlan(input);
  for (const path of [...new Set(input.requested)].slice(0, 8)) {
    if (!graphPathAllowed(path) || !input.allowed(path) || isTest(path)) {
      rejected.push({ path, reason: "PROTECTED_OR_FORBIDDEN_PATH" });
      continue;
    }
    if (input.oldPaths.includes(path)) continue;
    const ambiguous = input.resolution.unresolved.find(
      (d) => d.reason === "AMBIGUOUS" && d.candidates.includes(path),
    );
    if (ambiguous) {
      rejected.push({ path, reason: "DIAGNOSTIC_PATH_AMBIGUOUS" });
      continue;
    }
    try {
      const file = await input.reader.read(path);
      const direct = input.resolution.resolved.filter((d) => d.path === path);
      const sourceQuotes = citations.filter((c) => c.path === path);
      let sourceLine = direct[0]?.line;
      for (const citation of sourceQuotes) {
        const range = await validate(citation);
        sourceLine ??= range.start;
      }
      const testLinks: string[] = [];
      const testEvidence: NonNullable<ReplanEvidenceRecord["testEvidence"]> = [];
      let hostRegion: ReturnType<typeof candidateRegion>;
      if (!direct.length) {
        for (const diagnostic of preparation.testLocations) {
          const supplied = citations.filter((c) => c.path === diagnostic.path);
          for (const citation of supplied) {
            const range = await validate(citation);
            if (
              input.resolution.resolved.some(
                (d) => d.path === diagnostic.path && d.line >= range.start && d.line <= range.end,
              )
            ) {
              testLinks.push(diagnostic.path);
              testEvidence.push({
                ...citation,
                startLine: range.start,
                endLine: range.end,
                source: "MODEL_CITATION",
              });
            }
          }
          // Missing is different from invalid: never replace an explicit bad/stale quote.
          if (!supplied.length) {
            const test = await input.reader.read(diagnostic.path),
              lines = test.content.split("\n");
            if (diagnostic.line > lines.length) throw new Error("FAILED_TEST_LOCATION_INVALID");
            const startLine = Math.max(1, diagnostic.line - 12),
              endLine = Math.min(lines.length, diagnostic.line + 12);
            const quote = lines.slice(startLine - 1, endLine).join("\n");
            if (!quote.trim() || Buffer.byteLength(quote) > 8192)
              throw new Error("FAILED_TEST_REGION_INCOMPLETE");
            testLinks.push(diagnostic.path);
            testEvidence.push({
              path: diagnostic.path,
              fileSha256: test.contentHash,
              startLine,
              endLine,
              quote,
              source: "HOST_DIAGNOSTIC_READ",
            });
          }
        }
        if (!testLinks.length) throw new Error("FAILED_TEST_EVIDENCE_MISSING");
        if (!sourceQuotes.length) {
          // Current source is already SHA-verified by the shared bounded reader.
          // A public-test symbol selects a region, not a causal verdict or write permission.
          hostRegion = candidateRegion(
            file.content,
            testEvidence.map((c) => c.quote).join("\n"),
            [input.completion.summary, input.completion.replanRequest?.reason]
              .filter(Boolean)
              .join("\n"),
          );
          if (!hostRegion)
            throw new Error(
              "IMPLEMENTATION_REGION_MISSING: cite a current relevant definition or explain its public-test relationship in a bounded Repair correction",
            );
          sourceLine = hostRegion.startLine;
        }
      }
      const newTestEvidence = testEvidence.filter(
        (e) => !retainedTests.has(`${e.path}:${e.fileSha256}:${e.startLine}:${e.endLine}`),
      );
      const nextBytes = newTestEvidence.reduce((n, e) => n + Buffer.byteLength(e.quote), 0);
      if (retainedTestBytes + nextBytes > 8192)
        throw new Error("FAILED_TEST_SNIPPET_BUDGET_EXHAUSTED");
      for (const e of newTestEvidence)
        retainedTests.add(`${e.path}:${e.fileSha256}:${e.startLine}:${e.endLine}`);
      retainedTestBytes += nextBytes;
      records.push({
        path,
        ...(sourceLine ? { line: sourceLine } : {}),
        currentSha256: file.contentHash,
        ...(hostRegion ? { hostRegion } : {}),
        ...(newTestEvidence.length ? { testEvidence: newTestEvidence } : {}),
        basis: direct.length ? "DIRECT_DIAGNOSTIC" : "TEST_EVIDENCE",
        diagnosticPaths: [...new Set(direct.length ? direct.map((d) => d.path) : testLinks)],
        relationship: "HYPOTHESIS_FOR_PLANNER",
      });
    } catch (error) {
      input.reader.assertActive();
      if (
        input.reader.state.reads >= 8 ||
        input.reader.state.sourceBytes >= 1024 * 1024 ||
        input.failure.timedOut ||
        (error instanceof DevflowError && error.code === "EXECUTION_BUDGET_EXCEEDED")
      )
        throw error;
      rejected.push({
        path,
        reason: error instanceof Error ? error.message : "SOURCE_UNAVAILABLE",
      });
    }
  }
  return { records, rejected };
}
