import { createHash } from "node:crypto";
import { DevflowError, type AgentPlan } from "@devflow/shared";
import type { ModelMessage } from "./model.js";
import type { AgentState } from "./state.js";

/** Only the workflow supplies this object, after validation/review or a new PLAN approval. */
export interface HostCodingContinuation {
  id: string;
  kind: "PUBLIC_VALIDATION" | "INDEPENDENT_REVIEW" | "APPROVAL";
  feedback: string;
  /** Host-verified identity of candidate, validation profile and/or review result. */
  sourceIdentity?: string;
  /** Omitted/true is conservative; only a complete host observation permits false. */
  observedSourceChanged?: boolean;
}

const boundary = "HOST_CODING_SOURCE_BOUNDARY:";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function continueCodingSession(
  state: AgentState | undefined,
  continuation: HostCodingContinuation,
  current: { approvedPlan?: AgentPlan; stableTaskContext?: string; additionalContext?: string },
): { state: AgentState; accepted: boolean } {
  if (!state || !continuation.id.trim() || !continuation.feedback.trim())
    throw new DevflowError({
      code: "CONFLICT",
      message:
        "Coding continuation requires a saved session, a stable host ID and observed feedback.",
      details: { requestIssued: false },
    });
  const fingerprint = digest({
    ...continuation,
    id: undefined,
    approvedPlan: current.approvedPlan,
  });
  const existing = state.codingContinuations?.find((record) => record.id === continuation.id);
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new DevflowError({
        code: "CONFLICT",
        message: "Coding continuation ID was reused with different feedback or approval.",
        details: { requestIssued: false },
      });
    return { state, accepted: false };
  }
  if (
    !state.finalResult ||
    state.codingContinuations?.some((record) => record.fingerprint === fingerprint)
  )
    throw new DevflowError({
      code: "CONFLICT",
      message:
        "Coding continuation needs a completed handoff and new host evidence; duplicate feedback cannot reopen it.",
      details: { requestIssued: false },
    });
  if (["CANCELLED", "TIMED_OUT"].includes(state.phase))
    throw new DevflowError({
      code: "CONFLICT",
      message: "A cancelled or expired Coding Session cannot be reopened.",
      details: { requestIssued: false },
    });
  if (
    (continuation.kind === "APPROVAL" && !current.approvedPlan) ||
    (continuation.kind !== "APPROVAL" &&
      current.approvedPlan &&
      digest(current.approvedPlan) !== digest(state.plan))
  )
    throw new DevflowError({
      code: "CONFLICT",
      message: "Only a new host APPROVAL continuation can replace the approved Coding plan.",
      details: { requestIssued: false },
    });
  const next: AgentState = {
    ...state,
    phase: "IDLE",
    messages: [
      ...state.messages,
      {
        role: "SYSTEM",
        content:
          boundary +
          JSON.stringify({
            id: continuation.id,
            invalidateSource: continuation.observedSourceChanged !== false,
          }),
      },
      {
        role: "USER",
        content:
          "Host Coding Loop feedback (same session; no new resources or permissions):\n" +
          JSON.stringify(continuation),
      },
      ...(current.approvedPlan
        ? [
            {
              role: "USER" as const,
              content: `Approved plan (follow this plan):\n${JSON.stringify(current.approvedPlan, null, 2)}`,
            },
          ]
        : []),
      ...(current.stableTaskContext
        ? [
            {
              role: "USER" as const,
              content: `Stable Coding task state (requirements persist; source citations must be refreshed):\n${current.stableTaskContext}`,
            },
          ]
        : []),
      ...(current.additionalContext
        ? [
            {
              role: "USER" as const,
              content: `Repository/stage evidence:\n${current.additionalContext}`,
            },
          ]
        : []),
    ],
    codingContinuations: [
      ...(state.codingContinuations ?? []),
      { id: continuation.id, fingerprint, kind: continuation.kind, step: state.stepCount },
    ],
    ...(current.approvedPlan ? { plan: current.approvedPlan } : {}),
    ...(state.postPatch ? { postPatch: { ...state.postPatch, completionDecision: false } } : {}),
    ...(state.executionRecovery
      ? {
          executionRecovery: {
            ...state.executionRecovery,
            // These are transient admission decisions. Every new request recalculates the same hard reserve.
            explorationClosed: false,
            submissionOnly: false,
            handoffPending: false,
            authorizationHandoffUsed: false,
          },
        }
      : {}),
  };
  delete next.finalResult;
  delete next.lastError;
  return { state: next, accepted: true };
}

/** Preserve full history on disk. Only old source records/old approval views are projected out. */
export function projectCodingSessionHistory(history: readonly ModelMessage[]): ModelMessage[] {
  let invalidBefore = -1;
  let latestPlan = -1;
  for (let index = 0; index < history.length; index++) {
    const message = history[index]!;
    if (message.role === "SYSTEM" && message.content.startsWith(boundary)) {
      const record = JSON.parse(message.content.slice(boundary.length)) as {
        invalidateSource?: boolean;
      };
      if (record.invalidateSource) invalidBefore = index;
    }
    if (message.role === "USER" && message.content.startsWith("Approved plan (follow this plan):"))
      latestPlan = index;
  }
  return history.map((message, index) => {
    if (
      message.role === "USER" &&
      message.content.startsWith("Approved plan (follow this plan):") &&
      index < latestPlan
    )
      return {
        ...message,
        content:
          "Earlier approval is superseded. Only the latest host-approved plan authorizes writes.",
      };
    if (index >= invalidBefore) return message;
    if (
      message.role === "TOOL" &&
      [
        "readFile",
        "batchReadFiles",
        "locateIssue",
        "queryRelations",
        "searchCode",
        "gitDiff",
      ].includes(message.toolName)
    )
      return {
        ...message,
        content: {
          stale: true,
          previousResultHash: digest(message.content),
          note: "Host validation may have changed source. Use current host evidence or a fresh read; diagnostic and task records remain valid.",
        },
      };
    if (message.role === "USER" && message.content.startsWith("Repository/stage evidence:"))
      return {
        ...message,
        content:
          "Earlier versioned source evidence is stale after host validation; current source must be verified.",
      };
    return message;
  });
}
