import { stripVTControlCharacters } from "node:util";
import { graphPathAllowed } from "../localization/relation-graph.js";

export interface RepairDiagnostic {
  path: string;
  line: number;
  diagnostic: string;
  javaClass?: string;
}
export interface ResolvedRepairDiagnostic extends RepairDiagnostic {
  rawPath: string;
  resolution: "EXACT" | "JAVA_CLASS" | "UNIQUE_SUFFIX";
}
export interface DiagnosticResolution {
  resolved: ResolvedRepairDiagnostic[];
  unresolved: (RepairDiagnostic & {
    reason: "AMBIGUOUS" | "NOT_IN_REPOSITORY" | "MANIFEST_INCOMPLETE";
    candidates: string[];
  })[];
  manifestComplete: boolean;
}

/** Only a recognized completed passing reporter block can be omitted from triage.
 * Raw output remains in the immutable evidence artifact; incomplete/unknown blocks survive. */
export function diagnosticTriageText(output: string): string {
  const lines = stripVTControlCharacters(output).split("\n");
  let active: { name: string; start: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const running = /^\[INFO\] Running ([\w.$]+)\s*$/u.exec(lines[i]!.trim());
    if (running) active = { name: running[1]!, start: i };
    const result =
      /^\[(?:INFO|ERROR)\] Tests run:\s*(\d+), Failures:\s*(\d+), Errors:\s*(\d+), Skipped:\s*\d+.* -- in ([\w.$]+)\s*$/u.exec(
        lines[i]!.trim(),
      );
    if (active && result?.[4] === active.name) {
      if (Number(result[1]) > 0 && Number(result[2]) === 0 && Number(result[3]) === 0)
        for (let j = active.start; j <= i; j++) lines[j] = "";
      active = undefined;
    }
  }
  return lines.join("\n");
}

/** Parsing is deliberately separate from repository identity and relevance. */
function collect(output: string): RepairDiagnostic[] {
  const direct: RepairDiagnostic[] = [],
    frames: RepairDiagnostic[] = [];
  for (const text of diagnosticTriageText(output).replaceAll("\\", "/").split("\n")) {
    const python = text.match(/File "([^"\n]+\.py)", line (\d+)/u);
    const java = text.match(/\bat ([\w.$]+)\(([^():]+\.java):(\d+)\)/u);
    const location = text.match(
      /(?:^|[\s[(])((?:[A-Za-z]:)?\/?(?:[\w@ .-]+\/)*[\w .-]+\.(?:[cm]?[jt]sx?|py|java|c|cc|cpp|cxx|h|hpp))(?::\[?(\d+)(?::|,)?\d*\]?|\((\d+),\d+\))/u,
    );
    const rawPath = python?.[1] ?? java?.[2] ?? location?.[1];
    if (!rawPath) continue;
    let path = rawPath.trim().replace(/^\.\//u, "");
    if (path.startsWith("/workspace/")) path = path.slice(11);
    else if (/^(?:\/|[A-Za-z]:)/u.test(path)) continue;
    const line = Number(python?.[2] ?? java?.[3] ?? location?.[2] ?? location?.[3]);
    if (
      !graphPathAllowed(path) ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      /(?:^|\/)(?:site-packages|node_modules|\.venv|target)(?:\/|$)/u.test(path)
    )
      continue;
    const javaClass = java?.[1]?.slice(0, java[1].lastIndexOf("."))?.split("$")[0];
    (python || java || /:\s+in\s+\w/u.test(text) ? frames : direct).push({
      path,
      line,
      diagnostic: text.slice(0, 2000),
      ...(javaClass ? { javaClass } : {}),
    });
  }
  const ordered = [...direct, ...frames.reverse()];
  return ordered.filter(
    (d, i) =>
      ordered.findIndex(
        (other) =>
          other.path === d.path && other.line === d.line && other.javaClass === d.javaClass,
      ) === i,
  );
}

/** Legacy raw-location API. Consumers needing source identity must resolve first. */
export function extractRepairDiagnostics(output: string): RepairDiagnostic[] {
  return collect(output).slice(0, 8);
}

export function resolveRepairDiagnostics(
  output: string,
  repositoryPaths: readonly string[],
  manifestComplete = true,
): DiagnosticResolution {
  const paths = [...new Set(repositoryPaths)].filter(graphPathAllowed);
  const result: DiagnosticResolution = { resolved: [], unresolved: [], manifestComplete };
  for (const d of collect(output)) {
    let matches = paths.includes(d.path) ? [d.path] : [];
    let resolution: ResolvedRepairDiagnostic["resolution"] = "EXACT";
    if (!matches.length && d.javaClass) {
      const suffix = d.javaClass.replaceAll(".", "/") + ".java";
      matches = paths.filter((path) => path === suffix || path.endsWith("/" + suffix));
      resolution = "JAVA_CLASS";
    }
    if (!matches.length) {
      matches = paths.filter((path) => path.endsWith("/" + d.path));
      resolution = "UNIQUE_SUFFIX";
    }
    if (matches.length === 1 && (manifestComplete || resolution !== "UNIQUE_SUFFIX"))
      result.resolved.push({ ...d, rawPath: d.path, path: matches[0]!, resolution });
    else
      result.unresolved.push({
        ...d,
        reason:
          matches.length > 1
            ? "AMBIGUOUS"
            : manifestComplete
              ? "NOT_IN_REPOSITORY"
              : "MANIFEST_INCOMPLETE",
        candidates: matches,
      });
  }
  // Unmatched runtime frames never displace project diagnostics from the eight-file seed.
  result.resolved.sort(
    (a, b) =>
      Number(/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|Test\.java$/u.test(a.path)) -
      Number(/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|Test\.java$/u.test(b.path)),
  );
  const retained = new Set<string>();
  result.resolved = result.resolved.filter((d) => {
    if (!retained.has(d.path) && retained.size >= 8) return false;
    retained.add(d.path);
    return true;
  });
  return result;
}

export function repairModeInstructions(
  mode: "TEST_REPAIR" | "REVIEW_REPAIR",
  findingIds: readonly string[] = [],
) {
  return [
    `Repair mode: ${mode}. Host Review finding IDs: ${JSON.stringify(findingIds)}.`,
    mode === "TEST_REPAIR"
      ? "Test locations are not finding IDs. Omit findingIds and findingResponses. Use top-level evidence and replanRequest for a scope conflict."
      : "Only supplied host finding IDs may appear in findingIds/findingResponses; file names and line numbers are not IDs.",
    "Every quote must be literal current source with its complete fileSha256; do not paraphrase, join separated lines, or insert ellipses.",
    'Scope-conflict example (replace placeholders with observed current source): {"outcome":"SCOPE_CONFLICT","summary":"Current failure requires a new source target","evidence":[{"path":"src/implementation.ext","quote":"exact observed code","fileSha256":"<current complete SHA-256>"}],"replanRequest":{"candidatePaths":["src/implementation.ext"],"reason":"Explain its relationship to the public failure"}}. This requests read-only planning, not permission to edit.',
  ].join("\n");
}
