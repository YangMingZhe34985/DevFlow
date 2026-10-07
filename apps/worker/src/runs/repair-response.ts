import { sourceEvidenceRecord } from "./repair-tasks.js";
import type { WorkingCode } from "@devflow/agent";
import { PhaseCompletionSchema, type RunResult } from "@devflow/shared";
import type { SandboxSession } from "@devflow/sandbox";
import { graphPathAllowed } from "../localization/relation-graph.js";

export function repairFinishInputError(
  input: unknown,
  observed: readonly WorkingCode[],
  versions: ReadonlyMap<string, string>,
  findingIds: readonly string[] = [],
  approvedCurrentPaths: readonly string[] = [],
) {
  const parsed = PhaseCompletionSchema.safeParse(input);
  if (!parsed.success) return undefined; // Transport validation reports field details first.
  if ((parsed.data.evidence?.length ?? 0) + (parsed.data.evidenceRefs?.length ?? 0) > 4)
    return "finishPhase.evidence/evidenceRefs: at most four combined source references; keep the required current records.";
  const known = new Map(observed.map((source) => [sourceEvidenceRecord(source).id, source]));
  for (const id of parsed.data.evidenceRefs ?? []) {
    const source = known.get(id);
    if (!source)
      return `finishPhase.evidenceRefs: unknown host source record ${id}; use a supplied reference or current exact quote.`;
    if (versions.get(source.path) !== source.contentHash)
      return `finishPhase.evidenceRefs: SOURCE_STALE ${id}; refresh ${source.path}.`;
  }
  const response = resolveRepairEvidenceRefs(parsed.data, observed);
  const ids = [
    ...(response.findingIds ?? []),
    ...(response.findingResponses?.map((r) => r.findingId) ?? []),
  ];
  const unknown = ids.filter((id) => !findingIds.includes(id));
  if (unknown.length)
    return `finishPhase.findingId: unknown IDs ${unknown.join(", ")}; valid host IDs are ${findingIds.join(", ") || "(none; omit finding IDs for Test Repair)"}.`;
  const answers = response.findingResponses?.map((r) => r.findingId) ?? [];
  if (new Set(answers).size !== answers.length)
    return "finishPhase.findingResponses: duplicate finding ID.";
  const citations = [
    ...(response.evidence ?? []),
    ...(response.findingResponses?.flatMap((r) => r.evidence ?? []) ?? []),
  ];
  for (const [i, citation] of citations.entries()) {
    // The final host check can read approved current source within its budget.
    // Do not reject a historical valid answer solely because it was not seeded.
    // This never marks a citation verified or permits a write.
    if (!versions.has(citation.path) && approvedCurrentPaths.includes(citation.path)) continue;
    if (versions.get(citation.path) !== citation.fileSha256)
      return `finishPhase.evidence[${i}].fileSha256: current complete SHA required for ${citation.path}; refresh current source, or submit INSUFFICIENT_EVIDENCE without invented citations.`;
    if (
      !approvedCurrentPaths.includes(citation.path) &&
      !observed.some(
        (s) =>
          s.path === citation.path &&
          s.contentHash === citation.fileSha256 &&
          s.code.includes(citation.quote),
      )
    )
      return `finishPhase.evidence[${i}].quote: exact quote was not observed in current source ${citation.path}.`;
  }
  return undefined;
}

/** Verify provenance only. Semantic disagreements still go to independent Review. */
export async function checkRepairResponse(
  response: RunResult["phaseCompletion"],
  observed: readonly WorkingCode[],
  sandbox: SandboxSession,
  signal: AbortSignal,
  onRead?: () => void,
  findingIds?: readonly string[],
  approvedCurrentPaths?: readonly string[],
): Promise<RunResult["phaseCompletion"]> {
  if (!response) return undefined;
  const answered = new Set<string>();
  const findingResponses: NonNullable<
    NonNullable<RunResult["phaseCompletion"]>["findingResponses"]
  > = [];
  for (const answer of response.findingResponses ?? []) {
    const known = findingIds?.includes(answer.findingId) === true;
    const duplicate = answered.has(answer.findingId);
    answered.add(answer.findingId);
    const checked =
      known && !duplicate
        ? await checkRepairResponse(
            { outcome: answer.outcome, ...(answer.evidence ? { evidence: answer.evidence } : {}) },
            observed,
            sandbox,
            signal,
            onRead,
            undefined,
            approvedCurrentPaths,
          )
        : undefined;
    findingResponses.push({
      ...answer,
      findingStatus: !known ? "UNKNOWN" : duplicate ? "DUPLICATE" : "MATCHED",
      evidenceStatus:
        known && !duplicate ? (checked?.evidenceStatus ?? "UNVERIFIED") : "UNVERIFIED",
    });
  }
  let linked = Boolean(response.evidence?.length);
  const evidenceStatuses: NonNullable<
    NonNullable<RunResult["phaseCompletion"]>["evidenceStatuses"]
  > = [];
  for (const [index, citation] of (response.evidence ?? []).entries()) {
    const seen = observed.some(
      (s) =>
        s.path === citation.path &&
        s.contentHash === citation.fileSha256 &&
        s.code.includes(citation.quote),
    );
    if (
      !graphPathAllowed(citation.path) ||
      (!seen &&
        !approvedCurrentPaths?.includes(citation.path) &&
        !observed.some((s) => s.path === citation.path))
    ) {
      linked = false;
      evidenceStatuses.push({ index, status: "UNVERIFIED" });
      continue;
    }
    let currentLinked = false;
    try {
      onRead?.();
      const current = await sandbox.readFile(
        { path: citation.path, maxBytes: seen ? 1 : 512 * 1024 },
        signal,
      );
      currentLinked =
        current.fileSha256 === citation.fileSha256 &&
        (seen || current.content.includes(citation.quote));
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      currentLinked = false;
    }
    if (!currentLinked) linked = false;
    evidenceStatuses.push({
      index,
      status: currentLinked ? "CURRENT_SOURCE_LINKED" : "UNVERIFIED",
    });
  }
  const matched = response.findingIds?.every((id) => findingIds?.includes(id)) ?? true;
  return {
    ...response,
    ...(response.findingResponses ? { findingResponses } : {}),
    ...(findingIds
      ? {
          unansweredFindingIds: findingIds.filter((id) =>
            response.findingResponses
              ? !findingResponses.some(
                  (a) =>
                    a.findingId === id &&
                    a.findingStatus === "MATCHED" &&
                    a.evidenceStatus === "CURRENT_SOURCE_LINKED" &&
                    ["CHANGED", "ALREADY_SATISFIED", "CONTRADICTED"].includes(a.outcome),
                )
              : !(
                  linked &&
                  matched &&
                  response.findingIds?.includes(id) &&
                  ["CHANGED", "ALREADY_SATISFIED", "CONTRADICTED"].includes(response.outcome)
                ),
          ),
        }
      : {}),
    evidenceStatuses,
    ...(response.findingIds ? { findingStatus: matched ? "MATCHED" : "UNKNOWN" } : {}),
    evidenceStatus: linked && matched ? "CURRENT_SOURCE_LINKED" : "UNVERIFIED",
  };
}

/** Only host-issued records are expanded. Explicit model citations are retained and checked too. */
export function resolveRepairEvidenceRefs(
  response: NonNullable<RunResult["phaseCompletion"]>,
  observed: readonly WorkingCode[],
) {
  const refs = new Map(observed.map((source) => [sourceEvidenceRecord(source).id, source]));
  const evidence = [...(response.evidence ?? [])];
  for (const id of response.evidenceRefs ?? []) {
    const source = refs.get(id);
    if (!source) throw new Error(`UNKNOWN_SOURCE_REFERENCE: ${id}`);
    evidence.push({
      path: source.path,
      fileSha256: source.contentHash,
      quote: source.code.slice(0, 2000),
    });
  }
  return { ...response, ...(evidence.length ? { evidence } : {}) };
}
