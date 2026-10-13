import { DevflowError, teamCanonicalJson, type TeamSnapshot } from "@devflow/shared";
import { createHash } from "node:crypto";
import { isTestFile, type EvidencePack, type EvidenceItem } from "../localization/contracts.js";

/** Public observations and attributed claims, never root-cause or write authority. */
export function teamInvestigationHandoff(state: TeamSnapshot) {
  const current = state.evidence.filter(
    (e) => e.valid && e.sourceIdentity === state.sourceIdentity,
  );
  const challenges = state.messages.filter(
    (m) => m.type === "CHALLENGE" && m.sourceIdentity === state.sourceIdentity,
  );
  const ids = new Set([...state.selectedEvidenceIds, ...challenges.flatMap((m) => m.evidenceIds)]);
  const records = current.filter((e) => ids.has(e.id));
  if ([...ids].some((id) => !current.some((e) => e.id === id)))
    throw new DevflowError({
      code: "INSUFFICIENT_EVIDENCE",
      message: "TEAM_HANDOFF_EVIDENCE_UNAVAILABLE",
      details: {
        requestIssued: false,
        missingEvidenceIds: [...ids].filter((id) => !current.some((e) => e.id === id)),
      },
    });
  for (const e of records)
    if (
      e.runId !== state.runId ||
      e.repositoryId !== state.repositoryId ||
      e.contentSha256 !== createHash("sha256").update(teamCanonicalJson(e.content)).digest("hex")
    )
      throw new DevflowError({ code: "CONFLICT", message: "TEAM_HANDOFF_IDENTITY_INVALID" });
  return {
    version: "team-investigation-handoff-v1" as const,
    sourceIdentity: state.sourceIdentity,
    teamRevision: state.revision,
    notice:
      "Investigation claims and open questions, not confirmed causes or edit authorization. Original Issue and latest approved Plan govern scope. Historical claims must be reconciled with current source and public failures; do not erase counterevidence or treat every hypothesis as a required change.",
    tasks: state.tasks
      .filter((t) => t.sourceIdentity === state.sourceIdentity)
      .map((t) => ({
        taskId: t.id,
        agentId: t.agentId,
        status: t.status,
        ...(t.reason ? { reason: t.reason } : {}),
        hypotheses: t.result?.hypotheses ?? [],
        missing: t.result?.missing ?? [],
        evidenceIds: t.result?.evidenceIds ?? t.evidenceIds,
      })),
    missing: state.missing,
    challenges: challenges.map((m) => ({
      messageId: m.id,
      from: m.from,
      to: m.to,
      taskId: m.taskId,
      body: m.body,
      evidenceIds: m.evidenceIds,
    })),
    references: records.map((e) => ({
      id: e.id,
      kind: e.kind,
      sourceOperationId: e.sourceOperationId,
      ...(e.path ? { path: e.path } : {}),
      ...(e.fileSha256 ? { contentHash: e.fileSha256 } : {}),
      ...(e.startLine ? { startLine: e.startLine } : {}),
      ...(e.endLine ? { endLine: e.endLine } : {}),
    })),
    observations: records
      .filter((e) => e.kind !== "SOURCE_OBSERVATION")
      .map((e) => ({ id: e.id, kind: e.kind, content: e.content })),
  };
}
export type TeamInvestigationHandoff = ReturnType<typeof teamInvestigationHandoff>;

export function teamEvidencePack(
  state: TeamSnapshot,
  template: EvidencePack,
  baseCommit: string,
): EvidencePack {
  const handoff = teamInvestigationHandoff(state);
  const retainedIds = new Set(handoff.references.map((e) => e.id));
  const sources: EvidenceItem[] = state.evidence
    .filter(
      (e) =>
        e.valid &&
        e.sourceIdentity === state.sourceIdentity &&
        retainedIds.has(e.id) &&
        e.kind === "SOURCE_OBSERVATION" &&
        e.path &&
        e.fileSha256 &&
        e.startLine &&
        e.endLine,
    )
    .map((e) => ({
      repositoryId: state.repositoryId,
      baseCommitSha: baseCommit,
      viewRevision: template.viewRevision,
      path: e.path!,
      contentHash: e.fileSha256!,
      startLine: e.startLine!,
      endLine: e.endLine!,
      symbol: null,
      reason: "Team-selected public observation or counterevidence; cause remains a hypothesis",
      retrievalSource: ["TEAM", e.sourceOperationId],
      score: 1,
      snippet: e.content,
      language: e.path!.split(".").at(-1) ?? "unknown",
      module: e.path!.split("/").slice(0, -1).join("/"),
      fileType: isTestFile(e.path!) ? "TEST" : "SOURCE",
      parseStatus: "LEXICAL",
      signature: null,
      directImports: [],
      truncated: true,
    }));
  // Choosing implementation records must not silently discard already retrieved public assertions.
  const publicTests = template.evidence.filter(
    (e) =>
      e.fileType === "TEST" &&
      e.repositoryId === state.repositoryId &&
      e.baseCommitSha === baseCommit &&
      e.viewRevision === template.viewRevision &&
      !sources.some(
        (s) =>
          s.path === e.path &&
          s.contentHash === e.contentHash &&
          s.startLine <= e.startLine &&
          s.endLine >= e.endLine,
      ),
  );
  return {
    ...template,
    teamHandoff: handoff,
    evidence: sources.length ? [...publicTests, ...sources] : template.evidence,
    missingInformation: teamHandoffGaps(handoff, template.missingInformation),
  };
}

/** Stable task memory survives edits; source bodies/observations must be refreshed separately. */
export function codingTeamFollowup(state: TeamSnapshot) {
  const handoff = teamInvestigationHandoff(state);
  return {
    version: handoff.version,
    sourceIdentity: handoff.sourceIdentity,
    teamRevision: handoff.teamRevision,
    notice:
      "Historical investigation, not current source evidence or authority. Reconcile open questions and counterevidence against latest Plan, current SHA and public diagnostics; do not treat local edits as proof that all Issue behaviors are fixed. A new target still requires approval.",
    tasks: handoff.tasks,
    missing: handoff.missing,
    challenges: handoff.challenges,
    references: handoff.references,
    sourceBodies:
      "Not repeated; inspect current source when needed. Full investigation: team-history-v1.json",
  };
}

/** The Planner has its own IDs and may omit source. Never imply that host-held source was shown. */
export function projectTeamHandoff(
  handoff: TeamInvestigationHandoff,
  rows: readonly {
    id: string;
    path: string;
    contentHash: string;
    startLine: number;
    endLine: number;
  }[],
) {
  return {
    ...handoff,
    unforwardedTaskEvidenceIds: [...new Set(handoff.tasks.flatMap((t) => t.evidenceIds))].filter(
      (id) => !handoff.references.some((ref) => ref.id === id),
    ),
    references: handoff.references.map((ref) => {
      const matches = rows.filter(
        (row) =>
          row.path === ref.path &&
          row.contentHash === ref.contentHash &&
          row.startLine <= (ref.startLine ?? 0) &&
          row.endLine >= (ref.endLine ?? Infinity),
      );
      return {
        ...ref,
        planEvidenceIds: matches.map((row) => row.id),
        display:
          ref.kind !== "SOURCE_OBSERVATION"
            ? "OBSERVATION_INCLUDED"
            : matches.length
              ? "RANGE_COVERED"
              : "NOT_FULLY_VISIBLE",
      };
    }),
    visibilityNotice:
      "Task evidenceIds refer to team history; cite planEvidenceIds for this Planner view. Unforwarded task references are not observed code. RANGE_COVERED describes displayed source ranges only; it does not establish behavioral sufficiency or causal correctness. NOT_FULLY_VISIBLE requires targeted evidence if needed for the decision.",
  };
}

/** Keep every explicit gap; Coordinator omission does not close an Investigator's result. */
export function teamHandoffGaps(
  handoff: TeamInvestigationHandoff,
  prior: EvidencePack["missingInformation"],
) {
  return [
    ...new Set([
      ...prior,
      ...handoff.missing,
      ...handoff.tasks.flatMap((t) => [
        ...t.missing.map((m) => `Unresolved investigation (${t.taskId}): ${m}`),
        ...t.hypotheses.map((h) => `Unverified team hypothesis (${t.taskId}): ${h}`),
        ...(["BLOCKED", "CANCELLED", "READY", "RUNNING", "WAITING"].includes(t.status)
          ? [
              `Investigation ${t.taskId} is ${t.status}${t.reason ? `: ${t.reason}` : ""}; coverage is not confirmed.`,
            ]
          : []),
      ]),
    ]),
  ];
}
