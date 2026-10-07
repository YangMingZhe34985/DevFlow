import { createHash } from "node:crypto";
import { diagnosticTriageText } from "./repair-diagnostics.js";
import type { DiagnosticResolution } from "./repair-diagnostics.js";
import type { WorkingCode } from "@devflow/agent";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

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
export function candidateRegion(content: string, publicEvidence: string) {
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
  const index = lines.findIndex((line) =>
    names.some((name) => new RegExp(`\\b${name}\\s*\\(`, "u").test(line)),
  );
  if (index < 0) return undefined;
  const startLine = Math.max(1, index - 8 + 1),
    endLine = Math.min(lines.length, index + 72);
  const quote = lines.slice(startLine - 1, endLine).join("\n");
  if (Buffer.byteLength(quote) > 8192) return undefined;
  return { startLine, endLine, quote, selection: "PUBLIC_SYMBOL_OVERLAP" as const };
}
