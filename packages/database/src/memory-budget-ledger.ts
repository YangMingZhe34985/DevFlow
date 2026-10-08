import type { BudgetLedgerRecord, BudgetLedgerStore } from "./contracts.js";

/** Explicit test/local adapter. Production must use a durable CAS store. */
export class InMemoryBudgetLedgerStore implements BudgetLedgerStore {
  private readonly records = new Map<string, BudgetLedgerRecord>();

  async get(runId: string): Promise<BudgetLedgerRecord | null> {
    return structuredClone(this.records.get(runId) ?? null);
  }

  async compareAndSwap(
    runId: string,
    expectedRevision: number | null,
    value: unknown,
  ): Promise<boolean> {
    const current = this.records.get(runId);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    this.records.set(runId, {
      revision: expectedRevision === null ? 0 : expectedRevision + 1,
      value: structuredClone(value),
    });
    return true;
  }
}
