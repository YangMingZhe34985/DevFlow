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
  let mutation = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (
      m?.role === "ASSISTANT" &&
      m.toolCalls?.some((c) =>
        ["writeFile", "replaceText", "applyPatch", "runCommand"].includes(c.name),
      )
    )
      mutation = i;
  }
  return messages.map((m, i) => {
    if (
      i >= mutation ||
      m.role !== "TOOL" ||
      m.isError ||
      !["readFile", "batchReadFiles", "locateIssue"].includes(m.toolName)
    )
      return m;
    return {
      ...m,
      content: {
        note: "Base evidence superseded by a mutation attempt; read current code if needed.",
        previousResultHash: contentHash(JSON.stringify(m.content)),
        stale: true,
      },
    };
  });
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
