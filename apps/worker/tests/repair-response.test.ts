import { describe, expect, it } from "vitest";
import { readFileContent, type SandboxSession } from "@devflow/sandbox";
import { vi } from "vitest";
import { checkRepairResponse, repairFinishInputError } from "../src/runs/repair-response.js";
import { PhaseCompletionSchema } from "@devflow/shared";
describe("repair response provenance", () => {
  it("reports unknown finding IDs and stale citations before accepting finishPhase", () => {
    const versions = new Map([["a.ts", "a".repeat(64)]]);
    expect(
      repairFinishInputError({ outcome: "CHANGED", findingIds: ["fake"] }, [], versions, ["real"]),
    ).toContain("unknown IDs fake");
    expect(
      repairFinishInputError(
        {
          outcome: "CONTRADICTED",
          evidence: [{ path: "a.ts", quote: "return true", fileSha256: "b".repeat(64) }],
        },
        [],
        versions,
      ),
    ).toContain("current complete SHA required");
    expect(
      repairFinishInputError(
        { outcome: "INSUFFICIENT_EVIDENCE", summary: "Need source outside scope" },
        [],
        versions,
      ),
    ).toBeUndefined();
  });
  it("validates per-finding no-edit responses and retains stale/unknown/unanswered IDs", async () => {
    const content = "return true",
      read = readFileContent(Buffer.from(content), { path: "a.ts" });
    const evidence = [{ path: "a.ts", quote: content, fileSha256: read.fileSha256! }];
    const response = PhaseCompletionSchema.parse({
      outcome: "CONTRADICTED",
      findingResponses: [
        {
          findingId: "one",
          outcome: "ALREADY_SATISFIED",
          summary: "Source satisfies one",
          evidence,
        },
        {
          findingId: "two",
          outcome: "CONTRADICTED",
          summary: "Stale citation",
          evidence: [{ ...evidence[0], fileSha256: "0".repeat(64) }],
        },
        { findingId: "fake", outcome: "CHANGED", summary: "Unknown ID", evidence },
      ],
    });
    const result = await checkRepairResponse(
      response,
      [],
      {
        readFile: async (input) => readFileContent(Buffer.from(content), input),
      } as unknown as SandboxSession,
      new AbortController().signal,
      undefined,
      ["one", "two", "three"],
      ["a.ts"],
    );
    expect(result?.findingResponses?.map((a) => [a.findingStatus, a.evidenceStatus])).toEqual([
      ["MATCHED", "CURRENT_SOURCE_LINKED"],
      ["MATCHED", "UNVERIFIED"],
      ["UNKNOWN", "UNVERIFIED"],
    ]);
    expect(result?.unansweredFindingIds).toEqual(["two", "three"]);
  });
  it("verifies a quote immediately after an approved edit without granting access to other files", async () => {
    const content = "export function convert() { return true; }";
    const current = readFileContent(Buffer.from(content), { path: "a.ts" });
    const readFile = vi.fn(async (request) => readFileContent(Buffer.from(content), request));
    const response = {
      outcome: "CHANGED" as const,
      evidence: [{ path: "a.ts", quote: "return true", fileSha256: current.fileSha256! }],
    };
    expect(
      (
        await checkRepairResponse(
          response,
          [],
          { readFile } as unknown as SandboxSession,
          new AbortController().signal,
          undefined,
          undefined,
          ["a.ts"],
        )
      )?.evidenceStatus,
    ).toBe("CURRENT_SOURCE_LINKED");
    expect(
      (
        await checkRepairResponse(
          { ...response, evidence: [{ ...response.evidence[0]!, quote: "forged" }] },
          [],
          { readFile } as unknown as SandboxSession,
          new AbortController().signal,
          undefined,
          undefined,
          ["a.ts"],
        )
      )?.evidenceStatus,
    ).toBe("UNVERIFIED");
    const before = readFile.mock.calls.length;
    expect(
      (
        await checkRepairResponse(
          {
            ...response,
            evidence: [{ ...response.evidence[0]!, path: "hidden-acceptance/private.ts" }],
          },
          [],
          { readFile } as unknown as SandboxSession,
          new AbortController().signal,
          undefined,
          undefined,
          ["a.ts"],
        )
      )?.evidenceStatus,
    ).toBe("UNVERIFIED");
    expect(readFile.mock.calls.length).toBe(before);
  });
  it("retains a no-edit answer, validates finding IDs and every current citation", async () => {
    const response = PhaseCompletionSchema.parse({
      outcome: "CONTRADICTED",
      summary: "Existing branch already handles the supported unit",
      findingIds: ["finding-one"],
      evidence: [{ path: "a.ts", quote: "return true", fileSha256: "a".repeat(64) }],
    });
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
      readFile: async () => ({ fileSha256: "a".repeat(64) }),
    } as unknown as SandboxSession;
    const result = await checkRepairResponse(
      response,
      observed,
      sandbox,
      new AbortController().signal,
      undefined,
      ["finding-one"],
    );
    expect(result).toMatchObject({
      summary: response.summary,
      findingStatus: "MATCHED",
      evidenceStatus: "CURRENT_SOURCE_LINKED",
      evidenceStatuses: [{ index: 0, status: "CURRENT_SOURCE_LINKED" }],
    });
    expect(
      (
        await checkRepairResponse(
          response,
          observed,
          sandbox,
          new AbortController().signal,
          undefined,
          ["other"],
        )
      )?.evidenceStatus,
    ).toBe("UNVERIFIED");
    expect(
      (
        await checkRepairResponse(
          { ...response, evidence: [{ ...response.evidence![0]!, quote: "invented" }] },
          observed,
          sandbox,
          new AbortController().signal,
          undefined,
          ["finding-one"],
        )
      )?.evidenceStatuses,
    ).toEqual([{ index: 0, status: "UNVERIFIED" }]);
  });
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
