import { describe, expect, it, vi } from "vitest";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import type { PlanProposal } from "@devflow/shared";
import { PlanAgent } from "../src/runs/plan-agent.js";
import { prepareProposalHandoff, proposalMutationDenial } from "../src/runs/plan-proposal.js";
import { hash, type IndexSource } from "../src/localization/contracts.js";

const files: Record<string, string> = {
  "core/schemas.ts": "// padding\n".repeat(3501) + "export const $ZodDefault = 1;\n",
  "locales/fr.ts": "export default function locale() { return 'French'; }\n",
};
const entries = Object.entries(files).map(([path, content]) => ({
  path,
  kind: "FILE" as const,
  sizeBytes: Buffer.byteLength(content),
  contentHash: hash(content),
}));
const source: IndexSource = {
  identity: "snapshot:test",
  lookup: async (path) => entries.find((e) => e.path === path),
  manifest: async () => ({ entries, incomplete: false }),
  read: vi.fn(async (path) => ({ content: files[path]!, truncated: false })),
};
const proposal: PlanProposal = {
  decision: "PROPOSE",
  goal: "Fix public default behavior",
  approach: ["Verify implementation"],
  candidateFiles: [],
  verification: [],
  uncertainties: ["Hypothesis"],
};
const input = {
  title: "default issue",
  description: "Check the default",
  repositoryId: "repo",
  baseCommitSha: "base",
  workspaceRevision: 0,
  source,
  signal: new AbortController().signal,
};
describe("one read-only proposal investigation", () => {
  it("reads the candidate symbol at line 3502 instead of a header", async () => {
    const result = await new PlanAgent().run({
      ...input,
      discoveryCandidates: [
        {
          path: "core/schemas.ts",
          intent: "INSPECT",
          symbol: "$ZodDefault",
          reason: "Default implementation",
        },
      ],
      model: new FakeLanguageModel([fakeModelResponse({ output: proposal, toolCalls: [] })]),
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.attempt.evidenceRefs[0]).toMatchObject({
      path: "core/schemas.ts",
      startLine: 3494,
      endLine: 3502,
      contentHash: hash(files["core/schemas.ts"]!),
      sourceVerified: true,
    });
    expect(
      result.preparedFinalRequest!.messages.some((m) =>
        JSON.stringify(m).includes("export const $ZodDefault"),
      ),
    ).toBe(true);
  });
  it("reports a missing first path, observes alternate source, and continues remaining candidates", async () => {
    const result = await new PlanAgent().run({
      ...input,
      discoveryCandidates: [
        { path: "classic/locales/fr.ts", intent: "INSPECT", reason: "French messages" },
        {
          path: "core/schemas.ts",
          intent: "INSPECT",
          symbol: "$ZodDefault",
          reason: "Default implementation",
        },
      ],
      model: new FakeLanguageModel([fakeModelResponse({ output: proposal, toolCalls: [] })]),
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.attempt.diagnostics.some((d) => d.code === "PLAN_SOURCE_UNAVAILABLE")).toBe(true);
    expect(result.attempt.metrics.reads).toBe(2);
    expect(result.attempt.evidenceRefs.map((r) => r.path)).toEqual([
      "locales/fr.ts",
      "core/schemas.ts",
    ]);
    expect(result.plan!.approvalScope).toMatchObject({ mode: "DISCOVERY_ONLY", files: [] });
  });
  it("retains UNKNOWN and forces read-only scope even for proposed edits", async () => {
    const unknown: PlanProposal = {
      ...proposal,
      decision: "UNKNOWN",
      candidateFiles: [{ path: "core/schemas.ts", intent: "EDIT", reason: "Need evidence" }],
    };
    const result = await new PlanAgent().run({
      ...input,
      allowUnknownDiscovery: true,
      model: new FakeLanguageModel([fakeModelResponse({ output: unknown, toolCalls: [] })]),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.plan?.proposal?.decision).toBe("UNKNOWN");
    expect(result.plan?.approvalScope).toMatchObject({ mode: "DISCOVERY_ONLY", files: [] });
    expect(proposalMutationDenial(result.plan!, "replaceText", ["core/schemas.ts"])).toContain(
      "APPROVAL_SCOPE",
    );
    expect(
      (await prepareProposalHandoff({ ...input, proposal: unknown, policy: {}, evidenceRefs: [] }))
        .plan?.approvalScope?.files,
    ).toEqual([]);
    const next = await new PlanAgent().run({
      ...input,
      model: new FakeLanguageModel([fakeModelResponse({ output: unknown, toolCalls: [] })]),
    });
    expect(next.plan).toBeUndefined();
  });
  it("does not manufacture an investigation with no public direction", async () => {
    const result = await new PlanAgent().run({
      ...input,
      allowUnknownDiscovery: true,
      model: new FakeLanguageModel([
        fakeModelResponse({ output: { ...proposal, decision: "UNKNOWN" }, toolCalls: [] }),
      ]),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.plan).toBeUndefined();
  });
  it("finalizes after optional snippets exhaust the shared byte allowance instead of failing the entire proposal", async () => {
    const read = vi.fn(source.read);
    const result = await new PlanAgent().run({
      ...input,
      source: { ...source, read },
      limits: { maxSnippetBytes: 35 },
      discoveryCandidates: [
        {
          path: "core/schemas.ts",
          intent: "INSPECT",
          symbol: "$ZodDefault",
          reason: "Default implementation",
        },
        { path: "locales/fr.ts", intent: "INSPECT", reason: "Additional optional evidence" },
      ],
      model: new FakeLanguageModel([
        fakeModelResponse({ output: { ...proposal, decision: "UNKNOWN" }, toolCalls: [] }),
      ]),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.attempt.metrics.modelCalls).toBe(1);
    expect(
      result.attempt.diagnostics.some((d) => d.code === "PLAN_DISCOVERY_SNIPPET_RESERVE"),
    ).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects forbidden and stale discovery source before any model request", async () => {
    for (const [path, altered] of [
      ["hidden-acceptance/a.ts", source],
      [
        "core/schemas.ts",
        { ...source, read: async () => ({ content: "changed", truncated: false }) },
      ],
    ] as const) {
      const model = new FakeLanguageModel([]);
      const result = await new PlanAgent().run({
        ...input,
        source: altered,
        model,
        discoveryCandidates: [{ path, intent: "INSPECT", reason: "Untrusted candidate" }],
      });
      expect(result.status).toBe("BLOCKED");
      expect(model.requests).toHaveLength(0);
    }
  });
});
