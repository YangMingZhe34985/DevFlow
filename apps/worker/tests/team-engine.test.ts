import { describe, expect, it } from "vitest";
import { InMemoryTeamStore } from "@devflow/database";
import { DevflowError, type TeamDecision, type TeamEvidence } from "@devflow/shared";
import { TeamEngine, teamDigest, type TeamDecisionView } from "../src/team/engine.js";

const task = { title: "Cached value is stale", description: "Reload must expose updated values." };
const lease = { owner: "worker", dispatchRevision: 0 };
const result = (actions: TeamDecision["actions"]): TeamDecision => ({
  summary: "Use current evidence to investigate",
  actions,
});
const observation = (path: string): TeamEvidence => ({
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
  sourceOperationId: "host-read",
  supports: [],
  valid: true,
});

describe("dynamic collaboration core", () => {
  it("reopens a changed Coding view without reviving old evidence or renewing decisions", async () => {
    const store = new InMemoryTeamStore();
    let count = 0;
    const engine = new TeamEngine({
      store,
      lease,
      signal: AbortSignal.timeout(5000),
      decide: async (view) => {
        count++;
        return result([
          { type: "PROPOSE_PLAN", evidenceIds: view.evidence.map((e) => e.id), missing: [] },
        ]);
      },
      observe: async () => [],
    });
    await engine.initialize({
      runId: "run",
      repositoryId: "repo",
      sourceIdentity: "base",
      mode: "team",
      evidence: [observation("old.ts")],
    });
    await engine.run("run", task, 8);
    const next = { ...observation("current.ts"), sourceIdentity: "candidate" };
    const feedback = {
      id: "validation-1",
      origin: "VALIDATION" as const,
      description: "Public test still fails after an approved edit",
    };
    await engine.reopen("run", "candidate", [next], feedback);
    const reopened = (await store.load("run"))!;
    expect(reopened.evidence.find((e) => e.id === "old.ts")?.valid).toBe(false);
    expect(reopened.agents[0]!.decisionCount).toBe(1);
    await engine.run("run", task, 8);
    await engine.reopen("run", "candidate", [next], feedback);
    await engine.run("run", task, 8);
    expect(count).toBe(2);
    expect((await store.load("run"))!.viewTransitions).toHaveLength(1);
    await expect(engine.reopen("run", "another", [], feedback)).rejects.toThrow(
      "TEAM_FEEDBACK_SOURCE_CHANGED",
    );
  });

  it("does not count varied tool errors as source progress and preserves their receipts", async () => {
    const store = new InMemoryTeamStore();
    let calls = 0;
    const engine = new TeamEngine({
      store,
      lease,
      signal: AbortSignal.timeout(5000),
      decide: async () =>
        result([{ type: "READ", path: `${++calls}.ts`, startLine: 1, endLine: 1 }]),
      observe: async (a) => [{ ...observation(JSON.stringify(a)), kind: "TOOL_ERROR" }],
    });
    await engine.initialize({
      runId: "run",
      repositoryId: "repo",
      sourceIdentity: "base",
      mode: "single",
    });
    const stopped = await engine.run("run", task, 8);
    expect(calls).toBe(2);
    expect(stopped.stopReason).toBe("STALLED");
    expect(stopped.operations.filter((o) => o.kind === "TOOL")).toHaveLength(2);
  });
  it("resumes saved decisions and action receipts without another model or physical read", async () => {
    for (const window of ["response", "tool", "control"]) {
      const store = new InMemoryTeamStore();
      let calls = 0,
        reads = 0,
        crashed = false;
      const ports = {
        store,
        lease,
        signal: AbortSignal.timeout(5000),
        decide: async () => {
          calls++;
          return result(
            window === "control"
              ? [{ type: "PROPOSE_PLAN", evidenceIds: [], missing: [] }]
              : [
                  { type: "READ", path: "source.ts", startLine: 1, endLine: 1 },
                  { type: "PROPOSE_PLAN", evidenceIds: ["source.ts"], missing: [] },
                ],
          );
        },
        observe: async () => {
          reads++;
          return [observation("source.ts")];
        },
      };
      const engine = new TeamEngine({
        ...ports,
        onChange: async (s) => {
          const completed = s.operations.some(
            (o) =>
              o.status === "COMPLETED" &&
              o.kind === (window === "response" ? "MODEL" : window === "tool" ? "TOOL" : "CONTROL"),
          );
          if (completed && !crashed) {
            crashed = true;
            throw new Error("simulated process exit");
          }
        },
      });
      await engine.initialize({
        runId: "run",
        repositoryId: "repo",
        sourceIdentity: "base",
        mode: "single",
      });
      await expect(engine.run("run", task, 1)).rejects.toThrow("simulated process exit");
      const saved = await store.load("run");
      // A post-commit process death has a durable tool receipt even when caller did not see it.
      expect(saved?.operations.some((o) => o.status === "UNKNOWN")).toBe(false);
      const restored = new TeamEngine(ports);
      await restored.initialize({
        runId: "run",
        repositoryId: "repo",
        sourceIdentity: "base",
        mode: "single",
      });
      const done = await restored.run("run", task, 1);
      expect(done.status).toBe("READY_FOR_PLAN");
      expect(calls).toBe(1);
      expect(reads).toBe(window === "control" ? 0 : 1);
      expect(done.agents[0]?.history).toHaveLength(1);
      await restored.run("run", task, 10);
      expect(calls).toBe(1);
    }
  });
  it("delegates different work for different evidence and permits zero investigators", async () => {
    for (const path of ["cache.ts", "loader.ts", "sufficient.ts"]) {
      const store = new InMemoryTeamStore(),
        read: string[] = [];
      const engine = new TeamEngine({
        store,
        lease,
        signal: AbortSignal.timeout(5000),
        decide: async (view) => {
          if (view.role === "COORDINATOR")
            return result(
              view.board.length || path === "sufficient.ts"
                ? [
                    {
                      type: "PROPOSE_PLAN",
                      evidenceIds: view.evidence.map((e) => e.id),
                      missing: [],
                    },
                  ]
                : [
                    {
                      type: "DELEGATE",
                      key: path,
                      goal: `Investigate ${path}`,
                      evidenceIds: [],
                      dependsOn: [],
                    },
                  ],
            );
          return result(
            view.history.length
              ? [
                  {
                    type: "RESULT",
                    evidenceIds: view.evidence.map((e) => e.id),
                    hypotheses: ["Candidate is supported, cause unproven"],
                    missing: [],
                  },
                ]
              : [{ type: "READ", path, startLine: 1, endLine: 1 }],
          );
        },
        observe: async (action) => {
          if (action.type !== "READ") throw new Error();
          read.push(action.path);
          return [observation(action.path)];
        },
      });
      await engine.initialize({
        runId: "run",
        repositoryId: "repo",
        sourceIdentity: "base",
        mode: "team",
      });
      const state = await engine.run("run", task, 12);
      expect(state.status).toBe("READY_FOR_PLAN");
      expect(read).toEqual(path === "sufficient.ts" ? [] : [path]);
      expect(state.agents.filter((a) => a.role === "INVESTIGATOR")).toHaveLength(
        path === "sufficient.ts" ? 0 : 1,
      );
    }
  });

  it("authenticates A's challenge and changes B's actual source action without broadcasting A's history", async () => {
    const store = new InMemoryTeamStore(),
      reads: string[] = [],
      views: TeamDecisionView[] = [];
    const engine = new TeamEngine({
      store,
      lease,
      signal: AbortSignal.timeout(5000),
      decide: async (view) => {
        views.push(structuredClone(view));
        if (view.role === "COORDINATOR")
          return result(
            view.board.length
              ? [{ type: "PROPOSE_PLAN", evidenceIds: view.evidence.map((e) => e.id), missing: [] }]
              : ["A", "B"].map((key) => ({
                  type: "DELEGATE" as const,
                  key,
                  goal: key,
                  evidenceIds: [],
                  dependsOn: [],
                })),
          );
        if (view.assignments[0]?.goal === "A") {
          if (!view.history.length)
            return result([{ type: "READ", path: "counterexample.ts", startLine: 1, endLine: 1 }]);
          if (view.history.length === 1) {
            const b = view.board.find((t) => t.goal === "B")!;
            return result([
              {
                type: "SEND",
                toAgentId: b.agentId,
                taskId: b.id,
                messageType: "CHALLENGE",
                body: "The cache is cleared; inspect consumer.ts instead.",
                evidenceIds: ["counterexample.ts"],
              },
            ]);
          }
        } else {
          if (!view.history.length) {
            // Model is independent and initially selects another path.
            await new Promise((resolve) => setTimeout(resolve, 15));
            return result([{ type: "READ", path: "cache.ts", startLine: 1, endLine: 1 }]);
          }
          if (view.inbox.length)
            return result([{ type: "READ", path: "consumer.ts", startLine: 1, endLine: 1 }]);
        }
        return result([
          {
            type: "RESULT",
            evidenceIds: view.evidence.map((e) => e.id),
            hypotheses: [],
            missing: [],
          },
        ]);
      },
      observe: async (action) => {
        if (action.type !== "READ") throw new Error();
        reads.push(action.path);
        return [observation(action.path)];
      },
    });
    await engine.initialize({
      runId: "run",
      repositoryId: "repo",
      sourceIdentity: "base",
      mode: "team",
    });
    const state = await engine.run("run", task, 16);
    expect(state.status).toBe("READY_FOR_PLAN");
    expect(reads).toEqual(expect.arrayContaining(["cache.ts", "counterexample.ts", "consumer.ts"]));
    const b = state.tasks.find((t) => t.goal === "B")!;
    const received = views.find((v) => v.agentId === b.agentId && v.inbox.length)!;
    expect(received.inbox[0]?.from).toBe(state.tasks.find((t) => t.goal === "A")!.agentId);
    expect(received.history).toHaveLength(1);
    expect(JSON.stringify(received.history)).not.toContain("counterexample.ts");
  });

  it("stops repeated reads without another paid summary and preserves counts on resume", async () => {
    const store = new InMemoryTeamStore();
    let calls = 0,
      reads = 0;
    const engine = new TeamEngine({
      store,
      lease,
      signal: AbortSignal.timeout(5000),
      decide: async () => {
        calls++;
        return result([{ type: "READ", path: "same.ts", startLine: 1, endLine: 1 }]);
      },
      observe: async () => {
        reads++;
        return [observation("same.ts")];
      },
    });
    await engine.initialize({
      runId: "run",
      repositoryId: "repo",
      sourceIdentity: "base",
      mode: "single",
    });
    const state = await engine.run("run", task, 12);
    expect(state.stopReason).toBe("STALLED");
    expect(calls).toBe(2);
    expect(reads).toBe(1);
    await engine.initialize({
      runId: "run",
      repositoryId: "repo",
      sourceIdentity: "base",
      mode: "single",
    });
    await engine.run("run", task, 12);
    expect(calls).toBe(2);
    await expect(
      engine.initialize({
        runId: "run",
        repositoryId: "repo",
        sourceIdentity: "changed",
        mode: "single",
      }),
    ).rejects.toThrow("MISMATCH");
  });

  it("does not dispatch an unaffordable decision and does not replay unknown provider work", async () => {
    const store = new InMemoryTeamStore();
    let calls = 0;
    const engine = new TeamEngine({
      store,
      lease,
      signal: AbortSignal.timeout(5000),
      beforeDecision: async () => {
        throw new DevflowError({
          code: "EXECUTION_BUDGET_EXCEEDED",
          message: "budget shortfall",
          details: {
            requestIssued: false,
            quote: { shortfalls: { costMicros: 123 }, remaining: { costMicros: 10 } },
          },
        });
      },
      decide: async () => {
        calls++;
        throw new Error();
      },
      observe: async () => [],
    });
    await engine.initialize({
      runId: "run",
      repositoryId: "repo",
      sourceIdentity: "base",
      mode: "team",
    });
    const state = await engine.run("run", task, 12);
    expect(calls).toBe(0);
    expect(state.operations[0]?.status).toBe("NOT_ISSUED");
    expect(state.operations[0]?.failure).toMatchObject({
      code: "EXECUTION_BUDGET_EXCEEDED",
      details: { requestIssued: false, quote: { shortfalls: { costMicros: 123 } } },
    });
    await engine.run("run", task, 12);
    expect(calls).toBe(0);
    expect((await store.load("run"))?.operations[0]?.failure).toEqual(state.operations[0]?.failure);
    const uncertain = structuredClone(state);
    uncertain.revision++;
    uncertain.operations[0]!.status = "UNKNOWN";
    await store.compareAndSwap("run", state.revision, uncertain);
    await expect(
      engine.initialize({
        runId: "run",
        repositoryId: "repo",
        sourceIdentity: "base",
        mode: "team",
      }),
    ).rejects.toThrow("OUTCOME_UNKNOWN");
  });

  it("rejects made-up evidence and prevents the single control spawning peers", async () => {
    for (const mode of ["team", "single"] as const) {
      const store = new InMemoryTeamStore();
      const engine = new TeamEngine({
        store,
        lease,
        signal: AbortSignal.timeout(5000),
        decide: async () =>
          result(
            mode === "team"
              ? [{ type: "PROPOSE_PLAN", evidenceIds: ["fake"], missing: [] }]
              : [{ type: "DELEGATE", key: "x", goal: "x", dependsOn: [], evidenceIds: [] }],
          ),
        observe: async () => [],
      });
      await engine.initialize({ runId: "run", repositoryId: "repo", sourceIdentity: "base", mode });
      await expect(engine.run("run", task, 12)).rejects.toThrow(
        mode === "team" ? "REFERENCE_INVALID" : "CANNOT_DELEGATE",
      );
    }
  });
});
