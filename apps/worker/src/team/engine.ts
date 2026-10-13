import { createHash, randomUUID } from "node:crypto";
import type { TeamStore } from "@devflow/database";
import {
  DevflowError,
  TeamConfigurationSchema,
  TeamDecisionSchema,
  teamCanonicalJson,
  type TeamSnapshot,
  type TeamAgent,
  type TeamAction,
  type TeamDecision,
  type TeamEvidence,
  type TeamLease,
  type TeamOperation,
  type TeamConfiguration,
  type TeamMessageArgumentIssue,
} from "@devflow/shared";

export const teamDigest = (value: unknown) =>
  createHash("sha256").update(teamCanonicalJson(value)).digest("hex");
function fail(message: string): never {
  throw new DevflowError({ code: "CONFLICT", message });
}
export interface TeamDecisionView {
  runId: string;
  sourceIdentity: string;
  agentId: string;
  role: TeamAgent["role"];
  task: { title: string; description: string };
  assignments: TeamSnapshot["tasks"];
  board: {
    id: string;
    agentId: string;
    goal: string;
    status: string;
    sourceIdentity?: string;
    current: boolean;
    result?: unknown;
  }[];
  inbox: TeamSnapshot["messages"];
  counterevidence?: TeamSnapshot["messages"];
  evidence: TeamEvidence[];
  /** Only the recipient's history, never other agents' hidden turns. */
  history: TeamAgent["history"];
  limits: TeamConfiguration;
  feedback?: TeamSnapshot["feedback"];
  /** Host quote after shared downstream reservations; informative, never authorization. */
  resourceAvailability?: Record<string, number>;
  /** Host rejection of a prior SEND; a correction still needs ordinary Run admission. */
  messageValidationFeedback?: TeamAgent["messageRecovery"];
}
export interface TeamEnginePorts {
  store: TeamStore;
  lease: TeamLease;
  signal: AbortSignal;
  decide(view: TeamDecisionView, operation: TeamOperation): Promise<TeamDecision>;
  observe(
    action: Extract<TeamAction, { type: "READ" | "SEARCH" | "RELATIONS" }>,
    operation: TeamOperation,
  ): Promise<TeamEvidence[]>;
  beforeDecision?(view: TeamDecisionView, operation: TeamOperation): Promise<void>;
  /** Host verifies the immutable read-only dispatch group; this is not an Agent option. */
  parallelInvestigators?(group: string, execute: () => Promise<void>): Promise<void>;
  onChange?(snapshot: TeamSnapshot): Promise<void>;
}

/** A single view builder is used by actual dispatch and downstream closing quotes. */
export function teamDecisionView(
  state: TeamSnapshot,
  agentId: string,
  task: TeamDecisionView["task"],
): TeamDecisionView {
  const agent = state.agents.find((a) => a.id === agentId)!;
  const assignments = state.tasks.filter(
    (t) => t.agentId === agentId && ["READY", "RUNNING"].includes(t.status),
  );
  const inbox = state.messages.filter(
    (m) =>
      m.to === agentId &&
      m.sequence > agent.inboxCursor &&
      m.sourceIdentity === state.sourceIdentity,
  );
  const counterevidence = state.messages.filter(
    (m) => m.to === agentId && m.type === "CHALLENGE" && m.sourceIdentity === state.sourceIdentity,
  );
  const allowed = new Set([
    ...agent.observedEvidenceIds,
    ...(agent.acquiredEvidenceIds ?? []),
    ...assignments.flatMap((t) => t.evidenceIds),
    ...inbox.flatMap((m) => m.evidenceIds),
    ...counterevidence.flatMap((m) => m.evidenceIds),
  ]);
  return {
    runId: state.runId,
    sourceIdentity: state.sourceIdentity,
    agentId,
    role: agent.role,
    task,
    assignments,
    board: state.tasks.map((t) => ({
      id: t.id,
      agentId: t.agentId,
      goal: t.goal,
      status: t.status,
      ...(t.sourceIdentity ? { sourceIdentity: t.sourceIdentity } : {}),
      current: t.sourceIdentity === state.sourceIdentity,
      ...(t.result ? { result: t.result } : {}),
    })),
    inbox,
    counterevidence,
    evidence: state.evidence.filter(
      (e) => e.valid && (agent.role !== "INVESTIGATOR" || allowed.has(e.id)),
    ),
    history: agent.history,
    limits: state.config,
    ...(state.feedback ? { feedback: state.feedback } : {}),
    ...(agent.messageRecovery &&
    !agent.messageRecovery.resolved &&
    (!agent.messageRecovery.correctionOperationId ||
      agent.messageRecovery.correctionOperationId ===
        `team:${agentId}:decision:${agent.decisionCount + 1}`)
      ? { messageValidationFeedback: agent.messageRecovery }
      : {}),
  };
}

/** A bounded collaboration service inside the owning Run, not a second workflow engine. */
export class TeamEngine {
  constructor(private readonly ports: TeamEnginePorts) {}

  /** Host-only handoff while the single Coding writer is paused; no quotas/history are reset. */
  async reopen(
    runId: string,
    sourceIdentity: string,
    evidence: TeamEvidence[],
    feedback: NonNullable<TeamSnapshot["feedback"]>,
  ) {
    const prior = await this.load(runId);
    if (prior.feedback?.id === feedback.id) {
      if (prior.sourceIdentity !== sourceIdentity) fail("TEAM_FEEDBACK_SOURCE_CHANGED");
      return;
    }
    if (
      prior.status === "RUNNING" ||
      prior.operations.some(
        (o) =>
          o.status === "INFLIGHT" ||
          o.status === "UNKNOWN" ||
          (o.kind === "MODEL" && o.status === "COMPLETED" && !o.applied),
      )
    )
      fail("TEAM_FEEDBACK_REQUIRES_SETTLED_INVESTIGATION");
    await this.change(runId, (s) => {
      const invalidated = s.evidence.filter((e) => e.valid && e.sourceIdentity !== sourceIdentity);
      for (const e of invalidated) e.valid = false;
      for (const e of evidence) {
        if (
          e.runId !== runId ||
          e.repositoryId !== s.repositoryId ||
          e.sourceIdentity !== sourceIdentity ||
          e.contentSha256 !== teamDigest(e.content)
        )
          fail("TEAM_FEEDBACK_EVIDENCE_INVALID");
        if (!s.evidence.some((row) => row.id === e.id)) s.evidence.push(e);
      }
      (s.viewTransitions ??= []).push({
        from: s.sourceIdentity,
        to: sourceIdentity,
        feedbackId: feedback.id,
        invalidatedEvidenceIds: invalidated.map((e) => e.id),
      });
      s.sourceIdentity = sourceIdentity;
      s.feedback = feedback;
      s.status = "RUNNING";
      s.missing = [];
      s.selectedEvidenceIds = [];
      delete s.stopReason;
      s.agents.find((a) => a.id === s.coordinatorId)!.status = "READY";
    });
  }

  async initialize(input: {
    runId: string;
    repositoryId: string;
    sourceIdentity: string;
    mode: "team" | "single";
    evidence?: TeamEvidence[];
    config?: Partial<TeamConfiguration>;
    modelBindings?: Record<string, unknown>;
  }): Promise<TeamSnapshot> {
    const saved = await this.ports.store.load(input.runId);
    if (saved) {
      if (
        saved.sourceIdentity !== input.sourceIdentity ||
        saved.mode !== input.mode ||
        saved.repositoryId !== input.repositoryId
      )
        fail("TEAM_SOURCE_OR_MODE_MISMATCH");
      if (
        input.modelBindings &&
        teamDigest(input.modelBindings) !== teamDigest(saved.modelBindings)
      )
        fail("TEAM_MODEL_BINDING_CHANGED");
      if (
        input.config &&
        teamDigest(TeamConfigurationSchema.parse(input.config)) !== teamDigest(saved.config)
      )
        fail("TEAM_CONFIGURATION_CHANGED");
      if (saved.operations.some((o) => o.status === "INFLIGHT" || o.status === "UNKNOWN"))
        fail("TEAM_OPERATION_OUTCOME_UNKNOWN");
      return saved;
    }
    const id = randomUUID();
    const next: TeamSnapshot = {
      version: 1,
      ...input,
      revision: 0,
      config: TeamConfigurationSchema.parse(input.config ?? {}),
      status: "RUNNING",
      coordinatorId: id,
      agents: [this.agent(input.runId, id, input.mode === "single" ? "SOLVER" : "COORDINATOR")],
      tasks: [],
      messages: [],
      evidence: input.evidence ?? [],
      operations: [],
      missing: [],
      selectedEvidenceIds: [],
    };
    if (!(await this.ports.store.compareAndSwap(input.runId, null, next, this.ports.lease)))
      return this.initialize(input);
    return next;
  }

  async run(
    runId: string,
    task: TeamDecisionView["task"],
    maxDecisions: number,
  ): Promise<TeamSnapshot> {
    let state = await this.load(runId);
    // A confirmed receipt is local work, not a new model turn or a renewed quota.
    for (const op of state.operations.filter(
      (o) => o.kind === "MODEL" && o.status === "COMPLETED" && !o.applied,
    ))
      await this.applyDecision(runId, op);
    state = await this.load(runId);
    const already = state.agents.reduce((n, a) => n + a.decisionCount, 0);
    let attempts = already;
    while (state.status === "RUNNING" && attempts < maxDecisions) {
      this.ports.signal.throwIfAborted();
      await this.turn(runId, state.coordinatorId, task);
      attempts++;
      state = await this.load(runId);
      if (state.status !== "RUNNING") break;
      const runnable = state.agents.filter(
        (a) =>
          a.role === "INVESTIGATOR" &&
          a.status === "READY" &&
          state.tasks.some(
            (t) =>
              t.agentId === a.id &&
              ["READY", "RUNNING"].includes(t.status) &&
              t.dependsOn.every((id) =>
                state.tasks.some((parent) => parent.id === id && parent.status === "COMPLETED"),
              ),
          ),
      );
      const selected = runnable.slice(
        0,
        Math.min(state.config.concurrency, maxDecisions - attempts),
      );
      const feedbackBefore = coordinatorFeedback(state);
      // Every selected task shares the same immutable view; no Coding writer is running here.
      const dispatch = async () => {
        const outcomes = await Promise.allSettled(
          selected.map(async (a) => {
            while (attempts < maxDecisions) {
              const current = await this.load(runId);
              if (
                current.status !== "RUNNING" ||
                current.agents.find((row) => row.id === a.id)?.status !== "READY" ||
                coordinatorFeedback(current) !== feedbackBefore
              )
                break;
              // Synchronous allocation before await prevents parallel siblings using the same remaining slot.
              if (attempts >= maxDecisions) break;
              attempts++;
              await this.turn(runId, a.id, task);
            }
          }),
        );
        for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
      };
      if (this.ports.parallelInvestigators && selected.length)
        await this.ports.parallelInvestigators(`team:${runId}:wave:${state.revision}`, dispatch);
      else await dispatch();
      await this.change(runId, (s) => {
        for (const t of s.tasks)
          if (
            ["READY", "RUNNING", "WAITING"].includes(t.status) &&
            t.dependsOn.some((id) =>
              s.tasks.some((p) => p.id === id && ["BLOCKED", "CANCELLED"].includes(p.status)),
            )
          ) {
            t.status = "BLOCKED";
            t.reason = "DEPENDENCY_UNAVAILABLE";
          }
      });
      state = await this.load(runId);
    }
    if (state.status === "RUNNING")
      await this.stop(runId, "BUDGET_STOP", [
        "Remaining Run decisions cannot fund another collaboration turn.",
      ]);
    return this.load(runId);
  }

  private async turn(runId: string, agentId: string, task: TeamDecisionView["task"]) {
    this.ports.signal.throwIfAborted();
    const state = await this.load(runId);
    const agent = state.agents.find((a) => a.id === agentId)!;
    if (["CANCELLED", "BLOCKED"].includes(agent.status)) return;
    const view = teamDecisionView(state, agentId, task);
    const assignments = view.assignments;
    const id = `team:${agentId}:decision:${agent.decisionCount + 1}`;
    const operation: TeamOperation = {
      id,
      agentId,
      ...(assignments[0] ? { taskId: assignments[0].id } : {}),
      kind: "MODEL",
      status: "PREPARED",
      input: view,
      observedBefore: [...agent.observedEvidenceIds],
      acquiredBefore: [...(agent.acquiredEvidenceIds ?? [])],
    };
    await this.change(runId, (s) => {
      if (!s.operations.some((o) => o.id === id)) s.operations.push(operation);
      const recovery = s.agents.find((a) => a.id === agentId)!.messageRecovery;
      if (recovery && !recovery.resolved && !recovery.correctionOperationId)
        recovery.correctionOperationId = id;
    });
    // A rejected quote has a durable known-not-issued result; no phantom inflight request.
    try {
      await this.ports.beforeDecision?.(view, operation);
    } catch (error) {
      const investigationDenied =
        agent.role === "INVESTIGATOR" &&
        error instanceof DevflowError &&
        error.code === "EXECUTION_BUDGET_EXCEEDED" &&
        (error.details as { requestIssued?: boolean } | undefined)?.requestIssued === false;
      await this.change(runId, (s) => {
        const op = s.operations.find((o) => o.id === id)!;
        op.status = "NOT_ISSUED";
        op.error = error instanceof Error ? error.message : String(error);
        op.failure =
          error instanceof DevflowError
            ? {
                code: error.code,
                message: error.message,
                ...(error.details ? { details: error.details } : {}),
              }
            : { code: "HOST_ERROR", message: op.error };
        if (investigationDenied) {
          s.agents.find((a) => a.id === agentId)!.status = "BLOCKED";
          for (const t of s.tasks.filter(
            (t) => t.agentId === agentId && ["READY", "RUNNING"].includes(t.status),
          )) {
            t.status = "BLOCKED";
            t.reason = `BUDGET_STOP: ${op.error}`;
          }
        }
      });
      // A known non-dispatch closes this assignment; the shared closing reservation
      // lets Coordinator decide whether the already collected evidence is sufficient.
      if (investigationDenied) return;
      await this.stop(runId, "BUDGET_STOP", [
        error instanceof Error ? error.message : String(error),
      ]);
      return;
    }
    await this.change(runId, (s) => {
      const current = s.agents.find((a) => a.id === agentId)!;
      if (current.decisionCount !== agent.decisionCount || current.status === "CANCELLED")
        fail("TEAM_STALE_DECISION");
      current.decisionCount++;
      current.status = "RUNNING";
      s.operations.find((o) => o.id === id)!.status = "INFLIGHT";
    });
    let response: unknown;
    try {
      response = await this.ports.decide(view, operation);
    } catch (error) {
      if ((await this.load(runId)).operations.find((o) => o.id === id)?.status === "COMPLETED")
        throw error;
      const notIssued =
        error instanceof DevflowError &&
        (error.details as { requestIssued?: boolean } | undefined)?.requestIssued === false;
      const investigationDenied =
        agent.role === "INVESTIGATOR" &&
        notIssued &&
        error instanceof DevflowError &&
        error.code === "EXECUTION_BUDGET_EXCEEDED";
      await this.change(runId, (s) => {
        const op = s.operations.find((o) => o.id === id)!;
        op.status = notIssued ? "NOT_ISSUED" : "UNKNOWN";
        op.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
        op.failure = {
          code: error instanceof DevflowError ? error.code : "HOST_ERROR",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof DevflowError && error.details ? { details: error.details } : {}),
        };
        if (investigationDenied) {
          s.agents.find((a) => a.id === agentId)!.status = "BLOCKED";
          for (const t of s.tasks.filter(
            (t) => t.agentId === agentId && ["READY", "RUNNING"].includes(t.status),
          )) {
            t.status = "BLOCKED";
            t.reason = `BUDGET_STOP: ${op.failure.message}`;
          }
        }
      });
      // A sibling can reserve between quote and actual admission. Preserve the
      // failed decision attempt, but never turn a known non-dispatch into unknown work.
      if (investigationDenied) return;
      throw error;
    }
    await this.change(runId, (s) => {
      const op = s.operations.find((o) => o.id === id)!;
      op.status = "COMPLETED";
      op.output = response;
    });
    await this.applyDecision(
      runId,
      (await this.load(runId)).operations.find((o) => o.id === id)!,
    );
  }

  private async applyDecision(runId: string, operation: TeamOperation) {
    if (operation.applied) return;
    const parsed = TeamDecisionSchema.safeParse(operation.output);
    if (!parsed.success) {
      await this.change(runId, (s) => {
        const op = s.operations.find((o) => o.id === operation.id)!;
        op.applied = true;
        op.error = `TEAM_OUTPUT_INVALID: ${parsed.error.message}`;
        s.status = "STOPPED";
        s.stopReason = "MODEL_OUTPUT_INVALID";
        s.missing = [op.error];
      });
      return;
    }
    const decision = parsed.data;
    const view = operation.input as TeamDecisionView;
    const agentId = operation.agentId;
    const id = operation.id;
    const inbox = view.inbox;
    const originalEvidence = new Set(operation.observedBefore ?? []);
    const originalAcquired = new Set([...(operation.acquiredBefore ?? []), ...originalEvidence]);
    let state = await this.load(runId);
    let duplicateOnly = true;
    let rejectedMessage = false;
    let correctedMessage = false;
    for (let index = 0; index < decision.actions.length; index++) {
      state = await this.load(runId);
      if (state.status !== "RUNNING") break;
      const action = decision.actions[index]!;
      const actionId = `${id}:action:${index}`;
      const actionKey = teamDigest({ action, source: state.sourceIdentity });
      const receipt = state.operations.find((o) => o.id === actionId);
      if (receipt?.status === "COMPLETED") {
        duplicateOnly = false;
        if (action.type === "SEND") correctedMessage = true;
        continue;
      }
      if (receipt?.status === "NOT_ISSUED" && receipt.failure?.code === "VALIDATION_ERROR") {
        rejectedMessage = true;
        break;
      }
      if (state.agents.find((a) => a.id === agentId)!.seenActions.includes(actionKey)) continue;
      duplicateOnly = false;
      try {
        await this.apply(runId, agentId, action, actionId, decision.summary);
      } catch (error) {
        if (
          !(error instanceof DevflowError) ||
          error.code !== "VALIDATION_ERROR" ||
          error.message !== "TEAM_REPLY_ID_INVALID"
        )
          throw error;
        const issue = error.details as TeamMessageArgumentIssue;
        await this.change(runId, (s) => {
          if (s.operations.some((o) => o.id === actionId)) return;
          const current = s.agents.find((a) => a.id === agentId)!;
          const recoveryGranted = !current.messageRecovery;
          if (recoveryGranted)
            current.messageRecovery = {
              originOperationId: actionId,
              sourceIdentity: s.sourceIdentity,
              issue,
            };
          s.operations.push({
            id: actionId,
            agentId,
            kind: "CONTROL",
            status: "NOT_ISSUED",
            input: action,
            failure: {
              code: error.code,
              message: error.message,
              details: { ...issue, recoveryGranted },
            },
          });
          if (!recoveryGranted) {
            current.status = "BLOCKED";
            for (const t of s.tasks.filter(
              (t) => t.agentId === agentId && ["READY", "RUNNING"].includes(t.status),
            )) {
              t.status = "BLOCKED";
              t.reason = "MESSAGE_CORRECTION_EXHAUSTED";
            }
            if (agentId === s.coordinatorId) {
              s.status = "STOPPED";
              s.stopReason = "MESSAGE_CORRECTION_EXHAUSTED";
              s.missing.push(
                `${error.message}: ${issue.field} must reference a current inbox message, or be omitted for a new message.`,
              );
            }
          }
        });
        rejectedMessage = true;
        break; // Do not let later actions hide the rejected SEND.
      }
      if (action.type === "SEND") correctedMessage = true;
      await this.change(runId, (s) => {
        s.agents.find((a) => a.id === agentId)!.seenActions.push(actionKey);
      });
    }
    await this.change(runId, (s) => {
      const op = s.operations.find((o) => o.id === id)!;
      if (op.applied) return;
      op.applied = true;
      const current = s.agents.find((a) => a.id === agentId)!;
      const observed = [
        ...new Set([
          ...current.observedEvidenceIds,
          ...(op.visibleEvidenceIds ?? view.evidence.map((e) => e.id)),
        ]),
      ];
      const gained = [...observed, ...(current.acquiredEvidenceIds ?? [])];
      const progress = observed.some(
        (id) =>
          !originalEvidence.has(id) &&
          s.evidence.some(
            (e) =>
              e.id === id &&
              ["SOURCE_OBSERVATION", "VALIDATION_OBSERVATION", "RELATION_OBSERVATION"].includes(
                e.kind,
              ),
          ),
      );
      // Host acquisition and model visibility are distinct audit records.
      const acquisitionProgress = gained.some(
        (id) =>
          !originalAcquired.has(id) &&
          s.evidence.some(
            (e) =>
              e.id === id &&
              e.valid &&
              ["SOURCE_OBSERVATION", "VALIDATION_OBSERVATION", "RELATION_OBSERVATION"].includes(
                e.kind,
              ),
          ),
      );
      current.observedEvidenceIds = observed;
      current.noProgress = progress || acquisitionProgress ? 0 : current.noProgress + 1;
      const correcting = current.messageRecovery?.correctionOperationId === id;
      const corrected = correcting && correctedMessage && !rejectedMessage;
      if (correcting) current.messageRecovery!.resolved = corrected;
      const correctionPending =
        current.messageRecovery && !current.messageRecovery.correctionOperationId;
      current.inboxCursor = Math.max(current.inboxCursor, ...inbox.map((m) => m.sequence));
      // History records preserve a bounded view without recursively embedding its own history.
      current.history.push({ input: { ...view, history: undefined }, output: decision });
      if (current.status === "RUNNING") current.status = "READY";
      if (
        (duplicateOnly || current.noProgress >= 2) &&
        !correctionPending &&
        !corrected &&
        !["COMPLETED", "CANCELLED"].includes(current.status) &&
        s.status === "RUNNING"
      ) {
        current.status = "BLOCKED";
        for (const t of s.tasks.filter(
          (t) => t.agentId === agentId && ["READY", "RUNNING"].includes(t.status),
        )) {
          t.status = "BLOCKED";
          t.reason = "STALLED";
        }
        if (agentId === s.coordinatorId && s.status === "RUNNING") {
          s.status = "STOPPED";
          s.stopReason = "STALLED";
          s.missing.push("Repeated actions or two turns without new observed evidence.");
        }
      }
    });
  }

  private async apply(
    runId: string,
    agentId: string,
    action: TeamAction,
    operationId: string,
    summary: string,
  ) {
    const state = await this.load(runId),
      agent = state.agents.find((a) => a.id === agentId)!;
    const previous = state.operations.find((o) => o.id === operationId);
    if (previous?.status === "COMPLETED") return;
    if (previous) fail("TEAM_OPERATION_OUTCOME_UNKNOWN");
    const manager = agent.role !== "INVESTIGATOR";
    if (["DELEGATE", "CANCEL", "PROPOSE_PLAN", "STOP"].includes(action.type) && !manager)
      fail("TEAM_ROLE_DENIED");
    if (action.type === "DELEGATE" && state.mode === "single") fail("SINGLE_CANNOT_DELEGATE");
    if (action.type === "READ" || action.type === "SEARCH" || action.type === "RELATIONS") {
      if (agent.role === "COORDINATOR") fail("COORDINATOR_MUST_DELEGATE_SOURCE_IO");
      const operation: TeamOperation = {
        id: operationId,
        agentId,
        kind: "TOOL",
        status: "INFLIGHT",
        input: action,
      };
      await this.change(runId, (s) => s.operations.push(operation));
      try {
        const evidence = await this.ports.observe(action, operation);
        await this.change(runId, (s) => {
          for (const e of evidence) {
            if (
              e.runId !== runId ||
              e.repositoryId !== s.repositoryId ||
              e.sourceIdentity !== s.sourceIdentity ||
              e.contentSha256 !== teamDigest(e.content)
            )
              fail("TEAM_EVIDENCE_IDENTITY_INVALID");
            if (!s.evidence.some((row) => row.id === e.id)) s.evidence.push(e);
            const a = s.agents.find((a) => a.id === agentId)!;
            a.acquiredEvidenceIds ??= [];
            if (!a.acquiredEvidenceIds.includes(e.id)) a.acquiredEvidenceIds.push(e.id);
          }
          const op = s.operations.find((o) => o.id === operationId)!;
          op.status = "COMPLETED";
          op.output = evidence.map((e) => e.id);
        });
      } catch (error) {
        // A receipt may already have committed before an audit sink/process failed.
        // Never turn a confirmed completed operation into unknown consumption.
        if (
          (await this.load(runId)).operations.find((o) => o.id === operationId)?.status ===
          "COMPLETED"
        )
          throw error;
        await this.change(runId, (s) => {
          const op = s.operations.find((o) => o.id === operationId)!;
          const notIssued =
            error instanceof DevflowError &&
            (error.details as { requestIssued?: boolean } | undefined)?.requestIssued === false;
          op.status = notIssued ? "NOT_ISSUED" : "UNKNOWN";
          op.error = String(error);
          op.failure = {
            code: error instanceof DevflowError ? error.code : "HOST_ERROR",
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof DevflowError && error.details ? { details: error.details } : {}),
          };
          if (notIssued) {
            s.status = "STOPPED";
            s.stopReason = "BUDGET_STOP";
            s.missing = [op.error];
          }
        });
        throw error;
      }
      return;
    }
    await this.change(runId, (s) => {
      if (s.operations.some((o) => o.id === operationId)) return;
      if ("evidenceIds" in action) this.refs(s, action.evidenceIds);
      switch (action.type) {
        case "DELEGATE": {
          if (s.tasks.some((t) => t.key === action.key)) fail("TEAM_DUPLICATE_TASK");
          if (s.tasks.length >= s.config.maxTasks) fail("TEAM_TASK_LIMIT");
          if (action.dependsOn.some((id) => !s.tasks.some((t) => t.id === id)))
            fail("TEAM_DEPENDENCY_UNKNOWN");
          let child = s.agents.find((a) => a.role === "INVESTIGATOR" && a.status === "COMPLETED");
          if (!child) {
            if (
              s.agents.filter((a) => a.role === "INVESTIGATOR").length >= s.config.maxInvestigators
            )
              fail("TEAM_AGENT_LIMIT");
            child = this.agent(runId, randomUUID(), "INVESTIGATOR");
            s.agents.push(child);
          }
          const taskId = randomUUID();
          child.status = "READY";
          child.taskIds.push(taskId);
          s.tasks.push({
            id: taskId,
            key: action.key,
            agentId: child.id,
            goal: action.goal,
            sourceIdentity: s.sourceIdentity,
            dependsOn: action.dependsOn,
            evidenceIds: action.evidenceIds,
            status: "READY",
          });
          break;
        }
        case "SEND": {
          if (s.messages.some((m) => m.idempotencyKey === operationId)) break;
          if (s.messages.length >= s.config.maxMessages) fail("TEAM_MESSAGE_LIMIT");
          const target = s.agents.find((a) => a.id === action.toAgentId);
          const relatedTask = s.tasks.find((t) => t.id === action.taskId);
          if (
            !target ||
            !relatedTask ||
            (!manager && relatedTask.agentId !== agentId && relatedTask.agentId !== target.id)
          )
            fail("TEAM_MESSAGE_TARGET_INVALID");
          if (!manager) {
            const visible = new Set([
              ...agent.observedEvidenceIds,
              ...(agent.acquiredEvidenceIds ?? []),
              ...s.tasks
                .filter((t) => t.agentId === agentId && t.sourceIdentity === s.sourceIdentity)
                .flatMap((t) => t.evidenceIds),
              ...s.messages
                .filter((m) => m.to === agentId && m.sourceIdentity === s.sourceIdentity)
                .flatMap((m) => m.evidenceIds),
            ]);
            if (action.evidenceIds.some((id) => !visible.has(id)))
              fail("TEAM_MESSAGE_EVIDENCE_NOT_VISIBLE");
          }
          if (
            target.status === "CANCELLED" ||
            target.status === "BLOCKED" ||
            relatedTask.sourceIdentity !== s.sourceIdentity ||
            ["CANCELLED", "BLOCKED"].includes(relatedTask.status)
          )
            fail("TEAM_MESSAGE_TARGET_UNAVAILABLE");
          if (action.replyTo !== undefined) {
            const reply = s.messages.find((m) => m.id === action.replyTo);
            if (!reply) {
              const issue: TeamMessageArgumentIssue = {
                field: "replyTo",
                expected: "messageId",
                actual: action.replyTo,
                reason: s.tasks.some((t) => t.id === action.replyTo)
                  ? "TASK_ID_IN_MESSAGE_FIELD"
                  : "MESSAGE_ID_NOT_FOUND",
                availableReplies: s.messages
                  .filter(
                    (m) =>
                      m.to === agentId &&
                      m.from === target.id &&
                      m.taskId === action.taskId &&
                      m.sourceIdentity === s.sourceIdentity,
                  )
                  .map((m) => ({ messageId: m.id, fromAgentId: m.from, taskId: m.taskId })),
                guidance:
                  "For a new SEND omit replyTo. To reply, explicitly use an available messageId, its sender as toAgentId and its taskId. The host does not rewrite your parameters.",
              };
              throw new DevflowError({
                code: "VALIDATION_ERROR",
                message: "TEAM_REPLY_ID_INVALID",
                details: issue,
              });
            }
            if (reply.to !== agentId || reply.from !== target.id || reply.taskId !== action.taskId)
              fail("TEAM_REPLY_AUTHORIZATION_DENIED");
            if (reply.sourceIdentity !== s.sourceIdentity) fail("TEAM_REPLY_SOURCE_STALE");
          }
          s.messages.push({
            id: randomUUID(),
            sequence: s.messages.length + 1,
            from: agentId,
            to: target.id,
            taskId: action.taskId,
            type: action.messageType,
            body: action.body,
            evidenceIds: action.evidenceIds,
            ...(action.replyTo ? { replyTo: action.replyTo } : {}),
            idempotencyKey: operationId,
            sourceIdentity: s.sourceIdentity,
          });
          if (target.status === "COMPLETED") {
            target.status = "READY";
            if (relatedTask.agentId === target.id) relatedTask.status = "READY";
          }
          break;
        }
        case "CANCEL": {
          const t = s.tasks.find((t) => t.id === action.taskId);
          if (!t) fail("TEAM_TASK_UNKNOWN");
          t!.status = "CANCELLED";
          t!.reason = action.reason;
          s.agents.find((a) => a.id === t!.agentId)!.status = "CANCELLED";
          break;
        }
        case "RESULT": {
          if (manager) fail("TEAM_RESULT_REQUIRES_ASSIGNMENT");
          for (const t of s.tasks.filter(
            (t) => t.agentId === agentId && ["READY", "RUNNING"].includes(t.status),
          )) {
            t.status = "COMPLETED";
            t.result = {
              summary,
              evidenceIds: action.evidenceIds,
              hypotheses: action.hypotheses,
              missing: action.missing,
            };
          }
          s.agents.find((a) => a.id === agentId)!.status = "COMPLETED";
          break;
        }
        case "PROPOSE_PLAN":
          s.status = "READY_FOR_PLAN";
          s.selectedEvidenceIds = action.evidenceIds;
          s.missing = action.missing;
          // Handoff ends this investigation wave. Keep uncompleted goals visible,
          // but never resurrect their old assignments after Coding changes the view.
          for (const t of s.tasks.filter((t) =>
            ["READY", "RUNNING", "WAITING"].includes(t.status),
          )) {
            t.status = "CANCELLED";
            t.reason = "PLANNING_HANDOFF";
            s.agents.find((a) => a.id === t.agentId)!.status = "CANCELLED";
            s.missing.push(`Investigation not completed before planning handoff: ${t.goal}`);
          }
          break;
        case "STOP":
          s.status = "STOPPED";
          s.stopReason = action.reason;
          s.missing = action.missing;
          break;
      }
      s.operations.push({
        id: operationId,
        agentId,
        kind: "CONTROL",
        status: "COMPLETED",
        input: action,
      });
    });
  }

  private refs(s: TeamSnapshot, ids: string[]) {
    if (ids.some((id) => !s.evidence.some((e) => e.id === id && e.valid)))
      fail("TEAM_EVIDENCE_REFERENCE_INVALID");
  }
  private agent(runId: string, id: string, role: TeamAgent["role"]): TeamAgent {
    return {
      id,
      runId,
      role,
      sessionId: randomUUID(),
      status: "READY",
      taskIds: [],
      decisionCount: 0,
      inboxCursor: 0,
      history: [],
      noProgress: 0,
      seenActions: [],
      observedEvidenceIds: [],
    };
  }
  private async stop(runId: string, reason: string, missing: string[]) {
    await this.change(runId, (s) => {
      s.status = "STOPPED";
      s.stopReason = reason;
      s.missing = missing;
    });
  }
  private async load(runId: string) {
    const s = await this.ports.store.load(runId);
    return s ?? fail("TEAM_NOT_INITIALIZED");
  }
  private async change(runId: string, mutate: (state: TeamSnapshot) => unknown) {
    for (let i = 0; i < 16; i++) {
      this.ports.signal.throwIfAborted();
      const state = await this.load(runId),
        revision = state.revision;
      mutate(state);
      state.revision++;
      if (await this.ports.store.compareAndSwap(runId, revision, state, this.ports.lease)) {
        await this.ports.onChange?.(state);
        return;
      }
    }
    fail("TEAM_CONCURRENT_UPDATE_CONFLICT");
  }
}

/** Yield only on new results/blockers or addressed messages, not query wording or cache churn. */
function coordinatorFeedback(state: TeamSnapshot): string {
  return teamDigest({
    tasks: state.tasks
      .filter((t) => ["COMPLETED", "BLOCKED", "CANCELLED"].includes(t.status))
      .map((t) => ({ id: t.id, status: t.status, result: t.result, reason: t.reason })),
    messages: state.messages.filter((m) => m.to === state.coordinatorId).map((m) => m.id),
  });
}
