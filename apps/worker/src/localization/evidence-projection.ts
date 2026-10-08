import type { EvidenceItem } from "./contracts.js";

export interface LocalizationEvidenceRow {
  id: string;
  path: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  snippet: string;
  [key: string]: unknown;
}
export interface EvidenceOmission {
  id: string;
  path: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  reason: "CONTEXT_BUDGET" | "RECORD_BUDGET" | "COVERED_BY_CURRENT_EVIDENCE";
}

/** A navigation hint, never a proof of behavior, causality or write authority. */
export function behaviorEvidence(item: EvidenceItem): boolean {
  return (
    /\.(?:test|spec)\.[^.]+$/u.test(item.path) ||
    item.reason.startsWith("Consumer reference") ||
    (item.fileType === "SOURCE" &&
      /\b(?:return|if|switch|throw|raise|yield)\b|=>/u.test(item.snippet))
  );
}

/** Select complete records. Required earlier behavior and latest reads move together. */
export function projectLocalizationEvidence<
  T extends LocalizationEvidenceRow,
  S extends Record<string, unknown>,
>(input: {
  rows: readonly T[];
  requiredIds: ReadonlySet<string>;
  state: S;
  maxBytes: number;
  softBytes?: number;
  maxRecords?: number;
}) {
  const covers = (outer: T, inner: T) =>
    outer.id !== inner.id &&
    outer.path === inner.path &&
    outer.contentHash === inner.contentHash &&
    outer.startLine <= inner.startLine &&
    outer.endLine >= inner.endLine &&
    (outer.startLine < inner.startLine || outer.endLine > inner.endLine || outer.id < inner.id) &&
    outer.snippet
      .split("\n")
      .slice(inner.startLine - outer.startLine, inner.endLine - outer.startLine + 1)
      .join("\n") === inner.snippet;
  const allRequired = input.rows.filter((row) => input.requiredIds.has(row.id));
  const required = allRequired.filter((row) => !allRequired.some((other) => covers(other, row)));
  const maxRecords = input.maxRecords ?? Math.max(16, required.length);
  const omittedRecord = (row: T, reason: EvidenceOmission["reason"]): EvidenceOmission => ({
    id: row.id,
    path: row.path,
    contentHash: row.contentHash,
    startLine: row.startLine,
    endLine: row.endLine,
    reason,
  });
  const shape = (selected: readonly T[]) => {
    const ids = new Set(selected.map((row) => row.id));
    const omitted = input.rows
      .filter((row) => !ids.has(row.id))
      .map((row) =>
        omittedRecord(
          row,
          selected.some((other) => covers(other, row))
            ? "COVERED_BY_CURRENT_EVIDENCE"
            : selected.length >= maxRecords
              ? "RECORD_BUDGET"
              : "CONTEXT_BUDGET",
        ),
      );
    return {
      ...input.state,
      evidence: selected,
      omittedEvidence: omitted.length,
      omittedEvidenceDetails: omitted,
    };
  };
  const size = (selected: readonly T[]) => Buffer.byteLength(JSON.stringify(shape(selected)));
  const requiredBytes = size(required);
  const permitted = required.length <= maxRecords && requiredBytes <= input.maxBytes;
  if (!permitted)
    return {
      permitted,
      state: shape([]),
      selected: [] as T[],
      requiredBytes,
      maxBytes: input.maxBytes,
      requiredRecords: required.length,
      maxRecords,
    };
  // The normal target is soft: important complete records may use the actual stage/context balance.
  const target = Math.min(input.maxBytes, Math.max(input.softBytes ?? 20000, requiredBytes));
  let selected = [...required];
  for (const row of input.rows) {
    if (
      input.requiredIds.has(row.id) ||
      selected.some((other) => covers(other, row)) ||
      selected.length >= maxRecords
    )
      continue;
    const next = [...selected, row];
    if (size(next) <= target) selected = next;
  }
  const selectedIds = new Set(selected.map((row) => row.id));
  selected = input.rows.filter((row) => selectedIds.has(row.id));
  return {
    permitted,
    state: shape(selected),
    selected,
    requiredBytes,
    maxBytes: input.maxBytes,
    requiredRecords: required.length,
    maxRecords,
  };
}
