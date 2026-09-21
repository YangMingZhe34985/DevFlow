import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaDatabaseAdapter } from "../src/prisma-adapter.js";

const CREDENTIAL_URI = "https://secret-token@github.com/example/private.git";

describe("Prisma credential boundaries", () => {
  it("rejects repository create and update before invoking Prisma", async () => {
    const create = vi.fn();
    const update = vi.fn();
    const database = new PrismaDatabaseAdapter({
      repository: { create, update },
    } as unknown as PrismaClient);

    await expect(
      database.repositories.create({
        name: "private",
        sourceKind: "GIT",
        sourceUri: CREDENTIAL_URI,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      database.repositories.update("repository-id", { sourceUri: CREDENTIAL_URI }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a benchmark sourceUri before persisting its definition", async () => {
    const findUnique = vi.fn();
    const create = vi.fn();
    const database = new PrismaDatabaseAdapter({
      benchmarkCaseExecution: { findUnique, create },
    } as unknown as PrismaClient);

    await expect(
      database.benchmarkExecutions.startCase({
        id: "00000000-0000-4000-8000-000000000001",
        suiteId: "suite",
        suiteVersion: "1",
        caseId: "case",
        caseVersion: "1",
        definitionDigest: "a".repeat(64),
        definition: { repository: { sourceUri: CREDENTIAL_URI } },
        profile: {},
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
