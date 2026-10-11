import { DevflowError } from "@devflow/shared";
import type { EvidenceItem } from "./contracts.js";
import { hash } from "./contracts.js";
import type { IssueLocalizationResult, LocalizationCandidate } from "./issue-localization-agent.js";
import type { RelationGraphArtifact } from "./relation-graph.js";

export type LocalizationMode = "legacy" | "legacy-dynamic" | "prg";
export interface LocalizationInvestigationState {
  version: "localization-investigation-v1";
  mode: Exclude<LocalizationMode, "legacy">;
  sourceIdentity: string;
  baseCommitSha: string;
  /** Unacknowledged work cannot be automatically dispatched again. */
  phase: "READY" | "DISPATCH_RESERVED" | "IO_RESERVED" | "STOPPED";
  actionId: string | null;
  metrics: IssueLocalizationResult["metrics"];
  evidence: EvidenceItem[];
  sourceCache: [string, { content: string; truncated: boolean }][];
  anchors: string[];
  latestReads: string[];
  progressKeys: string[];
  progressCoverage: [string, [number, number][]][];
  seenQueries: string[];
  seenReads: string[];
  observations: string[];
  summary: string;
  uncertainty: string[];
  candidates: LocalizationCandidate[];
  implementationEvidence: LocalizationCandidate[];
  pendingReads: NonNullable<NonNullable<IssueLocalizationResult["evidenceState"]>["pendingReads"]>;
  navigationMissing: string[];
  decisions: number;
  lengthRegenerations: number;
  stalledRounds: number;
  exitReason: string;
  graph?: RelationGraphArtifact;
  /** Untruncated host frontier; the model receives only a paginated projection. */
  frontier?: { path: string; score: number; status: string }[];
  hypotheses?: { explanation: string; query: string }[];
}

export function validateInvestigationResume(
  state: LocalizationInvestigationState,
  identity: string | undefined,
  base: string,
  mode: LocalizationMode,
) {
  const fail = (reason: string): never => {
    throw new DevflowError({
      code: "INSUFFICIENT_EVIDENCE",
      message: reason,
      details: { stopReason: "LOCALIZATION_RESUME_UNCERTAIN", requestIssued: false },
    });
  };
  if (
    state.version !== "localization-investigation-v1" ||
    state.mode !== mode ||
    !identity ||
    state.sourceIdentity !== identity ||
    state.baseCommitSha !== base
  )
    fail("Localization checkpoint identity or frozen mode differs.");
  if (!["READY", "STOPPED"].includes(state.phase))
    fail(
      "Localization action outcome is unconfirmed; reserved consumption is retained and work is not reissued.",
    );
  if (
    !state.metrics ||
    ![
      state.metrics.modelCalls,
      state.metrics.totalTokens,
      state.metrics.reads,
      state.metrics.searches,
      state.decisions,
      state.stalledRounds,
      state.lengthRegenerations,
    ].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    fail("Localization checkpoint consumption cannot be verified.");
  const cache = new Map(state.sourceCache);
  for (const e of state.evidence) {
    const source = cache.get(e.path);
    if (
      source &&
      (source.truncated ||
        hash(source.content) !== e.contentHash ||
        source.content
          .split(/\r?\n/u)
          .slice(e.startLine - 1, e.endLine)
          .join("\n") !== e.snippet)
    )
      fail("Localization checkpoint contains stale source evidence.");
  }
  return state;
}
