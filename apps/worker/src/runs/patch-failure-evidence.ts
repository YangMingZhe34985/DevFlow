import { contentHash } from "@devflow/agent";
import type { ToolExecutionRequest, ToolExecutionResult } from "@devflow/tools";
import { patchTargetPaths } from "./working-set.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Re-present already verified source after a failed patch. No reads, fuzzy matching or patch rewriting. */
export function attachPatchFailureEvidence(
  request: ToolExecutionRequest,
  result: ToolExecutionResult,
  current: ReadonlyMap<string, { content: string; expectedHash: string }>,
): ToolExecutionResult {
  if (request.name !== "applyPatch") return result;
  const args = object(request.input);
  const details = object(result.ok ? result.output : result.error.details);
  const failure = object(details?.patchFailure);
  if (failure?.kind !== "CONTEXT_MISMATCH") return result;
  const patch = typeof args?.patch === "string" ? args.patch : "";
  const paths = patchTargetPaths(patch);
  const mutation = result.mutation;
  const unchanged =
    mutation?.observationComplete === true &&
    !mutation.workspaceChanged &&
    !mutation.mutationApplied &&
    mutation.beforeRevision === mutation.afterRevision;
  const missing: string[] = [];
  const snippets: {
    path: string;
    fileSha256: string;
    startLine: number;
    endLine: number;
    content: string;
    rangeComplete: true;
  }[] = [];
  const ranges = new Map<
    string,
    { start: number; end: number; hunkStart: number; hunkEnd: number }[]
  >();
  let path: string | undefined;
  for (const line of patch.split("\n")) {
    if (line.startsWith("--- "))
      path = line.startsWith("--- a/") ? line.slice(6).replace(/\r$/u, "") : undefined;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u.exec(line);
    if (path && hunk) {
      const start = Number(hunk[1]),
        count = Number(hunk[2] ?? 1);
      const rows = ranges.get(path) ?? [];
      rows.push({
        start: Math.max(1, start - 8),
        end: start + Math.max(1, count) - 1 + 8,
        hunkStart: start,
        hunkEnd: start + Math.max(1, count) - 1,
      });
      ranges.set(path, rows);
    }
  }
  let bytes = 0;
  if (!unchanged || !paths?.length)
    missing.push("Mutation identity is incomplete or source changed; refresh is required.");
  else
    for (const target of paths) {
      const source = current.get(target);
      if (
        !source ||
        !/^[a-f0-9]{64}$/u.test(source.expectedHash) ||
        contentHash(source.content) !== source.expectedHash ||
        mutation.currentHashes[target] !== source.expectedHash
      ) {
        missing.push(`No complete, unchanged verified source for ${target}.`);
        continue;
      }
      const lines = source.content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
      const selected = ranges.get(target) ?? [];
      if (!selected.length) {
        missing.push(`No usable old-side hunk range for ${target}.`);
        continue;
      }
      const merged: { start: number; end: number }[] = [];
      for (const range of selected.sort((a, b) => a.start - b.start)) {
        if (range.hunkStart < 1 || range.hunkEnd > lines.length) {
          missing.push(
            `Hunk lies outside current source: ${target}:${range.hunkStart}-${range.hunkEnd}.`,
          );
          continue;
        }
        const end = Math.min(lines.length, range.end);
        const last = merged.at(-1);
        if (last && range.start <= last.end + 1) last.end = Math.max(last.end, end);
        else merged.push({ start: range.start, end });
      }
      for (const range of merged) {
        const content = lines.slice(range.start - 1, range.end).join("");
        const snippet = {
          path: target,
          fileSha256: source.expectedHash,
          startLine: range.start,
          endLine: range.end,
          content,
          rangeComplete: true as const,
        };
        const size = Buffer.byteLength(JSON.stringify(snippet));
        if (range.end - range.start + 1 > 200 || bytes + size > 8192) {
          missing.push(
            `Complete hunk neighborhood exceeds the 200-line/8-KiB evidence budget: ${target}:${range.start}-${range.end}.`,
          );
          continue;
        }
        snippets.push(snippet);
        bytes += size;
      }
    }
  const next = {
    ...details,
    patchFailure: {
      ...failure,
      needsRead: missing.length > 0 || snippets.length === 0,
      contextEvidenceComplete: missing.length === 0 && snippets.length > 0,
      currentSource: snippets,
      missingCurrentSource: missing,
      evidenceOrigin: "PREWRITE_VERIFICATION_CACHE",
      additionalPhysicalReads: 0,
    },
  };
  return result.ok
    ? { ...result, output: next }
    : { ...result, error: { ...result.error, details: next } };
}
