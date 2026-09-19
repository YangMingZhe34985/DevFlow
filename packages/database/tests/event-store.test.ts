import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaDatabaseAdapter } from "../src/prisma-adapter.js";

describe("Prisma event store", () => {
  it("reads a run event log strictly after the cursor in sequence order", async () => {
    const occurredAt = new Date("2026-09-19T01:02:03.000Z");
    const findMany = vi.fn(async () => [
      {
        id: "00000000-0000-4000-8000-000000000003",
        runId: "00000000-0000-4000-8000-000000000001",
        stepId: null,
        toolCallId: null,
        sequence: 3,
        type: "STEP_COMPLETED",
        level: "INFO" as const,
        payload: { stage: "TEST" },
        occurredAt,
      },
    ]);
    const client = { event: { findMany } } as unknown as PrismaClient;
    const database = new PrismaDatabaseAdapter(client);

    const events = await database.events.list("00000000-0000-4000-8000-000000000001", {
      afterSequence: 2,
      limit: 25,
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        runId: "00000000-0000-4000-8000-000000000001",
        sequence: { gt: 2 },
      },
      orderBy: { sequence: "asc" },
      take: 25,
    });
    expect(events).toEqual([
      {
        schemaVersion: 1,
        eventId: "00000000-0000-4000-8000-000000000003",
        runId: "00000000-0000-4000-8000-000000000001",
        sequence: 3,
        occurredAt: "2026-09-19T01:02:03.000Z",
        type: "STEP_COMPLETED",
        level: "INFO",
        payload: { stage: "TEST" },
      },
    ]);
  });

  it("rejects invalid cursors and unbounded page sizes before querying Prisma", async () => {
    const findMany = vi.fn();
    const client = { event: { findMany } } as unknown as PrismaClient;
    const database = new PrismaDatabaseAdapter(client);

    await expect(database.events.list("run", { afterSequence: -1 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(database.events.list("run", { limit: 1_001 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(findMany).not.toHaveBeenCalled();
  });
});
