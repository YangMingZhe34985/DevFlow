import { describe, expect, it } from "vitest";
import type { SandboxSession } from "@devflow/sandbox";
import { checkRepairResponse } from "../src/runs/repair-response.js";
describe("repair response provenance", () => {
  it("does not accept historical or concurrently changed source as current evidence", async () => {
    const response = {
      outcome: "ALREADY_SATISFIED" as const,
      evidence: [{ path: "a.ts", quote: "return true", fileSha256: "a".repeat(64) }],
    };
    const observed = [
      {
        path: "a.ts",
        code: "return true",
        contentHash: "a".repeat(64),
        startLine: 1,
        endLine: 1,
        workspaceRevision: 1,
        complete: false,
        role: "TARGET" as const,
      },
    ];
    const sandbox = {
      readFile: async () => ({ fileSha256: "b".repeat(64) }),
    } as unknown as SandboxSession;
    expect(
      (await checkRepairResponse(response, observed, sandbox, new AbortController().signal))
        ?.evidenceStatus,
    ).toBe("UNVERIFIED");
    expect(
      (await checkRepairResponse(response, [], sandbox, new AbortController().signal))
        ?.evidenceStatus,
    ).toBe("UNVERIFIED");
  });
});
