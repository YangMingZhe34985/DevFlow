import { createHash } from "node:crypto";
import { AgentPlanSchema, DevflowError, type AgentPlan } from "@devflow/shared";
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
// These records describe one completed decision segment, rather than task evidence.
// Keep their original contents on disk; only their active request projection expires.
const transientControlPrefixes = [
  "HOST_AUTHORIZATION_HANDOFF:",
  "HOST_SUBMISSION_RESERVE:",
  "HOST_TIME_RESERVE:",
  "HOST_CONVERGENCE:",
  "HOST_REPAIR_LENGTH_RECOVERY:",
  "One shared bounded correction decision:",
  "One bounded edit correction is available.",
  "Convergence warning:",
] as const;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)) ?? "undefined")
    .digest("hex");

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
  const approvedPlan = current.approvedPlan
    ? AgentPlanSchema.parse(current.approvedPlan)
    : undefined;
  const fingerprint = digest({
    ...continuation,
    id: undefined,
    approvedPlan,
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
    (continuation.kind === "APPROVAL" && !approvedPlan) ||
    (continuation.kind !== "APPROVAL" &&
      approvedPlan &&
      digest(approvedPlan) !== digest(state.plan))
  )
    throw new DevflowError({
      code: "CONFLICT",
      message: "Only a new host APPROVAL continuation can replace the approved Coding plan.",
      details: { requestIssued: false },
    });
  const approvalChanged =
    continuation.kind === "APPROVAL" && approvedPlan && digest(approvedPlan) !== digest(state.plan);
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
            // A same-approval resume cannot grant a fresh authorization handoff.
            // Only the host's distinct approved plan invalidates the prior scope refusal.
            ...(approvalChanged ? { authorizationHandoffUsed: false } : {}),
          },
        }
      : {}),
  };
  delete next.finalResult;
  delete next.lastError;
  return { state: next, accepted: true };
}

/** Preserve history on disk; project out stale source, approval and transient control views. */
export function projectCodingSessionHistory(history: readonly ModelMessage[]): ModelMessage[] {
  let invalidBefore = -1;
  let controlBefore = -1;
  let latestPlan = -1;
  const stableRecords = history.flatMap((message, index) =>
    message.role === "USER" &&
    (message.content.startsWith("Stable Coding task state") ||
      message.content.startsWith("Stable Repair task state"))
      ? [{ index, content: message.content }]
      : [],
  );
  for (let index = 0; index < history.length; index++) {
    const message = history[index]!;
    if (message.role === "SYSTEM" && message.content.startsWith(boundary)) {
      const record = JSON.parse(message.content.slice(boundary.length)) as {
        invalidateSource?: boolean;
      };
      controlBefore = index;
      if (record.invalidateSource) invalidBefore = index;
    }
    if (message.role === "USER" && message.content.startsWith("Approved plan (follow this plan):"))
      latestPlan = index;
  }
  return history.map((message, index) => {
    if (
      index < controlBefore &&
      message.role === "USER" &&
      transientControlPrefixes.some((prefix) => message.content.startsWith(prefix))
    )
      return {
        ...message,
        content:
          "Historical host control decision is superseded by the current Coding continuation. " +
          "Current tool policy and persisted resource consumption remain authoritative. " +
          JSON.stringify({ historyIndex: index, previousRecordSha256: digest(message.content) }),
      };
    if (message.role === "USER" && message.content.startsWith("Host Coding Loop feedback")) {
      // A feedback envelope and its stable task record can contain the exact same public diagnostics.
      // Both records are pinned; reference only a verbatim duplicate, retaining every unique field.
      const newline = message.content.indexOf("\n");
      const record = JSON.parse(message.content.slice(newline + 1)) as Record<string, unknown>;
      if (typeof record.feedback === "string" && record.feedback.length > 512) {
        const same = stableRecords.find((entry) =>
          entry.content.includes(record.feedback as string),
        );
        if (same)
          return {
            ...message,
            content:
              message.content.slice(0, newline + 1) +
              JSON.stringify({
                ...record,
                feedback:
                  "Verbatim diagnostic feedback is preserved in the pinned stable task record referenced below.",
                feedbackRef: {
                  historyIndex: same.index,
                  recordSha256: digest(same.content),
                  feedbackSha256: digest(record.feedback),
                },
              }),
          };
      }
    }
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
      !message.isError &&
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
