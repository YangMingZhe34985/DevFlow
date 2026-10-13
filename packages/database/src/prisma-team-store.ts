import { createHash } from "node:crypto";
import {
  DevflowError,
  teamCanonicalJson,
  type TeamLease,
  type TeamSnapshot,
} from "@devflow/shared";
import { type Prisma, type PrismaClient } from "./generated/prisma/client.js";
import type { TeamStore } from "./team-store.js";

const digest = (value: unknown) =>
  createHash("sha256").update(teamCanonicalJson(value)).digest("hex");
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const conflict = (message: string): never => {
  throw new DevflowError({ code: "CONFLICT", message });
};

/** The Run row is the serialization point for lease, cancellation, team and ledger changes. */
export class PrismaTeamStore implements TeamStore {
  constructor(private readonly client: PrismaClient) {}

  async load(runId: string): Promise<TeamSnapshot | null> {
    const row = await this.client.runTeamState.findUnique({ where: { runId } });
    if (!row) return null;
    const value = row.state as unknown as TeamSnapshot;
    if (value.version !== 1 || value.runId !== runId || value.revision !== row.revision)
      conflict("TEAM_STATE_IDENTITY_INVALID");
    return value;
  }

  async compareAndSwap(
    runId: string,
    expectedRevision: number | null,
    next: TeamSnapshot,
    lease: TeamLease,
    budget?: { expectedRevision: number; value: unknown },
  ): Promise<boolean> {
    if (next.runId !== runId || next.revision !== (expectedRevision ?? -1) + 1)
      conflict("TEAM_REVISION_CONFLICT");
    return this.client.$transaction(
      async (tx) => {
        // A DB clock prevents a paused/stale worker's local clock from reviving a lease.
        await assertTeamLease(tx, runId, lease);
        const previous = await tx.runTeamState.findUnique({ where: { runId } });
        if ((previous?.revision ?? null) !== expectedRevision) return false;
        const old = previous?.state as unknown as TeamSnapshot | undefined;
        validateTransition(old, next);
        if (budget) {
          const run = await tx.run.findUniqueOrThrow({
            where: { id: runId },
            select: { metadata: true },
          });
          const metadata = run.metadata as Record<string, Prisma.JsonValue> | null;
          if (metadata !== null && (typeof metadata !== "object" || Array.isArray(metadata)))
            conflict("TEAM_BUDGET_METADATA_INVALID");
          const ledger = metadata?.resourceBudgetLedger as
            { revision: number; value: unknown } | undefined;
          if (ledger?.revision !== budget.expectedRevision) return false;
          await tx.run.update({
            where: { id: runId },
            data: {
              metadata: json({
                ...metadata,
                resourceBudgetLedger: {
                  revision: budget.expectedRevision + 1,
                  value: budget.value,
                },
              }),
            },
          });
        }
        await tx.runTeamState.upsert({
          where: { runId },
          create: { runId, revision: next.revision, state: json(next) },
          update: { revision: next.revision, state: json(next) },
        });
        // Only changed rows are written. Immutable messages are never rewritten during later turns.
        for (const row of changed(old?.agents, next.agents)) {
          const value = {
            role: row.role,
            status: row.status,
            value: json(row),
            sha256: digest(row),
          };
          await tx.agentInstance.upsert({
            where: { runId_id: { runId, id: row.id } },
            create: { runId, id: row.id, ...value },
            update: value,
          });
        }
        for (const row of changed(old?.tasks, next.tasks)) {
          const value = {
            agentId: row.agentId,
            status: row.status,
            value: json(row),
            sha256: digest(row),
          };
          await tx.agentTask.upsert({
            where: { runId_id: { runId, id: row.id } },
            create: { runId, id: row.id, ...value },
            update: value,
          });
        }
        for (const row of changed(old?.messages, next.messages))
          await tx.agentMessage.create({
            data: {
              runId,
              id: row.id,
              sequence: row.sequence,
              recipient: row.to,
              idempotencyKey: row.idempotencyKey,
              value: json(row),
              sha256: digest(row),
            },
          });
        for (const row of changed(old?.evidence, next.evidence)) {
          const value = { valid: row.valid, value: json(row), sha256: digest(row) };
          await tx.sharedEvidence.upsert({
            where: { runId_id: { runId, id: row.id } },
            create: { runId, id: row.id, ...value },
            update: value,
          });
        }
        for (const row of changed(old?.operations, next.operations)) {
          const value = {
            agentId: row.agentId,
            status: row.status,
            value: json(row),
            sha256: digest(row),
          };
          await tx.agentOperation.upsert({
            where: { runId_id: { runId, id: row.id } },
            create: { runId, id: row.id, ...value },
            update: value,
          });
        }
        return true;
      },
      { timeout: 15_000 },
    );
  }
}

export async function assertTeamLease(
  tx: Prisma.TransactionClient,
  runId: string,
  lease: TeamLease,
): Promise<void> {
  const owners = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Run" WHERE "id" = ${runId}::uuid
    AND "executionOwner" = ${lease.owner} AND "dispatchRevision" = ${lease.dispatchRevision}
    AND "status" = 'RUNNING' AND "cancelRequestedAt" IS NULL
    AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE`;
  if (owners.length !== 1) conflict("TEAM_LEASE_LOST_OR_CANCELLED");
}

function changed<T extends { id: string }>(old: T[] | undefined, next: T[]): T[] {
  const hashes = new Map(old?.map((row) => [row.id, digest(row)]));
  return next.filter((row) => hashes.get(row.id) !== digest(row));
}

function validateTransition(old: TeamSnapshot | undefined, next: TeamSnapshot): void {
  for (const key of ["agents", "tasks", "messages", "evidence", "operations"] as const) {
    const ids = new Set(next[key].map((r) => r.id));
    if (ids.size !== next[key].length || old?.[key].some((r) => !ids.has(r.id)))
      conflict("TEAM_HISTORY_CANNOT_BE_REMOVED_OR_DUPLICATED");
  }
  if (
    old &&
    (old.mode !== next.mode ||
      old.repositoryId !== next.repositoryId ||
      digest(old.config) !== digest(next.config) ||
      digest(old.modelBindings) !== digest(next.modelBindings))
  )
    conflict("TEAM_FROZEN_CONFIGURATION_CHANGED");
  if (old && old.sourceIdentity !== next.sourceIdentity) {
    const transition = next.viewTransitions?.at(-1);
    if (
      !transition ||
      transition.from !== old.sourceIdentity ||
      transition.to !== next.sourceIdentity ||
      next.viewTransitions?.length !== (old.viewTransitions?.length ?? 0) + 1 ||
      transition.feedbackId !== next.feedback?.id
    )
      conflict("TEAM_SOURCE_TRANSITION_UNVERIFIED");
  }
  if (
    next.agents.some((a) => a.runId !== next.runId) ||
    next.evidence.some(
      (e) =>
        e.runId !== next.runId ||
        e.repositoryId !== next.repositoryId ||
        (e.valid && e.sourceIdentity !== next.sourceIdentity),
    )
  )
    conflict("TEAM_CROSS_RUN_IDENTITY_INVALID");
  if (old?.messages.some((m) => digest(m) !== digest(next.messages.find((r) => r.id === m.id))))
    conflict("TEAM_MESSAGE_IS_IMMUTABLE");
  for (const evidence of old?.evidence ?? []) {
    const current = next.evidence.find((e) => e.id === evidence.id)!;
    if (
      digest({ ...evidence, valid: false }) !== digest({ ...current, valid: false }) ||
      (!evidence.valid && current.valid)
    )
      conflict("TEAM_EVIDENCE_CANNOT_BE_REWRITTEN_OR_REVALIDATED_WITHOUT_A_NEW_OBSERVATION");
  }
  for (const op of old?.operations ?? []) {
    const current = next.operations.find((o) => o.id === op.id)!;
    if (
      op.agentId !== current.agentId ||
      op.kind !== current.kind ||
      digest(op.input) !== digest(current.input) ||
      (op.status === "COMPLETED" &&
        (current.status !== "COMPLETED" || digest(current.output) !== digest(op.output))) ||
      (op.applied === true && current.applied !== true)
    )
      conflict("TEAM_OPERATION_CANNOT_REWIND");
  }
  for (const agent of old?.agents ?? []) {
    const current = next.agents.find((a) => a.id === agent.id)!;
    if (
      current.sessionId !== agent.sessionId ||
      current.role !== agent.role ||
      current.decisionCount < agent.decisionCount ||
      current.inboxCursor < agent.inboxCursor ||
      current.history.length < agent.history.length
    )
      conflict("TEAM_SESSION_CANNOT_REWIND");
    if (
      agent.messageRecovery &&
      (!current.messageRecovery ||
        current.messageRecovery.originOperationId !== agent.messageRecovery.originOperationId ||
        current.messageRecovery.sourceIdentity !== agent.messageRecovery.sourceIdentity ||
        digest(current.messageRecovery.issue) !== digest(agent.messageRecovery.issue) ||
        (agent.messageRecovery.correctionOperationId &&
          current.messageRecovery.correctionOperationId !==
            agent.messageRecovery.correctionOperationId) ||
        (agent.messageRecovery.resolved && !current.messageRecovery.resolved))
    )
      conflict("TEAM_MESSAGE_RECOVERY_CANNOT_REWIND");
  }
}
