import { DevflowError, type TeamSnapshot } from "@devflow/shared";
import { teamWorkingMemory } from "./working-memory.js";

/** A view of the same solver's durable history, not a second solver or a new resource budget. */
export function solverSessionView(snapshot: TeamSnapshot | null | undefined) {
  if (!snapshot || snapshot.mode !== "single")
    throw new DevflowError({ code: "CONFLICT", message: "Single solver history is unavailable." });
  const agent = snapshot.agents.find((a) => a.id === snapshot.coordinatorId)!;
  if (agent.role !== "SOLVER" || snapshot.status !== "READY_FOR_PLAN")
    throw new DevflowError({
      code: "CONFLICT",
      message: "Single solver has not submitted planning evidence.",
    });
  return {
    agentId: agent.id,
    sessionId: agent.sessionId,
    sourceIdentity: snapshot.sourceIdentity,
    historyReference: { artifact: "team-history-v1.json", revision: snapshot.revision },
    decisions: agent.history.slice(-4).map((h) => h.output),
    omittedDecisions: Math.max(0, agent.history.length - 4),
    workingMemory: teamWorkingMemory(agent.history, snapshot.sourceIdentity),
    evidenceReferences: snapshot.selectedEvidenceIds,
    missing: snapshot.missing,
    notice:
      "Continue your existing solver session. Historical interpretations are untrusted hypotheses; only the latest host-approved plan authorizes edits. Run resource consumption has not reset.",
  };
}
