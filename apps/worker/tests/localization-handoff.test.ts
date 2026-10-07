import { describe, expect, it, vi } from "vitest";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import { hash, type IndexSource } from "../src/localization/contracts.js";
import { IssueLocalizer } from "../src/localization/retrieval.js";
import { IssueLocalizationAgent } from "../src/localization/issue-localization-agent.js";
import { PlanAgent } from "../src/runs/plan-agent.js";
import { planEvidenceRows } from "../src/runs/plan-agent-context.js";

const signal = new AbortController().signal;
function fixture() {
  const content =
    "export function publicProcess(value: number) {\n" +
    "  // unrelated padding ".repeat(4).concat("\n").repeat(30) +
    "  return value - 1;\n}\n";
  const entry = {
    path: "src/critical.ts",
    kind: "FILE" as const,
    sizeBytes: Buffer.byteLength(content),
    contentHash: hash(content),
  };
  const read = vi.fn(async () => ({ content, truncated: false }));
  const source: IndexSource = {
    identity: hash(JSON.stringify([entry])),
    fileCount: 1,
    manifest: async () => ({ entries: [entry], incomplete: false }),
    lookup: async (path) => (path === entry.path ? entry : undefined),
    read,
  };
  return { source, read, content };
}
const base = {
  repositoryId: "handoff",
  baseCommitSha: "a".repeat(40),
  title: "publicProcess() returns the wrong result",
  description: "The public API should preserve the supplied value.",
  signal,
};
const decision = {
  summary: "Root cause remains uncertain",
  hypotheses: [],
  inspect: [],
  candidates: [],
  uncertainty: ["Verify behavior before editing"],
};

describe("implementation evidence handoff", () => {
  it("revalidates the full SHA across a preparation revision and drops changed evidence", async () => {
    const { source, content } = fixture();
    const evidence = await new IssueLocalizer().retrieve({
      ...base,
      source,
      accessScope: "test",
      runId: "r",
      workspaceRevision: 0,
      description: base.title,
    });
    const localization = await new IssueLocalizationAgent().run({
      ...base,
      source,
      evidence,
      model: new FakeLanguageModel([
        fakeModelResponse({ text: JSON.stringify(decision), toolCalls: [] }),
      ]),
      maxTokens: 18000,
      buildGraph: true,
      retrieve: async () => undefined,
    });
    const ready = await new PlanAgent().prepare({
      ...base,
      source,
      localizationEvidence: localization,
      workspaceRevision: 1,
    });
    expect(ready.attempt.serializedFinalRequest).toContain("return value - 1");
    expect(ready.attempt.evidenceRefs.every((row) => row.workspaceRevision === 1)).toBe(true);
    const changed = content.replace("return value - 1", "return value");
    const stale = await new PlanAgent().prepare({
      ...base,
      workspaceRevision: 1,
      localizationEvidence: localization,
      source: {
        ...source,
        lookup: async () => ({
          path: "src/critical.ts",
          kind: "FILE",
          sizeBytes: Buffer.byteLength(changed),
          contentHash: hash(changed),
        }),
      },
    });
    expect(stale.attempt.serializedFinalRequest).not.toContain("return value - 1");
    expect(stale.attempt.diagnostics.some((d) => d.code === "PLAN_STALE_EVIDENCE")).toBe(true);
  });
  it("keeps implementation after 1600 characters in Localization and the actual Planner request, even without model-selected candidates", async () => {
    const { source, read, content } = fixture();
    const evidence = await new IssueLocalizer().retrieve({
      ...base,
      accessScope: "test",
      runId: "r",
      workspaceRevision: 0,
      source,
      description: base.title,
    });
    read.mockClear();
    const model = new FakeLanguageModel([
      (request) => {
        const state = JSON.parse(String(request.messages[1]!.content));
        const implementation = state.evidence.find((e: { snippet: string }) =>
          e.snippet.includes("return value - 1"),
        );
        expect(implementation).toBeDefined();
        expect(implementation.snippet.indexOf("return value - 1")).toBeGreaterThan(1600);
        expect(implementation.endLine).toBe(
          implementation.startLine + implementation.snippet.split("\n").length - 1,
        );
        return fakeModelResponse({ text: JSON.stringify(decision), toolCalls: [] });
      },
    ]);
    const localization = await new IssueLocalizationAgent().run({
      ...base,
      source,
      evidence,
      model,
      buildGraph: true,
      maxTokens: 18000,
      retrieve: async () => undefined,
    });
    expect(localization.candidates).toEqual([]);
    expect(
      localization.implementationEvidence?.some((e) => e.snippet.includes("return value - 1")),
    ).toBe(true);
    expect(localization.metrics.sourceReads).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(localization.metrics.readCacheHits).toBeGreaterThan(0);
    const planner = new FakeLanguageModel([
      fakeModelResponse({
        output: {
          decision: "UNKNOWN",
          goal: "Verify source behavior",
          approach: ["Inspect the implementation"],
          candidateFiles: [],
          verification: [],
          uncertainties: ["Hypothesis unverified"],
        },
        toolCalls: [],
      }),
    ]);
    await new PlanAgent().run({
      ...base,
      source,
      evidence,
      localizationEvidence: localization,
      workspaceRevision: 0,
      model: planner,
    });
    expect(JSON.stringify(planner.requests)).toContain("return value - 1");
    expect(JSON.stringify(planner.requests)).toContain(hash(content));
    expect(JSON.stringify(planner.requests)).toContain("observedImplementations");
    expect(
      planEvidenceRows(
        {
          ...base,
          source,
          localizationEvidence: {
            ...localization,
            evidenceState: { ...localization.evidenceState!, workspaceRevision: 1 },
          },
          workspaceRevision: 0,
        },
        12000,
      ).rows,
    ).toEqual([]);
  });

  it("does not treat a repeated query with different hypothesis wording as progress", async () => {
    const { source } = fixture();
    const pack = await new IssueLocalizer().retrieve({
      ...base,
      accessScope: "test",
      runId: "r",
      workspaceRevision: 0,
      source,
      description: base.title,
    });
    const search = vi.fn(async () => pack);
    const response = (explanation: string) =>
      fakeModelResponse({
        text: JSON.stringify({
          ...decision,
          hypotheses: [{ query: "publicProcess", explanation }],
        }),
        toolCalls: [],
      });
    const model = new FakeLanguageModel([
      response("First hypothesis"),
      response("Same hypothesis rewritten"),
    ]);
    const result = await new IssueLocalizationAgent().run({
      ...base,
      source,
      model,
      maxTokens: 18000,
      retrieve: search,
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(result.metrics.meaningfulProgress).toBe(1);
    expect(result.metrics.modelCalls).toBe(2);
  });

  it("does not count narrower rereads of already observed source as new progress", async () => {
    const { source } = fixture();
    const pack = await new IssueLocalizer().retrieve({
      ...base,
      accessScope: "test",
      runId: "r",
      workspaceRevision: 0,
      source,
      description: base.title,
    });
    const inspect = (startLine: number) =>
      fakeModelResponse({
        text: JSON.stringify({
          ...decision,
          inspect: [
            {
              path: "src/critical.ts",
              startLine,
              endLine: startLine + 4,
              reason: "Check the same implementation",
            },
          ],
        }),
        toolCalls: [],
      });
    const model = new FakeLanguageModel([
      inspect(1),
      inspect(2),
      fakeModelResponse({ text: JSON.stringify(decision), toolCalls: [] }),
    ]);
    const result = await new IssueLocalizationAgent().run({
      ...base,
      source,
      evidence: pack,
      model,
      maxTokens: 18000,
      retrieve: async () => undefined,
    });
    expect(result.metrics.meaningfulProgress).toBe(0);
    expect(result.metrics.sourceReads).toBe(1);
    expect(result.metrics.modelCalls).toBe(2);
    expect(result.evidenceState?.exitReason).toBe("STALLED");
  });
});
