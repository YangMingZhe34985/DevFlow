import type { WorkingCode } from "@devflow/agent";
import type { RunResult } from "@devflow/shared";
import type { SandboxSession } from "@devflow/sandbox";
import { graphPathAllowed } from "../localization/relation-graph.js";

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
