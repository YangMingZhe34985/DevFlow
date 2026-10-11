import { describe, expect, it, vi } from "vitest";
import { BehaviorRetriever } from "../src/localization/behavior-retriever.js";
import { buildRepositoryAtlas } from "../src/localization/repository-atlas.js";
import { hash, type EvidencePack, type IndexSource } from "../src/localization/contracts.js";

const signal = new AbortController().signal;
describe("PRG progressive content retrieval", () => {
  it("retains the full frontier and searches acquired content again without physical rereads", async () => {
    const content =
      "export const first = 'alpha';\n" +
      "// background\n".repeat(90) +
      "export const second = 'omega';\n";
    const source: IndexSource = {
      identity: "a".repeat(64),
      manifest: async () => ({
        entries: [
          {
            path: "src/renamed.ts",
            kind: "FILE",
            sizeBytes: Buffer.byteLength(content),
            contentHash: hash(content),
          },
        ],
        incomplete: false,
      }),
      read: vi.fn(async () => ({ content, truncated: false })),
    };
    const atlas = await buildRepositoryAtlas({ source, scope: "fixture", signal });
    const retriever = new BehaviorRetriever(atlas, "alpha");
    const input = {
      source,
      signal,
      template: { metrics: {} } as EvidencePack,
      repositoryId: "repo",
      baseCommitSha: "b".repeat(40),
    };
    const first = await retriever.retrieve({ ...input, query: "alpha" });
    const second = await retriever.retrieve({ ...input, query: "omega" });
    expect(first.evidence[0]?.snippet).toContain("alpha");
    expect(second.evidence[0]?.snippet).toContain("omega");
    expect(second.evidence[0]?.startLine).toBeGreaterThan(1);
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(second.metrics).toMatchObject({ filesInspected: 0, cacheHits: 1 });
    const restored = new BehaviorRetriever(atlas, "omega", retriever.frontier(), [
      ["src/renamed.ts", { content, truncated: false }],
    ]);
    expect((await restored.retrieve({ ...input, query: "omega" })).evidence[0]?.snippet).toContain(
      "omega",
    );
    expect(source.read).toHaveBeenCalledTimes(1);
    const unavailable = new BehaviorRetriever(atlas, "omega", retriever.frontier());
    expect(unavailable.frontier()[0]?.status).toBe("HYPOTHESIS");
  });
});
