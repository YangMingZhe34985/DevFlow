import type { TeamAgent } from "@devflow/shared";
import { teamDigest } from "./engine.js";

/** Rebuilt from the durable private checkpoint, never from another Agent's chat. */
export function teamWorkingMemory(history: TeamAgent["history"], sourceIdentity: string) {
  const hypotheses = new Set<string>(),
    missing = new Set<string>();
  const actions = new Map<string, { decision: number; action: unknown }>();
  const counterarguments = new Map<string, { decision: number; text: string }>();
  const historical: { decision: number; sha256: string; reason: string }[] = [];
  for (const [index, turn] of history.entries()) {
    const identity =
      turn.input && typeof turn.input === "object"
        ? (turn.input as { sourceIdentity?: unknown }).sourceIdentity
        : undefined;
    if (identity !== sourceIdentity) {
      historical.push({
        decision: index + 1,
        sha256: teamDigest(turn.output),
        reason: "SOURCE_IDENTITY_UNKNOWN_OR_CHANGED",
      });
      continue;
    }
    for (const action of turn.output.actions) {
      if (action.type === "RESULT") action.hypotheses.forEach((h) => hypotheses.add(h));
      if ("missing" in action) action.missing.forEach((m) => missing.add(m));
      // These are attempted directions, not evidence that the action executed or found a cause.
      if (["READ", "SEARCH", "RELATIONS"].includes(action.type))
        actions.set(teamDigest(action), { decision: index + 1, action });
    }
    if (/refut|contradict|counterevidence|反证/iu.test(turn.output.summary))
      counterarguments.set(turn.output.summary, { decision: index + 1, text: turn.output.summary });
  }
  return {
    version: "team-working-memory-v1",
    sourceIdentity,
    historySha256: teamDigest(history),
    hypotheses: [...hypotheses],
    unresolvedOrUnreconciled: [...missing],
    investigatedDirections: [...actions.values()],
    counterarguments: [...counterarguments.values()],
    historical,
    notice:
      "Derived from your durable private decisions. Hypotheses and attempted actions are not verified facts. Missing items are retained until explicitly reconciled against current evidence. Old-source decisions do not prove current behavior.",
  };
}
