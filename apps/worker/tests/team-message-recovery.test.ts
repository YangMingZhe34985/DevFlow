import { describe, expect, it } from "vitest";
import { InMemoryTeamStore } from "@devflow/database";
import {
  DevflowError,
  type TeamAction,
  type TeamDecision,
  type TeamEvidence,
} from "@devflow/shared";
import { TeamEngine, teamDigest, type TeamEnginePorts } from "../src/team/engine.js";

const lease = { owner: "worker", dispatchRevision: 0 };
const task = { title: "Reload remains stale", description: "Reload must expose the new value." };
const decision = (...actions: TeamAction[]): TeamDecision => ({
  summary: "Follow current evidence",
  actions,
});
const evidence = (path: string): TeamEvidence => ({
  id: path,
  runId: "run",
  repositoryId: "repo",
  sourceIdentity: "base",
  kind: "SOURCE_OBSERVATION",
  path,
  fileSha256: "a".repeat(64),
  startLine: 1,
  endLine: 1,
  content: path,
  contentSha256: teamDigest(path),
  sourceOperationId: "read",
  supports: [],
  valid: true,
});
const send = (replyTo?: string): TeamAction => ({
  type: "SEND",
  toAgentId: "investigator",
  taskId: "task",
  messageType: "REQUEST_EVIDENCE",
  body: "Check the consumer after the cache counterexample.",
  evidenceIds: [],
  ...(replyTo === undefined ? {} : { replyTo }),
});
async function setup(ports: Omit<TeamEnginePorts, "store" | "lease" | "signal">) {
  const store = new InMemoryTeamStore();
  const config = { ...ports, store, lease, signal: AbortSignal.timeout(5000) };
  const engine = new TeamEngine(config);
  const state = await engine.initialize({
    runId: "run",
    repositoryId: "repo",
    sourceIdentity: "base",
    mode: "team",
  });
  const next = structuredClone(state);
  next.revision++;
  next.agents[0]!.noProgress = 1; // A bad argument must not turn one idle round into fatal stall.
  next.agents.push({
    id: "investigator",
    runId: "run",
    sessionId: "private",
    role: "INVESTIGATOR",
    status: "COMPLETED",
    taskIds: ["task"],
    decisionCount: 0,
    inboxCursor: 0,
    history: [],
    noProgress: 0,
    seenActions: [],
    observedEvidenceIds: [],
  });
  next.tasks.push({
    id: "task",
    key: "consumer",
    agentId: "investigator",
    goal: "consumer",
    sourceIdentity: "base",
    dependsOn: [],
    evidenceIds: [],
    status: "COMPLETED",
  });
  await store.compareAndSwap("run", state.revision, next);
  return { store, engine, config };
}

describe("bounded team message argument recovery", () => {
  it("delivers A's challenge, changes B's actual read, then changes Coordinator's next delegation", async () => {
    const store = new InMemoryTeamStore(),
      reads: string[] = [],
      route: string[] = [];
    let delivered!: () => void;
    const challengeDelivered = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const engine = new TeamEngine({
      store,
      lease,
      signal: AbortSignal.timeout(5000),
      onChange: async (s) => {
        if (s.messages.some((m) => m.type === "CHALLENGE")) delivered();
      },
      decide: async (view) => {
        if (view.role === "COORDINATOR") {
          if (!view.board.length)
            return decision(
              ...["A", "B"].map((key) => ({
                type: "DELEGATE" as const,
                key,
                goal: key,
                evidenceIds: [],
                dependsOn: [],
              })),
            );
          const b = view.board.find((t) => t.goal === "B")!;
          if (b.status !== "COMPLETED")
            return decision({
              type: "SEND",
              toAgentId: b.agentId,
              taskId: b.id,
              messageType: "REQUEST_EVIDENCE",
              body: "Resolve the source-backed challenge",
              evidenceIds: ["counterexample.ts"],
            });
          if (!view.board.some((t) => t.goal === "persistence")) {
            expect(view.inbox.some((m) => m.type === "EVIDENCE_RESULT" && m.replyTo)).toBe(true);
            expect(view.evidence.some((e) => e.path === "consumer.ts")).toBe(true);
            route.push("consumer evidence -> delegate persistence");
            return decision({
              type: "DELEGATE",
              key: "persistence",
              goal: "persistence",
              evidenceIds: ["consumer.ts"],
              dependsOn: [],
            });
          }
          return decision({
            type: "PROPOSE_PLAN",
            evidenceIds: view.evidence.map((e) => e.id),
            missing: [],
          });
        }
        const goal = view.assignments[0]!.goal;
        if (goal === "A") {
          if (!view.history.length)
            return decision({ type: "READ", path: "counterexample.ts", startLine: 1, endLine: 1 });
          const b = view.board.find((t) => t.goal === "B")!;
          return decision(
            {
              type: "SEND",
              toAgentId: b.agentId,
              taskId: b.id,
              messageType: "CHALLENGE",
              body: "Cache is current; inspect the consumer",
              evidenceIds: ["counterexample.ts"],
            },
            { type: "RESULT", evidenceIds: ["counterexample.ts"], hypotheses: [], missing: [] },
          );
        }
        if (goal === "B") {
          if (!view.history.length)
            return decision({ type: "READ", path: "cache.ts", startLine: 1, endLine: 1 });
          if (!view.evidence.some((e) => e.path === "consumer.ts")) {
            expect(view.inbox.some((m) => m.type === "CHALLENGE")).toBe(true);
            route.push("A challenge -> B consumer read");
            return decision({ type: "READ", path: "consumer.ts", startLine: 1, endLine: 1 });
          }
          const incoming = view.history
            .flatMap(
              (h) =>
                (h.input as { inbox: { id: string; from: string; taskId: string; type: string }[] })
                  .inbox,
            )
            .find((m) => m.type === "REQUEST_EVIDENCE")!;
          return decision(
            {
              type: "SEND",
              toAgentId: incoming.from,
              taskId: incoming.taskId,
              replyTo: incoming.id,
              messageType: "EVIDENCE_RESULT",
              body: "Consumer exposes persistence inconsistency",
              evidenceIds: ["consumer.ts"],
            },
            {
              type: "RESULT",
              evidenceIds: ["consumer.ts"],
              hypotheses: ["Investigate persisted state"],
              missing: [],
            },
          );
        }
        if (!view.evidence.some((e) => e.path === "persistence.ts"))
          return decision({ type: "READ", path: "persistence.ts", startLine: 1, endLine: 1 });
        return decision({
          type: "RESULT",
          evidenceIds: ["persistence.ts"],
          hypotheses: [],
          missing: [],
        });
      },
      observe: async (action) => {
        if (action.type !== "READ") throw new Error("unexpected action");
        reads.push(action.path);
        if (action.path === "cache.ts") await challengeDelivered;
        return [evidence(action.path)];
      },
    });
    await engine.initialize({
      runId: "run",
      repositoryId: "repo",
      sourceIdentity: "base",
      mode: "team",
    });
    const state = await engine.run("run", task, 20);
    expect(state.status).toBe("READY_FOR_PLAN");
    expect(reads).toEqual(
      expect.arrayContaining(["cache.ts", "counterexample.ts", "consumer.ts", "persistence.ts"]),
    );
    expect(route).toEqual([
      "A challenge -> B consumer read",
      "consumer evidence -> delegate persistence",
    ]);
    expect(state.messages).toHaveLength(3);
    expect(state.messages[2]!.replyTo).toBe(state.messages[1]!.id);
  });

  it("returns a known unaffordable investigation to Coordinator with existing evidence instead of terminating the team", async () => {
    const store = new InMemoryTeamStore();
    let investigatorCalls = 0;
    const engine = new TeamEngine({
      store,
      lease,
      signal: AbortSignal.timeout(5000),
      beforeDecision: async (view) => {
        if (view.role === "INVESTIGATOR" && view.history.length)
          throw new DevflowError({
            code: "EXECUTION_BUDGET_EXCEEDED",
            message: "optional followup cannot fit",
            details: { requestIssued: false },
          });
      },
      decide: async (view) => {
        if (view.role === "INVESTIGATOR") {
          investigatorCalls++;
          return decision({ type: "READ", path: "source.ts", startLine: 1, endLine: 1 });
        }
        if (!view.board.length)
          return decision({
            type: "DELEGATE",
            key: "source",
            goal: "source",
            evidenceIds: [],
            dependsOn: [],
          });
        expect(view.board[0]!.status).toBe("BLOCKED");
        expect(view.evidence.map((e) => e.id)).toContain("source.ts");
        return decision({
          type: "PROPOSE_PLAN",
          evidenceIds: ["source.ts"],
          missing: ["Further investigation unaffordable"],
        });
      },
      observe: async () => [evidence("source.ts")],
    });
    await engine.initialize({
      runId: "run",
      repositoryId: "repo",
      sourceIdentity: "base",
      mode: "team",
    });
    const state = await engine.run("run", task, 10);
    expect(state.status).toBe("READY_FOR_PLAN");
    expect(investigatorCalls).toBe(1);
    expect(state.operations.filter((o) => o.status === "NOT_ISSUED")).toHaveLength(1);
  });

  it("handles an investigator admission race after both preflights without replaying the denied request", async () => {
    const store = new InMemoryTeamStore();
    let ready = 0,
      dispatched = 0,
      release!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = new TeamEngine({
      store,
      lease,
      signal: AbortSignal.timeout(5000),
      beforeDecision: async (view) => {
        if (view.role !== "INVESTIGATOR") return;
        if (++ready === 2) release();
        await bothReady;
      },
      decide: async (view) => {
        if (view.role === "COORDINATOR") {
          if (!view.board.length)
            return decision(
              ...["winner", "loser"].map((key) => ({
                type: "DELEGATE" as const,
                key,
                goal: key,
                evidenceIds: [],
                dependsOn: [],
              })),
            );
          expect(view.board.find((t) => t.goal === "loser")!.status).toBe("BLOCKED");
          return decision({
            type: "PROPOSE_PLAN",
            evidenceIds: ["source.ts"],
            missing: ["Sibling continuation was unaffordable"],
          });
        }
        if (view.assignments[0]!.goal === "loser")
          throw new DevflowError({
            code: "EXECUTION_BUDGET_EXCEEDED",
            message: "concurrent reservation used available capacity",
            details: { requestIssued: false },
          });
        dispatched++;
        return decision({ type: "READ", path: "source.ts", startLine: 1, endLine: 1 });
      },
      observe: async () => [evidence("source.ts")],
    });
    await engine.initialize({
      runId: "run",
      repositoryId: "repo",
      sourceIdentity: "base",
      mode: "team",
    });
    const state = await engine.run("run", task, 10);
    expect(state.status).toBe("READY_FOR_PLAN");
    expect(ready).toBe(2);
    expect(dispatched).toBe(1);
    expect(state.operations.some((o) => o.status === "UNKNOWN")).toBe(false);
    expect(
      state.operations.filter((o) => o.kind === "MODEL" && o.status === "NOT_ISSUED"),
    ).toHaveLength(1);
    await engine.run("run", task, 10);
    expect(dispatched).toBe(1);
  });
  it("diagnoses taskId in replyTo, explicitly corrects, then delivers new evidence without resetting progress", async () => {
    let coordinator = 0;
    const seenProgress: number[] = [];
    const { engine, store } = await setup({
      decide: async (view) => {
        if (view.role === "COORDINATOR") {
          coordinator++;
          if (coordinator === 1) return decision(send("task"));
          if (coordinator === 2) {
            expect(view.messageValidationFeedback).toMatchObject({
              issue: {
                field: "replyTo",
                expected: "messageId",
                actual: "task",
                reason: "TASK_ID_IN_MESSAGE_FIELD",
                availableReplies: [],
              },
            });
            expect(view.history[0]!.output.actions[0]).toHaveProperty("replyTo", "task");
            expect(view.inbox).toHaveLength(0);
            return decision(send()); // This is the model's explicit choice, not host rewriting.
          }
          expect(view.evidence.map((e) => e.path)).toContain("consumer.ts");
          return decision({ type: "PROPOSE_PLAN", evidenceIds: ["consumer.ts"], missing: [] });
        }
        if (!view.history.length) {
          expect(view.inbox).toHaveLength(1);
          return decision({ type: "READ", path: "consumer.ts", startLine: 1, endLine: 1 });
        }
        return decision({
          type: "RESULT",
          evidenceIds: ["consumer.ts"],
          hypotheses: ["Consumer violates reload"],
          missing: [],
        });
      },
      observe: async () => [evidence("consumer.ts")],
      onChange: async (s) => {
        if (s.agents[0]!.history.length <= 2) seenProgress.push(s.agents[0]!.noProgress);
      },
    });
    const state = await engine.run("run", task, 12);
    expect(state.status).toBe("READY_FOR_PLAN");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).not.toHaveProperty("replyTo");
    expect(state.agents[0]!.messageRecovery).toMatchObject({ resolved: true });
    expect(seenProgress).toContain(3); // Successful delivery is not source progress.
    expect(state.operations.filter((o) => o.kind === "MODEL")).toHaveLength(5);
    expect(
      state.operations.find((o) => o.failure?.message === "TEAM_REPLY_ID_INVALID"),
    ).toMatchObject({ status: "NOT_ISSUED", failure: { details: { recoveryGranted: true } } });
    await engine.run("run", task, 12);
    expect((await store.load("run"))!.messages).toHaveLength(1);
    expect(coordinator).toBe(3);
  });

  it("stops the second invalid SEND, preserves both receipts and never silently changes IDs", async () => {
    let calls = 0;
    const { engine } = await setup({
      decide: async (view) => {
        if (view.role === "INVESTIGATOR")
          return decision({ type: "RESULT", evidenceIds: [], hypotheses: [], missing: [] });
        calls++;
        return decision(send("task"));
      },
      observe: async () => [],
    });
    const state = await engine.run("run", task, 20);
    expect(calls).toBe(2);
    expect(state.stopReason).toBe("MESSAGE_CORRECTION_EXHAUSTED");
    expect(state.messages).toHaveLength(0);
    expect(state.operations.filter((o) => o.kind === "CONTROL")).toHaveLength(2);
    expect(state.agents[0]!.messageRecovery?.resolved).toBe(false);
    await engine.run("run", task, 20);
    expect(calls).toBe(2);
  });

  it("reserves the one correction before admission and does not dispatch it when budget is insufficient", async () => {
    let calls = 0;
    const { engine } = await setup({
      beforeDecision: async (view) => {
        if (view.messageValidationFeedback)
          throw new DevflowError({
            code: "EXECUTION_BUDGET_EXCEEDED",
            message: "no correction capacity",
            details: { requestIssued: false },
          });
      },
      decide: async () => {
        calls++;
        return decision(send("task"));
      },
      observe: async () => [],
    });
    const state = await engine.run("run", task, 20);
    expect(calls).toBe(1);
    expect(state.stopReason).toBe("BUDGET_STOP");
    const reserved = state.agents[0]!.messageRecovery!.correctionOperationId;
    expect(state.operations.find((o) => o.id === reserved)).toMatchObject({
      kind: "MODEL",
      status: "NOT_ISSUED",
    });
    await engine.run("run", task, 20);
    expect(calls).toBe(1);
  });

  for (const window of ["rejection", "delivery"] as const)
    it(`recovers a crash after ${window} without repeating committed actions`, async () => {
      let calls = 0,
        crashed = false;
      const { engine, config, store } = await setup({
        decide: async (view) => {
          calls++;
          if (view.role === "COORDINATOR" && !view.history.length) return decision(send("task"));
          if (view.messageValidationFeedback)
            return decision(send(), {
              type: "PROPOSE_PLAN",
              evidenceIds: [],
              missing: ["Needs further analysis"],
            });
          throw new Error("Unexpected additional paid turn");
        },
        observe: async () => [],
        onChange: async (s) => {
          const ready =
            window === "rejection"
              ? s.operations.some((o) => o.failure?.message === "TEAM_REPLY_ID_INVALID")
              : s.messages.length === 1;
          if (ready && !crashed) {
            crashed = true;
            throw new Error("process exit after durable commit");
          }
        },
      });
      await expect(engine.run("run", task, 8)).rejects.toThrow("process exit");
      const saved = (await store.load("run"))!;
      expect(saved.operations.every((o) => o.status !== "UNKNOWN")).toBe(true);
      const restored = new TeamEngine({ ...config, onChange: undefined });
      await restored.initialize({
        runId: "run",
        repositoryId: "repo",
        sourceIdentity: "base",
        mode: "team",
      });
      const state = await restored.run("run", task, 8);
      expect(state.status).toBe("READY_FOR_PLAN");
      expect(state.messages).toHaveLength(1);
      expect(calls).toBe(2);
      expect(state.operations.filter((o) => o.kind === "MODEL")).toHaveLength(2);
    });

  for (const violation of ["recipient", "sender", "task", "source"] as const)
    it(`refuses a ${violation} mismatch without spending correction credit`, async () => {
      const { engine, store } = await setup({
        decide: async () => decision(send("message")),
        observe: async () => [],
      });
      const old = (await store.load("run"))!;
      const next = structuredClone(old);
      next.revision++;
      next.messages.push({
        id: "message",
        sequence: 1,
        from: violation === "sender" ? "outsider" : "investigator",
        to: violation === "recipient" ? "outsider" : next.coordinatorId,
        taskId: violation === "task" ? "another-task" : "task",
        type: "CHALLENGE",
        body: "Please check",
        evidenceIds: [],
        idempotencyKey: "incoming",
        sourceIdentity: violation === "source" ? "stale" : "base",
      });
      await store.compareAndSwap("run", old.revision, next);
      await expect(engine.run("run", task, 8)).rejects.toThrow(
        violation === "source" ? "TEAM_REPLY_SOURCE_STALE" : "TEAM_REPLY_AUTHORIZATION_DENIED",
      );
      const state = (await store.load("run"))!;
      expect(state.messages).toHaveLength(1);
      expect(state.agents[0]!.messageRecovery).toBeUndefined();
    });

  it("does not replay a successful first action when a later SEND needs correction", async () => {
    let calls = 0;
    const { engine } = await setup({
      decide: async (view) => {
        if (view.role === "INVESTIGATOR")
          return decision({ type: "RESULT", evidenceIds: [], hypotheses: [], missing: [] });
        calls++;
        return calls === 1
          ? decision(send(), send("task"))
          : decision({
              type: "PROPOSE_PLAN",
              evidenceIds: [],
              missing: ["Abandon the unnecessary reply"],
            });
      },
      observe: async () => [],
    });
    const state = await engine.run("run", task, 3);
    expect(state.status).toBe("READY_FOR_PLAN");
    expect(state.messages).toHaveLength(1);
    expect(state.agents[0]!.messageRecovery?.resolved).toBe(false);
  });
});
