import { describe, expect, it } from "vitest";
import type { RepositoryIndexStore } from "@devflow/database";
import type { IndexSource } from "../src/localization/contracts.js";
import { extractIssueSignals, hash, sourceRole, tokens } from "../src/localization/contracts.js";
import { IssueLocalizer } from "../src/localization/retrieval.js";

// Keep fixtures local: importing another .test module registers its suites again.
class MemoryIndexStore implements RepositoryIndexStore {
  readonly entries = new Map<string, unknown>();
  async get(scope: string, key: string) {
    return this.entries.get(`${scope}:${key}`);
  }
  async publish(scope: string, key: string, value: unknown) {
    const id = `${scope}:${key}`;
    if (!this.entries.has(id)) this.entries.set(id, structuredClone(value));
  }
}

const request = {
  repositoryId: "recall",
  accessScope: "test",
  baseCommitSha: "a".repeat(40),
  runId: "r",
  workspaceRevision: 0,
  signal: new AbortController().signal,
};
function sourceFor(files: Map<string, string>) {
  const entries = [...files].map(([path, content]) => ({
    path,
    kind: "FILE" as const,
    contentHash: hash(content),
    sizeBytes: Buffer.byteLength(content),
  }));
  const reads: string[] = [];
  const source: IndexSource = {
    identity: hash(JSON.stringify(entries)),
    fileCount: entries.length,
    manifest: async () => ({ entries, incomplete: false }),
    lookup: async (path) => entries.find((e) => e.path === path),
    read: async (path) => {
      reads.push(path);
      return { content: files.get(path)!, truncated: false };
    },
  };
  return { source, reads };
}

describe("query-directed implementation recall", () => {
  it("separates filenames, public members, local reproduction names and versions", () => {
    const signals = extractIssueSignals(
      "version 4.3.6: const DemoSchema = z.toJSONSchema(z.lazy(() => z.enum(['x']))); DemoSchema.parse(input); src/convert.ts:42:3 `toJSONSchema`",
    );
    expect(signals.paths).toEqual(["src/convert.ts"]);
    expect(signals.stackFrames).toEqual([{ path: "src/convert.ts", line: 42 }]);
    expect(signals.symbols).toEqual(expect.arrayContaining(["toJSONSchema", "lazy", "enum"]));
    expect(signals.symbols).not.toContain("DemoSchema");
    expect(signals.exampleLocals).toContain("DemoSchema");
    expect(signals.versionHints).toEqual(["v4"]);
    expect(tokens(Array.from({ length: 150 }, (_, i) => `word${i}`).join(" "), 128)).toHaveLength(
      128,
    );
  });

  it("reaches a definition outside a partial content index and a different warm query", async () => {
    const files = new Map([
      ["src/aaa.ts", "export function unrelated() { return 0; }"],
      ["src/render-document.ts", "export function renderDocument() { return 'broken'; }"],
      ["bench/render-document.ts", "const renderDocument = 'benchmark setup';"],
      ...Array.from(
        { length: 80 },
        (_, i) => [`test/filler${i}.test.ts`, `const value${i} = 1;`] as const,
      ),
    ]);
    const { source } = sourceFor(files),
      store = new MemoryIndexStore();
    const localizer = new IssueLocalizer(store, { indexContentFiles: 1, targetedSearchFiles: 4 });
    await localizer.retrieve({ ...request, source, description: "unrelated()" });
    const pack = await localizer.retrieve({
      ...request,
      source: {
        ...source,
        manifest: async () => {
          throw Error("warm catalogue should be reused");
        },
      },
      description: "api.renderDocument() returns the wrong document",
    });
    expect(pack.metrics.manifestEntriesVisited).toBe(0);
    expect(pack.metrics.targetedSearchFiles).toBeGreaterThan(0);
    expect(pack.evidence[0]).toMatchObject({
      path: "src/render-document.ts",
      symbol: "renderDocument",
    });
    expect(pack.evidence[0]?.snippet).toContain("return 'broken'");
    expect(pack.incomplete).toBe(true);
  });

  it("retains tests as navigation evidence while preferring current-version implementation over benchmarks", async () => {
    const files = new Map([
      ["bench/convert.ts", "const convertValue = () => 'benchmark';"],
      ["packages/lib/v3/convert.ts", "export function convertValue() { return 'old'; }"],
      ["packages/lib/v4/convert.ts", "export function convertValue() { return 'current'; }"],
      ["packages/lib/v4/tests/convert.test.ts", "convertValue(); // current behavior"],
    ]);
    const { source } = sourceFor(files);
    const pack = await new IssueLocalizer().retrieve({
      ...request,
      source,
      description: "v4 api.convertValue() has the wrong behavior",
    });
    expect(pack.evidence[0]?.path).toBe("packages/lib/v4/convert.ts");
    expect(pack.evidence.map((e) => e.path)).toContain("packages/lib/v4/tests/convert.test.ts");
    expect(sourceRole("benchmarks/setup.ts")).toBe("BENCHMARK");
  });
});
