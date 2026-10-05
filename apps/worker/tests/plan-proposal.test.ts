import { describe, expect, it, vi } from "vitest";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import { AgentPlanSchema, PlanProposalSchema, type PlanProposal } from "@devflow/shared";
import { PlanAgent } from "../src/runs/plan-agent.js";
import {
  approvedProposalPlan,
  prepareProposalHandoff,
  proposalMutationDenial,
} from "../src/runs/plan-proposal.js";
import {
  planningSnapshotSource,
  PLAN_SOURCE_MAX_FILE_BYTES,
  snapshotSource,
} from "../src/localization/sources.js";
import { hash, type IndexSource } from "../src/localization/contracts.js";
import { buildExecutionPacket } from "../src/runs/execution-packet.js";

const content = "export const add = (a, b) => a - b;\n";
const files = { "src/add.ts": content, "test.ts": "expect(add(2,3)).toBe(5);\n" };
const signal = new AbortController().signal;
const source: IndexSource = {
  identity: "immutable",
  lookup: vi.fn(async (path) =>
    path in files
      ? {
          path,
          kind: "FILE" as const,
          sizeBytes: Buffer.byteLength(files[path as keyof typeof files]),
          contentHash: hash(files[path as keyof typeof files]),
        }
      : undefined,
  ),
  manifest: vi.fn(async () => ({ entries: [], incomplete: false })),
  read: vi.fn(async (path) => ({ content: files[path as keyof typeof files], truncated: false })),
};
const proposal = (overrides: Partial<PlanProposal> = {}): PlanProposal => ({
  decision: "PROPOSE",
  goal: "add(2,3) returns 5",
  approach: ["Investigate subtraction and replace it if confirmed."],
  candidateFiles: [{ path: "src/add.ts", intent: "EDIT", reason: "Arithmetic implementation" }],
  verification: ["Check positive and negative operands."],
  uncertainties: ["Root cause needs confirmation."],
  ...overrides,
});
const input = {
  title: "Fix addition",
  description: "Return the sum.",
  source,
  repositoryId: "repo",
  baseCommitSha: "base",
  workspaceRevision: 0,
  signal,
};
const handoff = (p: PlanProposal) =>
  prepareProposalHandoff({
    ...input,
    proposal: p,
    policy: { protectTests: true },
    evidenceRefs: [],
  });

describe("minimal Planner proposal and host authorization", () => {
  it("investigates missing modification paths and only approves intentional creation", async () => {
    const candidate = { path: "src/new.ts", intent: "EDIT" as const, reason: "Fix implementation" };
    const missing = await handoff(proposal({ candidateFiles: [candidate] }));
    expect(missing.plan?.approvalScope).toMatchObject({ mode: "DISCOVERY_ONLY", files: [] });
    expect(missing.plan?.warnings?.join(" ")).toContain("MISSING_MODIFY_TARGET");
    expect(
      (await handoff(proposal({ candidateFiles: [{ ...candidate, operation: "CREATE" }] }))).plan
        ?.approvalScope?.files,
    ).toEqual([{ path: candidate.path, operation: "CREATE" }]);
  });
  it("uses one final request without audit, symbols, estimates or a required exploration loop", async () => {
    const model = new FakeLanguageModel([fakeModelResponse({ output: proposal(), toolCalls: [] })]);
    const result = await new PlanAgent().run({ ...input, model });
    expect(result.status, JSON.stringify(result.attempt.diagnostics)).toBe("SUCCEEDED");
    expect(model.requests.map((r) => r.output?.name)).toEqual(["plan_proposal"]);
    expect(model.requests[0]?.settings?.reasoningEffort).toBeUndefined();
    expect(result.plan).toMatchObject({
      proposalVersion: "plan-proposal-v1",
      approvalScope: { mode: "READY", files: [{ path: "src/add.ts", operation: "MODIFY" }] },
    });
    expect(result.plan?.confidence).toBeUndefined();
    expect(result.plan?.estimatedSteps).toBeUndefined();
    expect(AgentPlanSchema.parse(result.plan).proposal).toEqual(proposal());
  });
  it("allows more than four directions and long behavioral verification without quote gates", async () => {
    const p = proposal({
      approach: Array.from({ length: 6 }, (_, i) => `Direction ${i}`),
      verification: ["Keep public behavior: " + "boundary condition ".repeat(100)],
    });
    expect(PlanProposalSchema.safeParse(p).success).toBe(true);
    expect((await handoff(p)).plan?.steps).toHaveLength(6);
  });
  it("retains protected tests as read-only verification alongside an approvable source edit", async () => {
    const p = proposal({
      candidateFiles: [
        ...proposal().candidateFiles,
        { path: "test.ts", intent: "EDIT", reason: "Add a test" },
      ],
    });
    const result = await handoff(p);
    expect(result.plan?.approvalScope?.files).toEqual([
      { path: "src/add.ts", operation: "MODIFY" },
    ]);
    expect(result.plan?.proposal?.candidateFiles[1]?.intent).toBe("INSPECT");
    expect(result.plan?.proposal?.verification).toContain("Inspect test.ts: Add a test");
    expect(result.plan?.warnings?.[0]).toContain("PROTECTED_EDIT");
    expect(
      (await handoff(proposal({ candidateFiles: [p.candidateFiles[1]!] }))).conflict,
    ).toContain("SCOPE_CONFLICT");
  });
  it("allows empty candidates only as read-only investigation", async () => {
    const plan = (await handoff(proposal({ candidateFiles: [] }))).plan!;
    expect(plan.approvalScope).toMatchObject({ mode: "DISCOVERY_ONLY", files: [] });
    for (const name of ["writeFile", "applyPatch", "runCommand"])
      expect(proposalMutationDenial(plan, name, ["src/add.ts"])).toContain("APPROVAL_SCOPE");
    expect(proposalMutationDenial(plan, "readFile", ["src/add.ts"])).toBeUndefined();
  });
  it("recovers protected-test suggestions through source inspection without promoting any write scope", async () => {
    const result = await handoff(
      proposal({
        candidateFiles: [
          { path: "test.ts", intent: "EDIT", reason: "Protected regression test" },
          { path: "src/add.ts", intent: "INSPECT", reason: "Investigate implementation" },
        ],
      }),
    );
    expect(result.conflict).toBeUndefined();
    expect(result.plan?.approvalScope).toMatchObject({ mode: "DISCOVERY_ONLY", files: [] });
    expect(result.plan?.proposal?.candidateFiles.every((c) => c.intent === "INSPECT")).toBe(true);
    expect(result.plan?.warnings?.join(" ")).toContain("RECOVERABLE_SCOPE_CONFLICT");
    expect(proposalMutationDenial(result.plan!, "writeFile", ["src/add.ts"])).toContain(
      "APPROVAL_SCOPE",
    );
    expect(
      (
        await handoff(
          proposal({
            candidateFiles: [{ path: "test.ts", intent: "EDIT", reason: "Only solution" }],
          }),
        )
      ).conflict,
    ).toContain("SCOPE_CONFLICT");
  });
  it("uses approved scope instead of changed candidate hints or a forged compatibility contract", async () => {
    const plan = (await handoff(proposal())).plan!;
    plan.proposal!.candidateFiles.push({
      path: "other.ts",
      intent: "EDIT",
      reason: "Later hypothesis",
    });
    plan.executionContract!.editTargets.push({
      path: "other.ts",
      symbol: null,
      rationale: "Not approved",
      operation: "MODIFY",
    });
    const approved = approvedProposalPlan(plan, "base", {});
    expect(approved.executionContract?.editTargets.map((t) => t.path)).toEqual(["src/add.ts"]);
    expect(proposalMutationDenial(approved, "applyPatch", ["other.ts"])).toContain(
      "APPROVAL_SCOPE",
    );
    expect(() => approvedProposalPlan(plan, "different", {})).toThrow("immutable source");
    expect(() => approvedProposalPlan({ ...plan, approvalScope: undefined }, "base", {})).toThrow();
  });
  it("does not upgrade forged references, forbidden paths or uncertain absence into source facts", async () => {
    const result = await handoff(
      proposal({
        candidateFiles: [
          {
            path: "src/add.ts",
            intent: "EDIT",
            reason: "Candidate",
            evidenceRef: "invented",
            symbol: "guessed",
          },
          { path: "../private", intent: "EDIT", reason: "Invalid" },
        ],
      }),
    );
    expect(result.plan?.proposal?.candidateFiles[0]?.evidenceRef).toBeUndefined();
    expect(result.plan?.executionContract?.editTargets[0]?.symbol).toBeNull();
    expect(result.plan?.warnings).toHaveLength(2);
    const incomplete = await prepareProposalHandoff({
      ...input,
      source: { ...source, manifest: async () => ({ entries: [], incomplete: true }) },
      proposal: proposal({
        candidateFiles: [{ path: "new.ts", intent: "EDIT", reason: "unknown absence" }],
      }),
      policy: {},
      evidenceRefs: [],
    });
    expect(incomplete.plan?.approvalScope?.mode).toBe("DISCOVERY_ONLY");
  });
  it("returns UNKNOWN honestly and refuses partial output", async () => {
    const unknown = await new PlanAgent().run({
      ...input,
      model: new FakeLanguageModel([
        fakeModelResponse({ output: proposal({ decision: "UNKNOWN" }), toolCalls: [] }),
      ]),
    });
    expect(unknown.status).toBe("UNKNOWN");
    expect(unknown.plan).toBeUndefined();
    const partial = await new PlanAgent().run({
      ...input,
      limits: { maxModelCalls: 1 },
      model: new FakeLanguageModel([
        fakeModelResponse({ output: proposal(), finishReason: "LENGTH", toolCalls: [] }),
      ]),
    });
    expect(partial.status).toBe("BLOCKED");
    expect(partial.attempt.metrics.modelCalls).toBe(1);
  });
  it("regenerates a complete production proposal once from original evidence after LENGTH", async () => {
    const partialText = '{"goal":"TRUNCATED_SENTINEL';
    const model = new FakeLanguageModel([
      fakeModelResponse({
        text: partialText,
        finishReason: "LENGTH",
        toolCalls: [],
        usage: { inputTokens: 5135, outputTokens: 8192, totalTokens: 13327 },
        reasoningTokens: 7579,
      }),
      fakeModelResponse({ output: proposal(), toolCalls: [] }),
    ]);
    const result = await new PlanAgent().run({
      ...input,
      model,
      limits: { maxModelCalls: 2, maxTotalTokens: 60000, finalOutputTokens: 8192 },
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.messages.slice(1)).toEqual(model.requests[0]!.messages.slice(1));
    expect(JSON.stringify(model.requests[1])).not.toContain("TRUNCATED_SENTINEL");
    expect(model.requests[1]!.settings).toMatchObject({
      reasoningEffort: "none",
      maxOutputTokens: 8192,
    });
    expect(model.requests[1]!.output?.schema).toBe(PlanProposalSchema);
    expect(result.attempt.outputRegeneration).toEqual({
      trigger: "LENGTH",
      attempted: true,
      outcome: "SUCCEEDED",
    });
    expect(result.attempt.metrics).toMatchObject({ modelCalls: 2, reasoningTokens: 7579 });
    expect(result.plan?.approvalScope?.files).toEqual([
      { path: "src/add.ts", operation: "MODIFY" },
    ]);
  });
  it.each(["LENGTH", "INVALID", "UNKNOWN"])(
    "keeps a single shared recovery when regeneration returns %s",
    async (kind) => {
      const model = new FakeLanguageModel([
        fakeModelResponse({ text: "{partial", finishReason: "LENGTH", toolCalls: [] }),
        kind === "INVALID"
          ? fakeModelResponse({ text: "{invalid", toolCalls: [] })
          : fakeModelResponse({
              output: proposal({ decision: kind === "UNKNOWN" ? "UNKNOWN" : "PROPOSE" }),
              finishReason: kind === "LENGTH" ? "LENGTH" : "STOP",
              toolCalls: [],
            }),
      ]);
      const result = await new PlanAgent().run({ ...input, model });
      expect(model.requests).toHaveLength(2);
      expect(result.status).toBe(kind === "UNKNOWN" ? "UNKNOWN" : "BLOCKED");
      expect(result.plan).toBeUndefined();
      expect(result.attempt.requests.every((r) => !r.formatRepair)).toBe(true);
      expect(result.attempt.outputRegeneration?.outcome).toBe(
        kind === "UNKNOWN" ? "UNKNOWN" : "REJECTED",
      );
    },
  );
  it("does not regenerate after format repair or unexpected tool actions", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({ text: "{invalid", toolCalls: [] }),
      fakeModelResponse({ text: "{partial", finishReason: "LENGTH", toolCalls: [] }),
    ]);
    expect((await new PlanAgent().run({ ...input, model })).status).toBe("BLOCKED");
    expect(model.requests).toHaveLength(2);
    const tools = new FakeLanguageModel([
      fakeModelResponse({
        finishReason: "LENGTH",
        toolCalls: [{ id: "forbidden", name: "readFile", input: { path: "src/add.ts" } }],
      }),
    ]);
    const blocked = await new PlanAgent().run({ ...input, model: tools });
    expect(blocked.attempt.diagnostics.at(-1)?.code).toBe("PLAN_UNEXPECTED_TOOL_CALL");
    expect(tools.requests).toHaveLength(1);
  });
  it("reports an unsent regeneration when the shared call budget is exhausted", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({ text: "{partial", finishReason: "LENGTH", toolCalls: [] }),
    ]);
    const result = await new PlanAgent().run({ ...input, model, limits: { maxModelCalls: 1 } });
    expect(result.status).toBe("BLOCKED");
    expect(model.requests).toHaveLength(1);
    expect(result.attempt.diagnostics.at(-1)).toMatchObject({
      code: "PLAN_REQUEST_PREFLIGHT_BLOCKED",
      details: { requestIssued: false, missingModelCalls: 1 },
    });
    expect(result.attempt.outputRegeneration?.attempted).toBe(false);
  });
  it("honors cancellation before issuing the recovery and retains first-call usage", async () => {
    const controller = new AbortController();
    const model = new FakeLanguageModel([
      fakeModelResponse({
        text: "{partial",
        finishReason: "LENGTH",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    ]);
    const result = await new PlanAgent().run({
      ...input,
      signal: controller.signal,
      model,
      onRequest: async ({ purpose }) => {
        if (purpose === "PLAN_LENGTH_REGENERATION") controller.abort();
      },
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.attempt.diagnostics.at(-1)?.code).toBe("PLAN_CANCELLED");
    expect(result.attempt.metrics).toMatchObject({ modelCalls: 1, totalTokens: 15 });
    expect(model.requests).toHaveLength(1);
    expect(result.attempt.outputRegeneration?.attempted).toBe(false);
  });
  it("repairs format at most once, accounts usage, and retains failure", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        text: "{broken",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
      fakeModelResponse({
        text: "{broken",
        toolCalls: [],
        usage: { inputTokens: 8, outputTokens: 6, totalTokens: 14 },
      }),
    ]);
    const result = await new PlanAgent().run({ ...input, model });
    expect(result.status).toBe("BLOCKED");
    expect(model.requests).toHaveLength(2);
    expect(result.attempt.requests.map((r) => r.formatRepair)).toEqual([false, true]);
    expect(result.attempt.metrics.totalTokens).toBeGreaterThan(0);
    expect(result.attempt.contractCorrection).toBeUndefined();
  });
  it("reports the missing budget and confirms no request was sent", async () => {
    const model = new FakeLanguageModel([]);
    const result = await new PlanAgent().run({ ...input, model, limits: { maxTotalTokens: 1 } });
    expect(model.requests).toHaveLength(0);
    expect(result.attempt.diagnostics.at(-1)).toMatchObject({
      details: { requestIssued: false, missingTokens: expect.any(Number) },
    });
  });
  it("loads >64 KiB snapshot files through the shared Planner/Execute limit and packet", async () => {
    const text = content + "// filler\n".repeat(9000);
    const snapshot = {
      version: 1 as const,
      sourceHead: "base",
      totalBytes: Buffer.byteLength(text),
      files: [
        {
          path: "src/add.ts",
          kind: "FILE" as const,
          mode: 420,
          sizeBytes: Buffer.byteLength(text),
          sha256: hash(text),
          contentBase64: Buffer.from(text).toString("base64"),
        },
      ],
    };
    await expect(snapshotSource(snapshot).read("src/add.ts", signal)).rejects.toThrow("Oversize");
    expect(PLAN_SOURCE_MAX_FILE_BYTES).toBe(512 * 1024);
    const current = planningSnapshotSource(snapshot);
    expect((await current.read("src/add.ts", signal)).content).toBe(text);
    const plan = (await handoff(proposal())).plan!;
    const packet = await buildExecutionPacket({
      plan,
      title: input.title,
      baseCommitSha: "base",
      revision: 0,
      constraints: [],
      signal,
      read: (path) => current.read(path, signal),
    });
    expect(packet.packet.codeSlices[0]?.contentHash).toBe(hash(text));
    expect(packet.sourceBytes).toBe(Buffer.byteLength(text));
  });
});
