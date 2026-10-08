import { createHash } from "node:crypto";
import { diagnosticTriageText } from "./repair-diagnostics.js";
import type { DiagnosticResolution } from "./repair-diagnostics.js";
import type { WorkingCode } from "@devflow/agent";
import { graphPathAllowed } from "../localization/relation-graph.js";
import { isTestFile } from "../localization/contracts.js";
import { parseRelations } from "../localization/relation-parser.js";

export interface FailureInvestigation {
  id: string;
  failureFingerprint: string;
  roots: string[];
  candidates: string[];
  evidence: {
    path: string;
    fileSha256: string;
    target: string;
    origin: "PUBLIC_DIAGNOSTIC" | "OBSERVED_TEST_IMPORT" | "PUBLIC_TEST_LOCATION";
  }[];
}

/** Host observations can open read-only navigation, never establish a root cause or write scope. */
export async function failureInvestigationFor(input: {
  consecutiveFailures: number;
  test: { exitCode: number | null; timedOut: boolean; outputTruncated: boolean };
  failureFingerprint: string;
  approvedPaths: readonly string[];
  repositoryPaths: readonly string[];
  resolution: DiagnosticResolution;
  currentSources: readonly WorkingCode[];
  signal: AbortSignal;
}): Promise<FailureInvestigation | undefined> {
  if (
    input.consecutiveFailures < 2 ||
    input.test.exitCode === null ||
    input.test.exitCode === 0 ||
    input.test.timedOut ||
    input.test.outputTruncated
  )
    return undefined;
  const approved = new Set(input.approvedPaths);
  const observed = new Map(
    input.currentSources
      .filter(
        (s) =>
          investigationPathAllowed(s.path) &&
          /^[a-f0-9]{64}$/.test(s.contentHash) &&
          s.code.trim() &&
          (!s.complete || digest(s.code) === s.contentHash),
      )
      .map((s) => [s.path, s]),
  );
  const evidence: FailureInvestigation["evidence"] = [];
  for (const diagnostic of input.resolution.resolved) {
    const source = observed.get(diagnostic.path);
    if (
      source &&
      !approved.has(source.path) &&
      !isTestFile(source.path) &&
      investigationPathAllowed(source.path)
    )
      evidence.push({
        path: source.path,
        fileSha256: source.contentHash,
        target: source.path,
        origin: "PUBLIC_DIAGNOSTIC",
      });
  }
  // Prefer exact source locations. If only assertions are located, use the existing
  // resolver on actually observed leading test code; absent aliases/config remain unknown.
  if (!evidence.length)
    for (const source of input.currentSources
      .filter(
        (s) =>
          isTestFile(s.path) &&
          s.startLine === 1 &&
          observed.has(s.path) &&
          input.resolution.resolved.some((diagnostic) => diagnostic.path === s.path),
      )
      .slice(0, 2)) {
      try {
        const parsed = await parseRelations(
          {
            path: source.path,
            content: source.code,
            paths: [...input.repositoryPaths],
            configuration: {},
          },
          input.signal,
        );
        if (parsed.status !== "PARSED" || parsed.configurationErrors.length) continue;
        for (const imported of parsed.imports) {
          const target = imported.resolvedPath;
          if (
            target &&
            imported.resolution === "RESOLVED" &&
            !imported.typeOnly &&
            investigationPathAllowed(target) &&
            !isTestFile(target) &&
            !approved.has(target)
          )
            evidence.push({
              path: source.path,
              fileSha256: source.contentHash,
              target,
              origin: "OBSERVED_TEST_IMPORT",
            });
        }
      } catch (error) {
        if (input.signal.aborted) throw error;
        // A failed/ambiguous navigation attempt grants no speculative root.
      }
    }
  const candidates = [...new Set(evidence.map((e) => e.target))].slice(0, 2);
  if (!candidates.length) {
    // A diagnostic window often starts below imports. Permit navigation from the
    // observed failing test, without inventing an implementation candidate or scope conflict.
    const tests = [...new Set(input.resolution.resolved.map((d) => d.path))]
      .filter((path) => isTestFile(path) && !approved.has(path) && observed.has(path))
      .slice(0, 2);
    if (!tests.length) return undefined;
    const retained: FailureInvestigation["evidence"] = tests.map((path) => ({
      path,
      fileSha256: observed.get(path)!.contentHash,
      target: path,
      origin: "PUBLIC_TEST_LOCATION",
    }));
    return {
      id: `failure-investigation-${digest(JSON.stringify({ approved: [...approved].sort(), fingerprint: input.failureFingerprint, retained })).slice(0, 24)}`,
      failureFingerprint: input.failureFingerprint,
      roots: tests,
      candidates: [],
      evidence: retained,
    };
  }
  const retained = evidence.filter((e) => candidates.includes(e.target)).slice(0, 4);
  const roots = [...new Set([...candidates, ...retained.map((e) => e.path)])].slice(0, 4);
  return {
    id: `failure-investigation-${digest(JSON.stringify({ approved: [...approved].sort(), fingerprint: input.failureFingerprint, retained })).slice(0, 24)}`,
    failureFingerprint: input.failureFingerprint,
    roots,
    candidates,
    evidence: retained,
  };
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function investigationPathAllowed(path: string) {
  return (
    !/^(?:[A-Za-z]:|\/|\\)/u.test(path) &&
    !path.split(/[\\/]/u).some((part) => part === ".." || part === "." || !part) &&
    graphPathAllowed(path)
  );
}

/** Shared selection for resource quotation and the actual Repair-context IO. */
export function repairContextSourcePaths(input: {
  resolution: DiagnosticResolution;
  additionalSources?: readonly { path: string; line?: number | undefined }[];
  changedPaths: readonly string[];
}) {
  const changed = input.changedPaths.filter(
    (path) =>
      !/(?:^|\/)(?:\.git|node_modules|dist|build|coverage|\.next|vendor)(?:\/|$)/u.test(path) &&
      !/\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|lock)$/iu.test(path),
  );
  return [
    ...new Set([
      ...input.resolution.resolved.map((diagnostic) => diagnostic.path),
      ...(input.additionalSources?.map((source) => source.path) ?? []),
      ...changed,
    ]),
  ]
    .filter(graphPathAllowed)
    .slice(0, 8);
}

/** Presentation records only: the immutable artifact retains the complete public log. */
export function repairDiagnosticTasks(output: string, resolution: DiagnosticResolution) {
  const lines = diagnosticTriageText(output).split("\n");
  const records = resolution.resolved.map((diagnostic) => {
    const index = lines.findIndex((line) => line.trim() === diagnostic.diagnostic.trim());
    const context =
      index < 0 ? diagnostic.diagnostic : lines.slice(Math.max(0, index - 2), index + 4).join("\n");
    const kind = /\b(?:F\d{3}|E\d{3}|W\d{3}|eslint|ruff)\b/u.test(context)
      ? "LINT"
      : /\b(?:TS\d+|mypy|incompatible type|incompatible types)\b/iu.test(context)
        ? "TYPE"
        : /(?:cannot find symbol|compilation|fatal error|error:)/iu.test(context)
          ? "BUILD"
          : /(?:Assertion|Expected|Received|Failure|FAILED)/u.test(context)
            ? "ASSERTION"
            : "RUNTIME";
    return {
      id: `diagnostic-${digest(`${diagnostic.path}:${diagnostic.line}:${context}`).slice(0, 16)}`,
      kind,
      path: diagnostic.path,
      line: diagnostic.line,
      message: context,
      resolution: diagnostic.resolution,
    };
  });
  // Keep unlocated assertion values and environment failures, without repeated passing-file output.
  const selected = new Set<number>();
  lines.forEach((line, i) => {
    if (
      /(?:\bFAIL(?:ED|URE)?\b|\b(?:Error|Exception|AssertionError|KeyError|TypeError)\b|Expected:|Received:|Actual:|\b\d+ failed\b|\b[FET]\d{3,}\b)/u.test(
        line,
      )
    )
      for (let j = Math.max(0, i - 1); j < Math.min(lines.length, i + 5); j++) selected.add(j);
  });
  const excerpts = [...new Set([...selected].sort((a, b) => a - b).map((i) => lines[i]!))];
  let bytes = 0;
  const retained = excerpts.filter((line) => {
    bytes += Buffer.byteLength(line) + 1;
    return bytes <= 6000;
  });
  return {
    records,
    unlocated: retained.join("\n"),
    omitted: retained.length < excerpts.length,
    unresolved: resolution.unresolved.map(({ path, line, reason, candidates }) => ({
      path,
      line,
      reason,
      candidates,
    })),
  };
}

/** Stable IDs include source identity; they cannot accidentally authorize a later revision. */
export function sourceEvidenceRecord(source: WorkingCode, artifactSha256?: string) {
  return {
    id: `source-${digest(`${source.path}:${source.contentHash}:${source.startLine}:${source.endLine}`).slice(0, 24)}`,
    path: source.path,
    fileSha256: source.contentHash,
    revision: source.workspaceRevision,
    startLine: source.startLine,
    endLine: source.endLine,
    complete: source.complete,
    source: "HOST_CURRENT_READ" as const,
    ...(artifactSha256 ? { artifactSha256, section: `file:${source.path}` } : {}),
  };
}

/** Select a bounded observed implementation region; lexical overlap is a hypothesis, never causal proof. */
export function candidateRegion(content: string, publicEvidence: string, hypothesis?: string) {
  const ignored = new Set([
    "if",
    "for",
    "while",
    "switch",
    "return",
    "assert",
    "expect",
    "test",
    "TEST",
    "TEST_F",
    "sizeof",
  ]);
  const names = [
    ...new Set(
      [...publicEvidence.matchAll(/\b([A-Za-z_]\w*)\s*\(/gu)]
        .map((m) => m[1]!)
        .filter((n) => !ignored.has(n)),
    ),
  ];
  const lines = content.split("\n");
  let selection: "PUBLIC_SYMBOL_OVERLAP" | "MODEL_SYMBOL_HINT" = "PUBLIC_SYMBOL_OVERLAP";
  let index = lines.findIndex((line) =>
    names.some((name) => new RegExp(`\\b${name}\\s*\\(`, "u").test(line)),
  );
  if (index < 0 && hypothesis) {
    // A model-mentioned name may select a real declaration for read-only planning.
    // It is not a supplied quote, a confirmed call edge, or authority to edit.
    index = lines.findIndex((line) => {
      const name = /\b(?:function|def)\s+([A-Za-z_]\w*)\s*\(/u.exec(line)?.[1];
      return (
        name !== undefined &&
        !ignored.has(name) &&
        new RegExp(`\\b${name}\\b`, "u").test(hypothesis)
      );
    });
    selection = "MODEL_SYMBOL_HINT";
  }
  if (index < 0) return undefined;
  const startLine = Math.max(1, index - 8 + 1),
    endLine = Math.min(lines.length, index + 72);
  const quote = lines.slice(startLine - 1, endLine).join("\n");
  if (Buffer.byteLength(quote) > 8192) return undefined;
  return { startLine, endLine, quote, selection };
}
