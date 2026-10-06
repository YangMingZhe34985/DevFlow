import { createHash } from "node:crypto";
import type { ModelRequest } from "@devflow/agent";
import { z } from "zod";
import type { EvidenceItem, EvidencePack } from "../localization/contracts.js";
import type { IssueLocalizationResult } from "../localization/issue-localization-agent.js";
import { normalizeTargetPath } from "./execution-packet.js";

export const planHash = (value: string): string => createHash("sha256").update(value).digest("hex");

export interface PlanPathPolicy {
  /** Public tests remain readable. Benchmark callers enable edit protection explicitly. */
  protectTests?: boolean;
  protectInfrastructure?: boolean;
  /** Exact repository paths or directory prefixes; an optional trailing /** is accepted. */
  protectedPaths?: readonly string[];
}

export function planSourcePath(input: string): string {
  const path = normalizeTargetPath(input);
  if (/(?:^|\/)(?:\.git|\.devflow[^/]*|hidden-acceptance|hidden-tests?)(?:\/|$)/iu.test(path))
    throw new Error("PLAN_FORBIDDEN_SOURCE");
  return path;
}

export function planEditProtected(path: string, policy: PlanPathPolicy): boolean {
  if (
    policy.protectInfrastructure === true &&
    /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|vitest[^/]*|node_modules|\.devflow[^/]*)(?:\/|$)/iu.test(
      path,
    )
  )
    return true;
  if (
    policy.protectTests === true &&
    /(?:^|\/)(?:tests?|__tests__|__snapshots__)(?:\/|$)|(?:^|\/)(?:test|spec)\.[^/]+$|\.(?:test|spec)\.[^/]+$/iu.test(
      path,
    )
  )
    return true;
  return (policy.protectedPaths ?? []).some((value) => {
    const prefix = value.replaceAll("\\", "/").replace(/\/(?:\*\*)?$/u, "");
    return path === prefix || path.startsWith(prefix + "/");
  });
}

export interface PlanRequestEstimate {
  estimator: "ESTIMATED_SERIALIZED_UTF8_BYTES_DIV_3";
  serializedBytes: number;
  estimatedInputTokens: number;
  messagesBytes: number;
  toolsBytes: number;
  outputSchemaBytes: number;
  settingsBytes: number;
  fingerprint: string;
}

/** Measure the complete provider-independent request, including both schema envelopes. */
export function serializePlanRequest(request: ModelRequest): string {
  return JSON.stringify({
    messages: request.messages,
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema),
    })),
    output:
      request.output === undefined
        ? null
        : {
            name: request.output.name ?? "devflow_output",
            description: request.output.description ?? null,
            schema: z.toJSONSchema(request.output.schema),
          },
    settings: request.settings ?? null,
  });
}

export function estimatePlanRequest(request: ModelRequest): PlanRequestEstimate {
  const serialized = serializePlanRequest(request);
  const shape = JSON.parse(serialized) as Record<string, unknown>;
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  return {
    estimator: "ESTIMATED_SERIALIZED_UTF8_BYTES_DIV_3",
    serializedBytes: Buffer.byteLength(serialized),
    estimatedInputTokens: Math.ceil(Buffer.byteLength(serialized) / 3),
    messagesBytes: size(shape.messages),
    toolsBytes: size(shape.tools),
    outputSchemaBytes: size(shape.output),
    settingsBytes: size(shape.settings),
    fingerprint: planHash(serialized),
  };
}

export interface PlanEvidenceRef {
  id: string;
  repositoryId: string;
  baseCommitSha: string;
  workspaceRevision: number;
  viewRevision: string;
  path: string;
  contentHash: string;
  snippetHash: string;
  startLine: number;
  endLine: number;
  sourceVerified: boolean;
  truncated: boolean;
}

export interface PlanEvidenceRow extends PlanEvidenceRef {
  snippet: string;
  symbol: string | null;
  fileType: EvidenceItem["fileType"];
  reason: string;
}

export interface PlanHostState {
  version: "plan-host-state-v1";
  issue: { title: string; description: string; digest: string };
  hostConstraints: readonly string[];
  feedback: unknown;
  repositoryId: string;
  baseCommitSha: string;
  workspaceRevision: number;
  sourceIdentity: string | null;
  policy: {
    protectTests: boolean;
    protectInfrastructure: boolean;
    protectedPaths: readonly string[];
  };
  hardStepLimit: number | null;
}

export interface PlanContextInput {
  title: string;
  description: string;
  hostConstraints?: readonly string[];
  feedback?: unknown;
  repositoryId: string;
  baseCommitSha: string;
  workspaceRevision: number;
  policy?: PlanPathPolicy;
  hardStepLimit?: number;
  evidence?: EvidencePack;
  localizationEvidence?: IssueLocalizationResult;
}

export function planHostState(input: PlanContextInput, sourceIdentity?: string): PlanHostState {
  return {
    version: "plan-host-state-v1",
    issue: {
      title: input.title,
      description: input.description,
      digest: planHash(JSON.stringify([input.title, input.description])),
    },
    hostConstraints: [...(input.hostConstraints ?? [])],
    feedback: input.feedback ?? null,
    repositoryId: input.repositoryId,
    baseCommitSha: input.baseCommitSha,
    workspaceRevision: input.workspaceRevision,
    sourceIdentity: sourceIdentity ?? null,
    policy: {
      protectTests: input.policy?.protectTests === true,
      protectInfrastructure: input.policy?.protectInfrastructure === true,
      protectedPaths: [...(input.policy?.protectedPaths ?? [])],
    },
    hardStepLimit: input.hardStepLimit ?? null,
  };
}

/** A partial line remains explicitly partial; this is a display projection, never source identity. */
export function boundPlanSnippet(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let low = 0,
    high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Do not split a UTF-16 surrogate pair.
  if (low > 0 && /[\uD800-\uDBFF]/u.test(text[low - 1]!)) low--;
  const prefix = text.slice(0, low);
  const newline = prefix.lastIndexOf("\n");
  return newline > 0 ? prefix.slice(0, newline) : prefix;
}

export function planEvidenceRows(
  input: PlanContextInput,
  maxSnippetBytes: number,
): { rows: PlanEvidenceRow[]; omitted: number; rejected: string[] } {
  const rows: PlanEvidenceRow[] = [],
    rejected: string[] = [];
  const seen = new Set<string>();
  let remaining = maxSnippetBytes,
    omitted = 0;
  const add = (item: EvidenceItem) => {
    let path: string;
    try {
      path = planSourcePath(item.path);
    } catch {
      rejected.push(item.path);
      return;
    }
    if (
      item.repositoryId !== input.repositoryId ||
      item.baseCommitSha !== input.baseCommitSha ||
      !/^[a-f0-9]{64}$/iu.test(item.contentHash) ||
      !item.snippet ||
      !Number.isInteger(item.startLine) ||
      item.startLine < 1 ||
      item.endLine < item.startLine
    ) {
      rejected.push(item.path);
      return;
    }
    const key = [path, item.contentHash, item.startLine, item.endLine, planHash(item.snippet)].join(
      ":",
    );
    if (seen.has(key)) return;
    seen.add(key);
    const snippet = boundPlanSnippet(item.snippet, Math.min(remaining, 3072));
    if (!snippet) {
      omitted++;
      return;
    }
    remaining -= Buffer.byteLength(snippet);
    const endLine = Math.min(item.endLine, item.startLine + snippet.split("\n").length - 1);
    rows.push({
      id: planHash(key).slice(0, 24),
      repositoryId: input.repositoryId,
      baseCommitSha: input.baseCommitSha,
      workspaceRevision: input.workspaceRevision,
      viewRevision: item.viewRevision,
      path,
      contentHash: item.contentHash,
      snippetHash: planHash(snippet),
      startLine: item.startLine,
      endLine,
      sourceVerified: false,
      truncated: item.truncated || snippet !== item.snippet,
      snippet,
      symbol: item.symbol,
      fileType: item.fileType,
      reason: item.reason,
    });
  };
  if (
    input.localizationEvidence?.baseCommitSha === input.baseCommitSha &&
    input.localizationEvidence.evidenceState?.workspaceRevision === input.workspaceRevision
  ) {
    for (const item of input.localizationEvidence.implementationEvidence ?? [])
      add({
        ...item,
        repositoryId: input.repositoryId,
        baseCommitSha: input.baseCommitSha,
        viewRevision: input.evidence?.viewRevision ?? String(input.workspaceRevision),
        reason: item.explanation,
        retrievalSource: ["IMPLEMENTATION_NAVIGATION"],
        score: 1,
        language: item.language ?? "unknown",
        module: item.module ?? "",
        fileType: item.fileType ?? "SOURCE",
        parseStatus: item.parseStatus ?? "PARSED",
        signature: null,
        directImports: item.directImports ?? [],
        truncated: true,
      });
  }
  for (const item of input.evidence?.evidence ?? []) add(item);
  if (input.localizationEvidence?.baseCommitSha === input.baseCommitSha) {
    for (const item of input.localizationEvidence.candidates) {
      // Localization candidates already present in deterministic evidence are references only.
      if (
        rows.some(
          (row) =>
            row.path === item.path &&
            row.contentHash === item.contentHash &&
            row.startLine <= item.startLine &&
            row.endLine >= item.endLine,
        )
      )
        continue;
      add({
        ...item,
        repositoryId: input.repositoryId,
        baseCommitSha: input.baseCommitSha,
        viewRevision: input.evidence?.viewRevision ?? String(input.workspaceRevision),
        reason: item.explanation,
        retrievalSource: ["ISSUE_LOCALIZATION"],
        score: 0,
        language: item.language ?? "unknown",
        module: item.module ?? "",
        fileType: item.fileType ?? "SOURCE",
        parseStatus: item.parseStatus ?? "LEXICAL",
        signature: null,
        directImports: item.directImports ?? [],
        truncated: true,
      });
    }
  }
  return { rows, omitted, rejected };
}

/** Never serializes a repository manifest, duplicate localization snippets, or retrieval metrics. */
export function planContextText(
  host: PlanHostState,
  rows: readonly PlanEvidenceRow[],
  input: PlanContextInput,
  observations: readonly string[],
): string {
  return JSON.stringify({
    hostState: {
      ...host,
      // Protected host paths can identify hidden evaluation material. Never disclose them.
      policy: {
        publicTestsReadOnly: host.policy.protectTests,
        infrastructureReadOnly: host.policy.protectInfrastructure,
        editScopeCheckedByHost: true,
      },
    },
    evidence: rows.map(
      ({
        repositoryId: _repository,
        baseCommitSha: _base,
        workspaceRevision: _revision,
        ...row
      }) => ({
        ...row,
        access: { inspect: true, edit: !planEditProtected(row.path, host.policy) },
      }),
    ),
    coverage: {
      incomplete: input.evidence?.incomplete ?? true,
      truncated: (input.evidence?.truncated ?? false) || rows.some((row) => row.truncated),
      missingInformation: input.evidence?.missingInformation ?? [],
      manifestNotIncluded: true,
    },
    hypotheses: {
      candidates: input.evidence?.rootCauseCandidates ?? [],
      excluded: input.evidence?.excludedHypotheses ?? [],
      localization:
        input.localizationEvidence === undefined
          ? null
          : {
              summary: input.localizationEvidence.summary,
              uncertainty: input.localizationEvidence.uncertainty,
              ...(input.localizationEvidence.evidenceState?.workspaceRevision ===
              host.workspaceRevision
                ? {
                    evidenceState: {
                      ...input.localizationEvidence.evidenceState,
                      observedImplementations:
                        input.localizationEvidence.evidenceState.observedImplementations.map(
                          (ref) => ({
                            evidenceIds: rows
                              .filter(
                                (row) =>
                                  row.path === ref.path &&
                                  row.contentHash === ref.contentHash &&
                                  row.startLine <= ref.endLine &&
                                  row.endLine >= ref.startLine,
                              )
                              .map((row) => row.id),
                            path: ref.path,
                            symbol: ref.symbol,
                          }),
                        ),
                    },
                  }
                : {}),
              ...(input.localizationEvidence.graph?.baseCommitSha === host.baseCommitSha &&
              input.localizationEvidence.graph.workspaceRevision === host.workspaceRevision
                ? { graph: input.localizationEvidence.graph }
                : {}),
              candidates: input.localizationEvidence.candidates.map((candidate) => ({
                evidenceIds: rows
                  .filter(
                    (row) =>
                      row.path === candidate.path && row.contentHash === candidate.contentHash,
                  )
                  .map((row) => row.id),
                explanation: candidate.explanation,
              })),
            },
    },
    observations,
  });
}
