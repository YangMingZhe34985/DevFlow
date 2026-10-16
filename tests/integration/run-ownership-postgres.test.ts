import { randomUUID } from "node:crypto";
import { PrismaDatabaseAdapter } from "@devflow/database";
import type { RunResult } from "@devflow/shared";
import { describe, expect, it } from "vitest";

describe.skipIf(process.env.DEVFLOW_POSTGRES_INTEGRATION !== "1")(
  "Run lease expiry and approval recovery",
  () => {
    it.each(["RENEW", "COMPLETE", "APPROVAL"] as const)(
      "evaluates lease expiry after a database row-lock wait for %s",
      async (operation) => {
        const a = PrismaDatabaseAdapter.fromConnectionString(process.env.TEST_DATABASE_URL!);
        const b = PrismaDatabaseAdapter.fromConnectionString(process.env.TEST_DATABASE_URL!);
        await Promise.all([a.connect(), b.connect()]);
        try {
          const repository = await a.repositories.create({
            name: `lease-lock-${randomUUID()}`,
            sourceKind: "GIT",
            sourceUri: "https://github.com/devflow/fixture.git",
          });
          const task = await a.tasks.create({
            repositoryId: repository.id,
            title: "Lease row lock",
            description: "No source mutation",
          });
          const run = (await a.runs.create({ taskId: task.id })).run;
          await a.runs.claim(run.id, "waiting-owner", 1000);
          let locked!: () => void;
          const acquired = new Promise<void>((resolve) => {
            locked = resolve;
          });
          const holding = a.client.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "Run" WHERE "id" = ${run.id} FOR UPDATE`;
            locked();
            await tx.$queryRaw`SELECT pg_sleep(1.2)::text`;
          });
          await acquired;
          const pending =
            operation === "RENEW"
              ? b.runs.renewLease(run.id, "waiting-owner", 60_000)
              : operation === "COMPLETE"
                ? b.runs.complete(run.id, "waiting-owner", successful(run.id))
                : b.runs.pauseForApproval(run.id, "waiting-owner", {
                    summary: "No stale approval",
                    steps: [],
                  });
          const observed = pending.catch((error: unknown) => error);
          await holding;
          if (operation === "RENEW") expect(await observed).toBe(false);
          else expect(await observed).toMatchObject({ code: "CONFLICT" });
        } finally {
          await Promise.all([a.disconnect(), b.disconnect()]);
        }
      },
    );
    it("does not renew, complete or request approval with an expired owner; recovery uses a new identity", async () => {
      const database = PrismaDatabaseAdapter.fromConnectionString(process.env.TEST_DATABASE_URL!);
      await database.connect();
      try {
        const repository = await database.repositories.create({
          name: `lease-${randomUUID()}`,
          sourceKind: "GIT",
          sourceUri: "https://github.com/devflow/fixture.git",
        });
        const task = await database.tasks.create({
          repositoryId: repository.id,
          title: "Lease expiry",
          description: "No source mutation",
        });
        const run = (await database.runs.create({ taskId: task.id })).run;
        const first = await database.runs.claim(run.id, "expired-owner", 60_000);
        expect(first).not.toBeNull();
        await database.client.run.update({
          where: { id: run.id },
          data: { leaseExpiresAt: new Date(0) },
        });
        expect(await database.runs.renewLease(run.id, "expired-owner", 60_000)).toBe(false);
        const result: RunResult = {
          runId: run.id,
          status: "SUCCEEDED",
          metrics: {
            durationMs: 1,
            steps: 1,
            modelCalls: 0,
            toolCalls: 0,
            retries: 0,
            modelLatencyMs: 0,
            toolLatencyMs: 0,
            tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
        };
        await expect(database.runs.complete(run.id, "expired-owner", result)).rejects.toMatchObject(
          { code: "CONFLICT" },
        );
        const plan = {
          summary: "Read approved source",
          steps: [{ id: "one", title: "Read", description: "Read approved source" }],
        };
        await expect(
          database.runs.pauseForApproval(run.id, "expired-owner", plan),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        const recovered = await database.runs.claim(
          run.id,
          "recovery-owner",
          60_000,
          first!.dispatchRevision,
        );
        expect(recovered?.executionOwner).toBe("recovery-owner");
        expect(await database.runs.renewLease(run.id, "expired-owner", 60_000)).toBe(false);
        expect(await database.runs.renewLease(run.id, "recovery-owner", 60_000)).toBe(true);
        const paused = await database.runs.pauseForApproval(run.id, "recovery-owner", plan);
        expect(paused.run.status).toBe("WAITING_APPROVAL");
        expect(await database.runs.renewLease(run.id, "recovery-owner", 60_000)).toBe(false);
        await database.approvals.resolveForWorkflow(paused.approval.id, { status: "APPROVED" });
        const resumed = await database.runs.claim(run.id, "approved-owner", 60_000);
        expect(resumed!.dispatchRevision).toBe(first!.dispatchRevision + 1);
        await expect(
          database.runs.complete(run.id, "recovery-owner", result),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect((await database.runs.complete(run.id, "approved-owner", result)).status).toBe(
          "SUCCEEDED",
        );
      } finally {
        await database.disconnect();
      }
    });
  },
);

function successful(runId: string): RunResult {
  return {
    runId,
    status: "SUCCEEDED",
    metrics: {
      durationMs: 1,
      steps: 1,
      modelCalls: 0,
      toolCalls: 0,
      retries: 0,
      modelLatencyMs: 0,
      toolLatencyMs: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    },
  };
}
