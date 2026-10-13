import { randomUUID } from "node:crypto";
import { PrismaDatabaseAdapter, databaseExecutionLease } from "@devflow/database";
import type { TeamLease, TeamSnapshot, TeamMessageArgumentIssue } from "@devflow/shared";
import { describe, expect, it } from "vitest";
import { TeamEngine } from "../../apps/worker/src/team/engine.js";
import { teamBudgetStore } from "../../apps/worker/src/team/budget-store.js";
import {
  ResourceBudgetScheduler,
  type ResourceBudgetLedger,
} from "../../apps/worker/src/runs/resource-budget-scheduler.js";

describe.skipIf(process.env.DEVFLOW_RESOURCE_BUDGET_INTEGRATION !== "1")(
  "durable team transactions",
  () => {
    it.each(["evidence", "blocked-target"] as const)(
      "resumes %s rejection after a committed crash without replaying the original decision",
      async (kind) =>
        fixture(async (a, b, state, lease) => {
          const agentId = randomUUID(),
            taskId = randomUUID();
          if (kind === "blocked-target") {
            const seeded = structuredClone(state);
            seeded.revision++;
            seeded.agents.push({
              ...structuredClone(state.agents[0]!),
              id: agentId,
              sessionId: randomUUID(),
              role: "INVESTIGATOR",
              status: "BLOCKED",
              taskIds: [taskId],
            });
            seeded.tasks.push({
              id: taskId,
              key: "consumer",
              agentId,
              goal: "Check consumer",
              sourceIdentity: "base",
              dependsOn: [],
              evidenceIds: [],
              status: "BLOCKED",
              reason: "BUDGET_STOP",
            });
            await a.teams.compareAndSwap(state.runId, state.revision, seeded, lease);
          }
          let originalCalls = 0,
            correctionCalls = 0;
          const first = new TeamEngine({
            store: a.teams,
            lease,
            signal: AbortSignal.timeout(5000),
            observe: async () => [],
            decide: async () => {
              originalCalls++;
              return {
                summary: "Frozen invalid protocol action",
                actions:
                  kind === "evidence"
                    ? [{ type: "PROPOSE_PLAN", evidenceIds: ["guessed-id"], missing: [] }]
                    : [
                        {
                          type: "SEND",
                          toAgentId: agentId,
                          taskId,
                          messageType: "REQUEST_EVIDENCE",
                          body: "Continue",
                          evidenceIds: [],
                        },
                      ],
              };
            },
            onChange: async (snapshot) => {
              if (snapshot.agents[0]!.messageRecovery) throw Error("Crash after rejection commit");
            },
          });
          await expect(
            first.run(state.runId, { title: "Task", description: "Task" }, 8),
          ).rejects.toThrow("Crash after rejection commit");
          const saved = (await b.teams.load(state.runId))!;
          expect(saved.agents[0]!.messageRecovery?.correctionOperationId).toBeUndefined();
          const resumed = new TeamEngine({
            store: b.teams,
            lease,
            signal: AbortSignal.timeout(5000),
            observe: async () => [],
            decide: async (view) => {
              correctionCalls++;
              expect(view.messageValidationFeedback?.issue.field).toBe(
                kind === "evidence" ? "evidenceIds" : "toAgentId/taskId",
              );
              return {
                summary: "Preserve the unresolved gap",
                actions: [
                  {
                    type: "STOP",
                    reason: "INSUFFICIENT_EVIDENCE",
                    missing: ["Need a valid investigation target/evidence"],
                  },
                ],
              };
            },
          });
          await resumed.initialize({
            runId: state.runId,
            repositoryId: state.repositoryId,
            sourceIdentity: "base",
            mode: "team",
          });
          const final = await resumed.run(state.runId, { title: "Task", description: "Task" }, 8);
          expect([originalCalls, correctionCalls]).toEqual([1, 1]);
          expect(final.agents[0]!.decisionCount).toBe(2);
          expect(final.agents[0]!.messageRecovery).toMatchObject({
            originOperationId: saved.agents[0]!.messageRecovery!.originOperationId,
            resolved: true,
          });
          expect(
            final.operations.filter((o) => o.kind === "CONTROL" && o.status === "NOT_ISSUED"),
          ).toHaveLength(1);
          expect(final.messages).toEqual([]);
          expect(final.selectedEvidenceIds).toEqual([]);
          if (kind === "blocked-target")
            expect(final.agents.find((x) => x.id === agentId)?.status).toBe("BLOCKED");
          expect((await a.teams.load(state.runId))?.revision).toBe(final.revision);
        }),
    );

    it.each<TeamMessageArgumentIssue>([
      {
        field: "replyTo",
        expected: "messageId",
        actual: "task-id",
        reason: "TASK_ID_IN_MESSAGE_FIELD",
        availableReplies: [],
        guidance: "Omit replyTo for a new message.",
      },
      {
        field: "evidenceIds",
        expected: "currentVisibleEvidenceIds",
        actual: "unknown",
        reason: "EVIDENCE_ID_UNKNOWN_OR_STALE",
        availableReplies: [],
        invalidEvidenceIds: ["unknown"],
        availableEvidence: [{ id: "source-1", path: "src.ts", fileSha256: "a".repeat(64) }],
        guidance: "Choose a current visible evidence ID.",
      },
      {
        field: "toAgentId/taskId",
        expected: "availableAgentTaskPair",
        actual: "investigator/task",
        reason: "TARGET_UNAVAILABLE",
        availableReplies: [],
        target: {
          agentId: "investigator",
          status: "BLOCKED",
          taskId: "task",
          taskStatus: "BLOCKED",
          reason: "BUDGET_STOP",
        },
        guidance: "Do not revive the blocked agent.",
      },
    ])("persists $field correction credit and refuses renewal across connections", async (issue) =>
      fixture(async (a, b, state, lease) => {
        const granted = structuredClone(state);
        granted.revision++;
        granted.agents[0]!.messageRecovery = {
          originOperationId: "decision-1:send",
          sourceIdentity: "base",
          issue,
        };
        expect(await a.teams.compareAndSwap(state.runId, state.revision, granted, lease)).toBe(
          true,
        );
        const reserved = (await b.teams.load(state.runId))!;
        reserved.revision++;
        reserved.agents[0]!.messageRecovery!.correctionOperationId = "decision-2";
        expect(await b.teams.compareAndSwap(state.runId, granted.revision, reserved, lease)).toBe(
          true,
        );
        for (const mutate of [
          (s: TeamSnapshot) => {
            delete s.agents[0]!.messageRecovery;
          },
          (s: TeamSnapshot) => {
            delete s.agents[0]!.messageRecovery!.correctionOperationId;
          },
          (s: TeamSnapshot) => {
            s.agents[0]!.messageRecovery!.originOperationId = "fresh-credit";
          },
        ]) {
          const bad = structuredClone(reserved);
          bad.revision++;
          mutate(bad);
          await expect(
            a.teams.compareAndSwap(state.runId, reserved.revision, bad, lease),
          ).rejects.toThrow("TEAM_MESSAGE_RECOVERY_CANNOT_REWIND");
        }
        expect((await a.teams.load(state.runId))!.agents[0]!.messageRecovery).toEqual(
          reserved.agents[0]!.messageRecovery,
        );
        expect((await a.teams.load(state.runId))!.revision).toBe(reserved.revision);
      }),
    );
    it("fences inherited Coding artifacts and events after lease loss", async () =>
      fixture(async (a, b, state, lease) => {
        await databaseExecutionLease.run({ ...lease, runId: state.runId }, async () => {
          await a.artifacts.create({
            runId: state.runId,
            kind: "OTHER",
            name: "current",
            content: "current",
          });
          await b.client.run.update({
            where: { id: state.runId },
            data: { executionOwner: "new-owner" },
          });
          await expect(
            a.artifacts.create({
              runId: state.runId,
              kind: "OTHER",
              name: "stale",
              content: "stale",
            }),
          ).rejects.toMatchObject({ code: "CONFLICT" });
          await expect(
            a.events.append({
              runId: state.runId,
              type: "WORKFLOW_CHECKPOINT",
              occurredAt: new Date().toISOString(),
              payload: {},
            }),
          ).rejects.toMatchObject({ code: "CONFLICT" });
          expect((await a.artifacts.list(state.runId)).map((r) => r.name)).toEqual(["current"]);
        });
      }));
    it("uses the real scheduler to atomically publish a result and settle its original Run reservation", async () =>
      fixture(async (a, b, state, lease) => {
        const scheduler = await ResourceBudgetScheduler.open({
          runId: state.runId,
          store: a.budgetLedgers,
          limits: { tokens: 1000, steps: 32 },
          startedAt: 1000,
          deadlineAt: 100000,
          clock: () => 1000,
        });
        const op = {
          id: "team-operation",
          agentId: state.coordinatorId,
          kind: "MODEL" as const,
          status: "PREPARED" as const,
          input: { goal: "read" },
        };
        await a.teams.compareAndSwap(
          state.runId,
          0,
          { ...state, revision: 1, operations: [op] },
          lease,
        );
        const scoped = scheduler.withStore(
          teamBudgetStore({
            runId: state.runId,
            base: a.budgetLedgers,
            team: a.teams,
            lease,
            receipt: (snapshot, value) => {
              const reservation = (value as ResourceBudgetLedger).reservations[op.id];
              const current = snapshot.operations.find((o) => o.id === op.id)!;
              if (reservation?.status === "ADMITTED") current.status = "INFLIGHT";
              if (reservation?.status === "SETTLED") {
                current.status = "COMPLETED";
                current.output = { observation: "counterexample" };
              }
            },
          }),
        );
        await scoped.reserve(op.id, {
          kind: "OPERATION",
          id: op.id,
          requirement: "REQUIRED",
          state: "PENDING",
          resources: { tokens: 600, steps: 1 },
        });
        await scoped.admit(op.id);
        // Frozen E10 shape: one Investigator settles while a search in a sibling
        // fans out into index/source operations on the very same Run ledger.
        await Promise.all([
          scoped.settle(op.id, { tokens: 500, steps: 1 }),
          ...Array.from({ length: 48 }, async (_, index) => {
            const id = `index-read-${index}`;
            expect(
              (
                await scheduler.reserve(id, {
                  kind: "OPERATION",
                  id,
                  requirement: "REQUIRED",
                  state: "PENDING",
                  resources: { ioReads: 1 },
                })
              ).reserved,
            ).toBe(true);
            expect((await scheduler.admit(id)).admitted).toBe(true);
            await scheduler.settle(id, { ioReads: 1 });
          }),
        ]);
        await scoped.settle(op.id, { tokens: 500, steps: 1 });
        expect((await b.teams.load(state.runId))?.operations[0]).toMatchObject({
          status: "COMPLETED",
          output: { observation: "counterexample" },
        });
        expect((await scheduler.snapshot()).consumed).toMatchObject({
          tokens: 500,
          steps: 1,
          ioReads: 48,
        });
        await b.client.run.update({
          where: { id: state.runId },
          data: { cancelRequestedAt: new Date() },
        });
        await expect(
          scoped.reserve("stale", {
            kind: "OPERATION",
            id: "stale",
            requirement: "REQUIRED",
            state: "PENDING",
            resources: { tokens: 100 },
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect((await scheduler.snapshot()).reservations.stale).toBeUndefined();
      }));
    it("serializes sibling updates and rejects a stale worker after approval/resume", async () =>
      fixture(async (a, b, state, lease) => {
        const next = { ...state, revision: 1, missing: ["first"] };
        const values = await Promise.all([
          a.teams.compareAndSwap(state.runId, 0, next, lease),
          b.teams.compareAndSwap(state.runId, 0, { ...next, missing: ["second"] }, lease),
        ]);
        expect(values.filter(Boolean)).toHaveLength(1);
        const paused = await a.runs.pauseForApproval(state.runId, lease.owner, {
          summary: "Approve scoped change",
          steps: [],
        });
        await expect(
          a.teams.compareAndSwap(state.runId, 1, { ...next, revision: 2 }, lease),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await b.approvals.resolveForWorkflow(paused.approval.id, { status: "APPROVED" });
        const resumed = await b.runs.claim(state.runId, "new-owner", 60_000);
        expect(resumed).not.toBeNull();
        await expect(
          a.teams.compareAndSwap(state.runId, 1, { ...next, revision: 2 }, lease),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(
          await b.teams.compareAndSwap(
            state.runId,
            1,
            { ...next, revision: 2 },
            { owner: "new-owner", dispatchRevision: resumed!.dispatchRevision },
          ),
        ).toBe(true);
        expect((await b.teams.load(state.runId))?.agents[0]?.sessionId).toBe(
          state.agents[0]?.sessionId,
        );
      }));

    it("commits budget and operation receipt together; conflicting revisions change neither", async () =>
      fixture(async (a, b, state, lease) => {
        await a.budgetLedgers.compareAndSwap(state.runId, null, { consumed: 0, deadline: 1234 });
        const receipt = {
          ...state,
          revision: 1,
          operations: [
            {
              id: "op",
              agentId: state.coordinatorId,
              kind: "MODEL" as const,
              status: "COMPLETED" as const,
              input: {},
              output: {},
            },
          ],
        };
        expect(
          await a.teams.compareAndSwap(state.runId, 0, receipt, lease, {
            expectedRevision: 4,
            value: { consumed: 100 },
          }),
        ).toBe(false);
        expect((await b.teams.load(state.runId))?.revision).toBe(0);
        expect((await b.budgetLedgers.get(state.runId))?.value).toEqual({
          consumed: 0,
          deadline: 1234,
        });
        expect(
          await a.teams.compareAndSwap(state.runId, 0, receipt, lease, {
            expectedRevision: 0,
            value: { consumed: 100, deadline: 1234 },
          }),
        ).toBe(true);
        expect(
          await b.teams.compareAndSwap(state.runId, 0, receipt, lease, {
            expectedRevision: 0,
            value: { consumed: 200 },
          }),
        ).toBe(false);
        expect((await b.budgetLedgers.get(state.runId))?.value).toEqual({
          consumed: 100,
          deadline: 1234,
        });
        expect(await b.client.agentOperation.count({ where: { runId: state.runId } })).toBe(1);
      }));

    it("fences cancellation and expiry and never accepts cross-run evidence", async () =>
      fixture(async (a, b, state, lease) => {
        const bad = structuredClone(state);
        bad.revision = 1;
        bad.agents[0]!.runId = randomUUID();
        await expect(a.teams.compareAndSwap(state.runId, 0, bad, lease)).rejects.toMatchObject({
          code: "CONFLICT",
        });
        await b.client.run.update({
          where: { id: state.runId },
          data: { cancelRequestedAt: new Date() },
        });
        await expect(
          a.teams.compareAndSwap(state.runId, 0, { ...state, revision: 1 }, lease),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await b.client.run.update({
          where: { id: state.runId },
          data: { cancelRequestedAt: null, leaseExpiresAt: new Date(0) },
        });
        await expect(
          a.teams.compareAndSwap(state.runId, 0, { ...state, revision: 1 }, lease),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect((await a.teams.load(state.runId))?.revision).toBe(0);
      }));

    it("preserves unknown calls across connection replacement without reissuing", async () =>
      fixture(async (a, b, state, lease) => {
        const unknown = {
          ...state,
          revision: 1,
          operations: [
            {
              id: "unknown",
              agentId: state.coordinatorId,
              kind: "MODEL" as const,
              status: "UNKNOWN" as const,
              input: {},
            },
          ],
        };
        await a.teams.compareAndSwap(state.runId, 0, unknown, lease);
        let calls = 0;
        const engine = new TeamEngine({
          store: b.teams,
          lease,
          signal: AbortSignal.timeout(5000),
          decide: async () => {
            calls++;
            throw new Error();
          },
          observe: async () => [],
        });
        await expect(
          engine.initialize({
            runId: state.runId,
            repositoryId: state.repositoryId,
            sourceIdentity: "base",
            mode: "team",
          }),
        ).rejects.toThrow("TEAM_OPERATION_OUTCOME_UNKNOWN");
        expect(calls).toBe(0);
      }));
  },
);

async function fixture(
  body: (
    a: PrismaDatabaseAdapter,
    b: PrismaDatabaseAdapter,
    state: TeamSnapshot,
    lease: TeamLease,
  ) => Promise<void>,
) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL required");
  const a = PrismaDatabaseAdapter.fromConnectionString(url),
    b = PrismaDatabaseAdapter.fromConnectionString(url);
  await Promise.all([a.connect(), b.connect()]);
  try {
    const repo = await a.repositories.create({
      name: `team-${randomUUID()}`,
      sourceKind: "GIT",
      sourceUri: "https://github.com/devflow/public-fixture.git",
    });
    const task = await a.tasks.create({
      repositoryId: repo.id,
      title: "Team isolation",
      description: "Read public source",
    });
    const run = (await a.runs.create({ taskId: task.id })).run;
    const owner = randomUUID(),
      claimed = await a.runs.claim(run.id, owner, 60_000);
    const lease = { owner, dispatchRevision: claimed!.dispatchRevision };
    const engine = new TeamEngine({
      store: a.teams,
      lease,
      signal: AbortSignal.timeout(5000),
      decide: async () => {
        throw new Error("not called");
      },
      observe: async () => [],
    });
    const state = await engine.initialize({
      runId: run.id,
      repositoryId: repo.id,
      sourceIdentity: "base",
      mode: "team",
    });
    await body(a, b, state, lease);
  } finally {
    await Promise.all([a.disconnect(), b.disconnect()]);
  }
}
