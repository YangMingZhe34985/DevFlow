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
});
