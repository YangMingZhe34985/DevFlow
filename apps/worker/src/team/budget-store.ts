import type { BudgetLedgerStore, TeamStore } from "@devflow/database";
import { DevflowError, type TeamLease, type TeamSnapshot } from "@devflow/shared";

/** Bind a scheduler mutation and its team receipt to the same fenced database transaction. */
export function teamBudgetStore(input: {
  runId: string;
  base: BudgetLedgerStore;
  team: TeamStore;
  lease: TeamLease;
  /** Called on a fresh snapshot on every CAS attempt; must have no external side effects. */
  receipt?: (team: TeamSnapshot, ledger: unknown) => void;
}): BudgetLedgerStore {
  return {
    get: async (runId) => {
      if (runId !== input.runId)
        throw new DevflowError({ code: "CONFLICT", message: "TEAM_BUDGET_RUN_MISMATCH" });
      return input.base.get(runId);
    },
    compareAndSwap: async (runId, expectedRevision, value) => {
      if (runId !== input.runId || expectedRevision === null)
        throw new DevflowError({ code: "CONFLICT", message: "TEAM_REQUIRES_EXISTING_RUN_LEDGER" });
      const current = await input.team.load(runId);
      if (!current) throw new DevflowError({ code: "CONFLICT", message: "TEAM_STATE_REQUIRED" });
      const revision = current.revision;
      input.receipt?.(current, value);
      current.revision++;
      return input.team.compareAndSwap(runId, revision, current, input.lease, {
        expectedRevision,
        value,
      });
    },
  };
}
