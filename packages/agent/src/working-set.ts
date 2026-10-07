import { createHash } from "node:crypto";
import type { ModelMessage } from "./model.js";

export interface EvidenceRef {
  path: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  workspaceRevision: number;
}
export interface WorkingCode extends EvidenceRef {
  code: string;
  complete: boolean;
  role: "TARGET" | "INTERFACE" | "TEST" | "CONFIG";
}
export interface WorkingSet {
  version: "working-set-v1";
  evidenceVersion: string;
  workspaceRevision: number;
  targetFiles: string[];
  targetSymbols: string[];
  relevantCode: WorkingCode[];
  requiredInterfaces: string[];
  relevantTests: string[];
  constraints: string[];
  uncertainty: string[];
  evidenceSufficient: boolean;
  requiresAdditionalExploration: boolean;
  missingInformation: string[];
}
export const contentHash = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

function readIdentity(v: Record<string, unknown>): string {
  const key = `${v.path}:${contentHash(String(v.content ?? ""))}`;
  return v.startLine === undefined
    ? key
    : `${key}:${v.fileSha256}:${v.startLine}:${v.endLine}:${v.workspaceRevision}`;
}

export function invalidateHistoricalReads(messages: readonly ModelMessage[]): ModelMessage[] {
  const mutations: { index: number; paths?: ReadonlySet<string> }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "ASSISTANT") {
      for (const call of m.toolCalls ?? []) {
        if (!["writeFile", "replaceText", "applyPatch", "runCommand"].includes(call.name)) continue;
        if (
          !messages.some(
            (candidate, index) =>
              index > i &&
              candidate.role === "TOOL" &&
              candidate.toolCallId === call.id &&
              candidate.toolName === call.name,
          )
        )
          mutations.push({ index: i });
      }
    } else if (
      m?.role === "TOOL" &&
      (m.mutation !== undefined ||
        ["writeFile", "replaceText", "applyPatch", "runCommand"].includes(m.toolName))
    ) {
      const observed = m.mutation;
      // A failed call can change bytes. Only a complete host observation establishes no change.
      if (
        observed?.observationComplete === true &&
        !observed.workspaceChanged &&
        !observed.mutationApplied &&
        observed.changedFiles.length === 0 &&
        observed.beforeRevision === observed.afterRevision
      )
        continue;
      const paths =
        observed?.observationComplete === true && observed.workspaceChanged
          ? observed.changedFiles.length > 0
            ? observed.changedFiles
            : observed.affectedPaths
          : observed?.affectedPaths;
      mutations.push({
        index: i,
        ...(paths?.length ? { paths: new Set(paths.map(normalizeEvidencePath)) } : {}),
      });
    }
  }
  return messages.map((m, i) => {
    if (
      m.role !== "TOOL" ||
      m.isError ||
      !["readFile", "batchReadFiles", "locateIssue"].includes(m.toolName)
    )
      return m;
    const later = mutations.filter((mutation) => mutation.index > i);
    if (later.length === 0) return m;
    if (later.some((mutation) => mutation.paths === undefined))
      return { ...m, content: staleRead(m.content) };
    const paths = new Set(later.flatMap((mutation) => [...mutation.paths!]));
    const output = object(m.content);
    const content =
      m.toolName === "readFile" && typeof output?.path !== "string"
        ? staleRead(m.content)
        : m.toolName === "batchReadFiles" && Array.isArray(output?.files)
          ? {
              ...output,
              files: output.files.map((file) =>
                typeof object(file)?.path === "string"
                  ? invalidateReadPaths(file, paths)
                  : staleRead(file),
              ),
            }
          : invalidateReadPaths(m.content, paths);
    if (content === m.content) return m;
    return {
      ...m,
      content,
    };
  });
}

function normalizeEvidencePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function staleRead(value: unknown): Record<string, unknown> {
  const record = object(value);
  if (record?.stale === true) return record;
  const path = record?.path;
  return {
    ...(typeof path === "string" ? { path } : {}),
    note: "Source evidence was superseded by an observed or unverified workspace change; read current code if needed.",
    previousResultHash: contentHash(JSON.stringify(value) ?? "null"),
    stale: true,
  };
}

/** Keep unrelated entries in batch/localization results; source identity follows each path. */
function invalidateReadPaths(value: unknown, paths: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    const projected = value.map((item) => invalidateReadPaths(item, paths));
    return projected.some((item, index) => item !== value[index]) ? projected : value;
  }
  const record = object(value);
  if (!record) return value;
  if (typeof record.path === "string" && paths.has(normalizeEvidencePath(record.path)))
    return staleRead(value);
  let changed = false;
  const projected = Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      const next = invalidateReadPaths(item, paths);
      changed ||= next !== item;
      return [key, next];
    }),
  );
  return changed ? projected : value;
}

/** Only replace code when the exact same bytes remain visible in this projected request. */
export function deduplicateContext(
  messages: ModelMessage[],
  workingSet?: WorkingSet,
  revision = 0,
): ModelMessage[] {
  const available = new Map<string, unknown>();
  if (workingSet?.workspaceRevision === revision) {
    for (const item of workingSet.relevantCode) {
      if (
        item.complete &&
        messages.some(
          (m) =>
            m.role === "USER" &&
            m.content.startsWith("Repository/stage evidence:") &&
            m.content.includes(JSON.stringify(item.code)),
        )
      ) {
        available.set(`${item.path}:${contentHash(item.code)}`, {
          path: item.path,
          contentHash: item.contentHash,
          startLine: item.startLine,
          endLine: item.endLine,
          workspaceRevision: revision,
        });
      }
    }
  }
  // Latest snapshots are synthesized from the same TOOL records; retain the TOOL once.
  const toolsWithCode = new Set<string>();
  const remember = (value: unknown) => {
    const v = object(value);
    if (typeof v?.path === "string" && typeof v.content === "string")
      toolsWithCode.add(readIdentity(v));
  };
  for (const m of messages) {
    if (m.role !== "TOOL" || m.isError) continue;
    if (m.toolName === "readFile") remember(m.content);
    if (m.toolName === "batchReadFiles")
      for (const f of array(object(m.content)?.files)) remember(f);
  }
  return messages.map((m) => {
    if (m.role === "USER" && m.content.startsWith("Latest relevant file snapshots")) {
      try {
        const files = JSON.parse(m.content.slice(m.content.indexOf("\n") + 1)) as unknown[];
        const remaining = files.filter((f) => {
          const v = object(f);
          const key = v ? readIdentity(v) : "";
          return !available.has(key) && !toolsWithCode.has(key);
        });
        return {
          ...m,
          content: remaining.length
            ? `Latest relevant file snapshots:\n${JSON.stringify(remaining)}`
            : "Latest file contents are available in the evidence or tool results in this context.",
        };
      } catch {
        return m;
      } // Projector truncation: do not invent a reference.
    }
    if (m.role !== "TOOL" || m.isError || !["readFile", "batchReadFiles"].includes(m.toolName))
      return m;
    const project = (value: unknown) => {
      const v = object(value);
      if (typeof v?.path !== "string" || typeof v.content !== "string") return value;
      const key = readIdentity(v);
      const ref = available.get(key);
      if (ref)
        return {
          path: v.path,
          evidenceRef: ref,
          note: "already available in current context",
          truncated: v.truncated,
          ...(v.startLine === undefined
            ? {}
            : {
                startLine: v.startLine,
                endLine: v.endLine,
                fileSha256: v.fileSha256,
                workspaceRevision: v.workspaceRevision,
                recovery: v.recovery,
              }),
        };
      available.set(key, {
        path: v.path,
        contentHash: contentHash(v.content),
        workspaceRevision: revision,
        toolCallId: m.toolCallId,
        ...(v.startLine === undefined
          ? {}
          : { startLine: v.startLine, endLine: v.endLine, fileSha256: v.fileSha256 }),
      });
      return value;
    };
    const output = object(m.content);
    return {
      ...m,
      content:
        m.toolName === "readFile"
          ? project(m.content)
          : { ...output, files: array(output?.files).map(project) },
    };
  });
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
