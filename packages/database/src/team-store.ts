import type { TeamLease, TeamSnapshot } from "@devflow/shared";

export interface TeamStore {
  load(runId: string): Promise<TeamSnapshot | null>;
  /** Snapshot and optional budget CAS commit together under the active Run lease. */
  compareAndSwap(
    runId: string,
    expectedRevision: number | null,
    next: TeamSnapshot,
    lease: TeamLease,
    budget?: { expectedRevision: number; value: unknown },
  ): Promise<boolean>;
}

/** Explicit fake adapter; production never falls back to this store. */
export class InMemoryTeamStore implements TeamStore {
  private readonly snapshots = new Map<string, TeamSnapshot>();
  async load(runId: string) {
    return structuredClone(this.snapshots.get(runId) ?? null);
  }
  async compareAndSwap(runId: string, expected: number | null, next: TeamSnapshot) {
    if ((this.snapshots.get(runId)?.revision ?? null) !== expected) return false;
    if (next.runId !== runId || next.revision !== (expected ?? -1) + 1)
      throw new Error("TEAM_REVISION_CONFLICT");
    this.snapshots.set(runId, structuredClone(next));
    return true;
  }
}
