import { DevflowError, type TeamSnapshot } from "@devflow/shared";

/** Operation lifecycle, not inferred transport counts. One model generate may use multiple HTTPs. */
export function teamOperationAudit(state: TeamSnapshot) {
  const models = state.operations.filter((o) => o.kind === "MODEL");
  return {
    version: "team-operation-audit-v1",
    teamRevision: state.revision,
    decisionAttempts: state.agents.reduce((n, a) => n + a.decisionCount, 0),
    preparedOperations: models.length,
    confirmedResponses: models.filter((o) => o.status === "COMPLETED").length,
    knownNotIssued: models.filter((o) => o.status === "NOT_ISSUED").length,
    unresolvedDispatch: models.filter((o) => ["PREPARED", "INFLIGHT", "UNKNOWN"].includes(o.status))
      .length,
    appliedDecisions: models.filter((o) => o.applied).length,
    httpRequests: null,
    httpCountSource: "Provider transport/fee ledger required; never infer from Agent decisions.",
    evidence: {
      hostCurrent: state.evidence.filter(
        (e) => e.valid && e.sourceIdentity === state.sourceIdentity,
      ).length,
      selected: state.selectedEvidenceIds.length,
      visibleInConfirmedResponses: [
        ...new Set(
          models.filter((o) => o.status === "COMPLETED").flatMap((o) => o.visibleEvidenceIds ?? []),
        ),
      ].length,
      missingVisibilityRecords: models.filter(
        (o) => o.status === "COMPLETED" && o.visibleEvidenceIds === undefined,
      ).length,
    },
    successfulMessages: state.messages.length,
    failures: state.operations
      .filter((o) => o.failure)
      .map((o) => ({ operationId: o.id, kind: o.kind, status: o.status, ...o.failure })),
  };
}

export function teamStopError(state: TeamSnapshot) {
  const lastModel = state.operations.findLast((o) => o.kind === "MODEL");
  return new DevflowError({
    code:
      state.stopReason === "STALLED"
        ? "AGENT_STALLED"
        : state.stopReason === "BUDGET_STOP"
          ? "EXECUTION_BUDGET_EXCEEDED"
          : state.stopReason === "MODEL_OUTPUT_INVALID"
            ? "MODEL_OUTPUT_INVALID"
            : "INSUFFICIENT_EVIDENCE",
    message: `Collaboration ended: ${state.stopReason ?? state.status}`,
    details: {
      missing: state.missing,
      stopReason: state.stopReason,
      requestScope: "LAST_MODEL_OPERATION",
      lastModelOperationId: lastModel?.id ?? null,
      ...(lastModel?.status === "COMPLETED"
        ? { requestIssued: true }
        : lastModel?.status === "NOT_ISSUED" || !lastModel
          ? { requestIssued: false }
          : {}),
      ...teamOperationAudit(state),
    },
  });
}
