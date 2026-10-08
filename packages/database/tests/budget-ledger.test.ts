import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../src/generated/prisma/client.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { InMemoryBudgetLedgerStore } from "../src/memory-budget-ledger.js";
import { PrismaDatabaseAdapter } from "../src/prisma-adapter.js";

describe("atomic budget ledger persistence", () => {
  it("initializes under a null JSON guard and advances whole-metadata CAS without dropping unrelated metadata", async () => {
    const prior = {
      otherFeature: { keep: true },
      resourceBudgetLedger: { revision: 3, value: { consumed: 40 } },
    };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({ metadata: null })
      .mockResolvedValueOnce({ metadata: prior });
    const database = new PrismaDatabaseAdapter({
      run: { findUnique, updateMany },
    } as unknown as PrismaClient);
    expect(await database.budgetLedgers.compareAndSwap("run", null, { consumed: 0 })).toBe(true);
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "run", metadata: { equals: Prisma.AnyNull } },
      data: { metadata: { resourceBudgetLedger: { revision: 0, value: { consumed: 0 } } } },
    });
    expect(await database.budgetLedgers.compareAndSwap("run", 3, { consumed: 50 })).toBe(true);
    expect(updateMany.mock.calls[1]?.[0]).toMatchObject({
      where: { id: "run", metadata: { equals: prior } },
      data: {
        metadata: {
          otherFeature: { keep: true },
          resourceBudgetLedger: { revision: 4, value: { consumed: 50 } },
        },
      },
    });
  });

  it("rejects stale revision before write and reports a competing metadata update as CAS failure", async () => {
    const metadata = { resourceBudgetLedger: { revision: 4, value: { consumed: 50 } } };
    const findUnique = vi.fn(async () => ({ metadata }));
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const database = new PrismaDatabaseAdapter({
      run: { findUnique, updateMany },
    } as unknown as PrismaClient);
    expect(await database.budgetLedgers.compareAndSwap("run", 3, {})).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
    expect(await database.budgetLedgers.compareAndSwap("run", 4, {})).toBe(false);
    expect(await database.budgetLedgers.get("run")).toEqual(metadata.resourceBudgetLedger);
  });

  it("does not reinterpret corrupt metadata or an invalid revision as a new ledger", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({ metadata: { resourceBudgetLedger: { value: {} } } })
      .mockResolvedValueOnce({ metadata: ["legacy-array"] });
    const updateMany = vi.fn();
    const database = new PrismaDatabaseAdapter({
      run: { findUnique, updateMany },
    } as unknown as PrismaClient);
    await expect(database.budgetLedgers.get("run")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(database.budgetLedgers.get("run")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(database.budgetLedgers.compareAndSwap("run", -1, {})).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("explicit memory adapter isolates snapshots and permits only one CAS winner", async () => {
    const store = new InMemoryBudgetLedgerStore();
    expect(await store.compareAndSwap("run", null, { consumed: 0 })).toBe(true);
    const result = await Promise.all([
      store.compareAndSwap("run", 0, { consumed: 1 }),
      store.compareAndSwap("run", 0, { consumed: 2 }),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    const snapshot = await store.get("run");
    (snapshot?.value as { consumed: number }).consumed = 999;
    expect(await store.get("run")).toEqual({ revision: 1, value: { consumed: 1 } });
  });
});
