import { describe, expect, it } from "vitest";
import { InMemoryTeamStore } from "@devflow/database";
import type { TeamDecision, TeamEvidence } from "@devflow/shared";
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
        throw new Error("budget shortfall");
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
