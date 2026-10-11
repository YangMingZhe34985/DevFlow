import { describe, expect, it, vi } from "vitest";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import { DevflowError } from "@devflow/shared";
import { IssueLocalizationAgent } from "../src/localization/issue-localization-agent.js";
import { hash, type IndexSource } from "../src/localization/contracts.js";
import type { LocalizationInvestigationState } from "../src/localization/investigation-state.js";

const signal = new AbortController().signal;
const decision = (inspect: unknown[] = []) =>
  fakeModelResponse({
    text: JSON.stringify({
      summary: "Investigate behavior",
      hypotheses: [],
      inspect,
      candidates: [],
      uncertainty: [],
    }),
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  });
const read = (i: number) => ({
  path: `src/f${i}.ts`,
  startLine: 1,
  endLine: 1,
  reason: "Check a distinct behavior implementation",
});
function setup() {
  const files = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`src/f${i}.ts`, `export const f${i} = ${i};`]),
  );
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    kind: "FILE" as const,
    contentHash: hash(content),
    sizeBytes: content.length,
  }));
  const source: IndexSource = {
    identity: hash(JSON.stringify(entries)),
    manifest: async () => ({ entries, incomplete: false }),
    lookup: async (p) => entries.find((e) => e.path === p),
    read: vi.fn(async (p) => ({ content: files[p]!, truncated: false })),
  };
  return {
    title: "Behavior",
    description: "Cross-layer behavior differs",
    repositoryId: "repo",
    baseCommitSha: "a".repeat(40),
    source,
    signal,
    maxTokens: 150000,
    maxOutputTokens: 4096,
    contextTokens: 64000,
    mode: "legacy-dynamic" as const,
    maxModelCalls: 25,
    retrieve: async () => undefined,
  };
}
describe("dynamic localization investigation", () => {
  it("can exceed four requests while receiving fresh source, without increasing output caps", async () => {
    const input = setup();
    const model = new FakeLanguageModel([
      ...Array.from({ length: 5 }, (_, i) => decision([read(i)])),
      decision(),
    ]);
    const result = await new IssueLocalizationAgent().run({ ...input, model });
    expect(result.metrics.modelCalls).toBe(6);
    expect(result.metrics.reads).toBe(5);
    expect(result.observedEvidence).toHaveLength(5);
    expect(model.requests.every((r) => r.settings?.maxOutputTokens === 4096)).toBe(true);
  });
  it("stops an entirely repeated request immediately without a paid summary", async () => {
    const model = new FakeLanguageModel([decision([read(0)]), decision([read(0)])]);
    const result = await new IssueLocalizationAgent().run({ ...setup(), model });
    expect(result.metrics).toMatchObject({ modelCalls: 2, reads: 1, finalReason: "STALLED" });
  });
  it("stops after two different searches add no evidence", async () => {
    const model = new FakeLanguageModel(
      ["first", "reworded"].map((query) =>
        fakeModelResponse({
          text: JSON.stringify({
            summary: "Investigate",
            hypotheses: [{ query, explanation: query }],
            inspect: [],
            candidates: [],
            uncertainty: [],
          }),
          toolCalls: [],
        }),
      ),
    );
    const result = await new IssueLocalizationAgent().run({ ...setup(), model });
    expect(result.metrics.finalReason).toBe("STALLED");
    expect(model.requests).toHaveLength(2);
  });
  it("resumes a safe evidence boundary with original consumption and source cache", async () => {
    const input = setup();
    let saved: LocalizationInvestigationState | undefined;
    await expect(
      new IssueLocalizationAgent().run({
        ...input,
        model: new FakeLanguageModel([decision([read(0)])]),
        onCheckpoint: async (s) => {
          if (s.status === "EVIDENCE") {
            saved = s.investigation as LocalizationInvestigationState;
            throw new Error("simulated process interruption");
          }
        },
      }),
    ).rejects.toThrow("simulated");
    expect(saved?.metrics).toMatchObject({ modelCalls: 1, reads: 1, totalTokens: 150 });
    const result = await new IssueLocalizationAgent().run({
      ...input,
      resume: saved!,
      model: new FakeLanguageModel([decision([read(1)]), decision()]),
    });
    expect(result.metrics).toMatchObject({ modelCalls: 3, reads: 2, totalTokens: 450 });
    expect(result.observedEvidence).toHaveLength(2);
    expect(input.source.read).toHaveBeenCalledTimes(2);
  });
  it("retains unknown dispatch reservations and never sends a replacement request", async () => {
    const input = setup();
    let saved: LocalizationInvestigationState | undefined;
    await expect(
      new IssueLocalizationAgent().run({
        ...input,
        model: new FakeLanguageModel([decision()]),
        onCheckpoint: async (s) => {
          if (s.status === "DISPATCH_RESERVED") {
            saved = s.investigation as LocalizationInvestigationState;
            throw new Error("crash");
          }
        },
      }),
    ).rejects.toThrow("crash");
    const model = new FakeLanguageModel([decision()]);
    await expect(
      new IssueLocalizationAgent().run({ ...input, resume: saved!, model }),
    ).rejects.toMatchObject({
      details: { requestIssued: false, stopReason: "LOCALIZATION_RESUME_UNCERTAIN" },
    });
    expect(model.requests).toHaveLength(0);
  });
  it("does not issue evidence IO when follow-up admission fails", async () => {
    const input = setup();
    await expect(
      new IssueLocalizationAgent().run({
        ...input,
        model: new FakeLanguageModel([decision([read(0)])]),
        beforeEvidence: async () => {
          throw new Error("insufficient downstream capacity");
        },
      }),
    ).rejects.toThrow("downstream");
    expect(input.source.read).not.toHaveBeenCalled();
  });
  it("saves a known budget stop and its pending hypothesis without issuing IO or a summary", async () => {
    const input = setup();
    const checkpoints: Record<string, unknown>[] = [];
    const model = new FakeLanguageModel([decision([read(0)])]);
    const result = await new IssueLocalizationAgent().run({
      ...input,
      model,
      onCheckpoint: async (state) => {
        checkpoints.push(state);
      },
      beforeEvidence: async () => {
        throw new DevflowError({
          code: "EXECUTION_BUDGET_EXCEEDED",
          message: "Required next decision does not fit.",
          details: { requestIssued: false },
        });
      },
    });
    expect(result.metrics.finalReason).toBe("INSUFFICIENT_EVIDENCE");
    expect(model.requests).toHaveLength(1);
    expect(input.source.read).not.toHaveBeenCalled();
    expect(checkpoints.at(-1)?.investigation).toMatchObject({
      phase: "STOPPED",
      metrics: { modelCalls: 1 },
    });
  });
});
