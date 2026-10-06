import { describe, expect, it } from "vitest";
import { hash, type IndexSource } from "../src/localization/contracts.js";
import {
  collectReviewSupplement,
  reviewSupplementRequests,
  remainingReviewSupplement,
} from "../src/runs/review-supplement.js";
function fixture(files: Record<string, string>) {
  const reads: string[] = [];
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    sizeBytes: Buffer.byteLength(content),
    contentHash: hash(content),
    kind: "FILE" as const,
  }));
  const source: IndexSource = {
    manifest: async () => ({ entries, incomplete: false }),
    read: async (path) => {
      reads.push(path);
      return { content: files[path]!, truncated: false };
    },
  };
  return { source, reads };
}
const base = {
  repositoryId: "review",
  baseCommitSha: "a".repeat(40),
  workspaceRevision: 3,
  plan: { summary: "Fix", steps: [] },
  signal: new AbortController().signal,
};
describe("one shared host Review supplement", () => {
  it("shares baseline/current reads, caches unchanged views, and invalidates current cache after Repair", async () => {
    const f = fixture({ "impl.ts": "export function convert() { return 2; }" });
    const baseline = fixture({ "impl.ts": "export function convert() { return 1; }" });
    const first = await collectReviewSupplement({
      ...base,
      source: f.source,
      baselineSource: baseline.source,
      requests: [
        { path: "impl.ts", view: "BASELINE", question: "Old implementation" },
        { path: "impl.ts", question: "Current implementation" },
      ],
    });
    expect(first.supplement?.reads).toBe(2);
    expect(first.sources.some((s) => s.view === "BASELINE" && s.content.includes("return 1"))).toBe(
      true,
    );
    const limits = remainingReviewSupplement({
      rounds: 1,
      reads: 2,
      sourceBytes: first.supplement!.sourceBytes,
      snippetBytes: first.supplement!.snippetBytes,
    });
    const second = await collectReviewSupplement({
      ...base,
      source: f.source,
      baselineSource: baseline.source,
      limits,
      cacheEntries: first.cacheEntries,
      requests: [{ path: "impl.ts", question: "Current again" }],
    });
    expect(second.supplement?.reads).toBe(0);
    const third = await collectReviewSupplement({
      ...base,
      workspaceRevision: 4,
      source: f.source,
      limits,
      cacheEntries: second.cacheEntries,
      requests: [{ path: "impl.ts", question: "After Repair" }],
    });
    expect(third.supplement?.reads).toBe(1);
  });
  it("derives optional requests from gaps and resolves public test filenames within the approved module", async () => {
    const requests = reviewSupplementRequests({
      approved: false,
      decision: "NEEDS_EVIDENCE",
      summary: "Need coverage",
      findings: [
        {
          kind: "EVIDENCE_GAP",
          severity: "WARNING",
          path: "v4/core/checks.ts",
          message: "Read number.test.ts to check multipleOf behavior",
        },
      ],
    });
    expect(requests.map((r) => r.path)).toEqual(["v4/core/checks.ts", "number.test.ts"]);
    const f = fixture({
      "v4/core/checks.ts": "export function multipleOf(n: number) { return n % 3 === 0; }",
      "v4/tests/number.test.ts":
        "// padding\n".repeat(150) + "test('multipleOf', () => multipleOf(3));",
      "v3/tests/number.test.ts": "// Older module",
    });
    const result = await collectReviewSupplement({
      ...base,
      plan: {
        ...base.plan,
        approvalScope: {
          version: "plan-approval-scope-v1",
          mode: "READY",
          baseCommitSha: base.baseCommitSha,
          workspaceRevision: 0,
          files: [{ path: "v4/core/checks.ts", operation: "MODIFY" }],
        },
      },
      source: f.source,
      requests,
    });
    expect(f.reads).toContain("v4/tests/number.test.ts");
    expect(f.reads).not.toContain("v3/tests/number.test.ts");
    expect(result.sources).toContainEqual(
      expect.objectContaining({
        path: "v4/tests/number.test.ts",
        content: expect.stringContaining("multipleOf(3)"),
      }),
    );
  });
  it("follows a public API to its actual definition with complete current SHA", async () => {
    const f = fixture({
      "src/index.ts": "export { convert as publicConvert } from './impl.js';",
      "src/impl.ts": "export function convert(v: number) { return v / 60; }",
    });
    const result = await collectReviewSupplement({
      ...base,
      source: f.source,
      requests: [
        { path: "src/index.ts", symbol: "publicConvert", question: "Verify supported units" },
      ],
    });
    expect(result.sources).toContainEqual(
      expect.objectContaining({
        path: "src/impl.ts",
        fileSha256: hash("export function convert(v: number) { return v / 60; }"),
      }),
    );
    expect(result.supplement?.reads).toBeLessThanOrEqual(4);
  });
  it("shares reads/bytes/snippets across three requests and metadata", async () => {
    const f = fixture(
      Object.fromEntries(
        [0, 1, 2, 3, 4, 5].map((n) => [
          `src/a${n}.ts`,
          "export function value" + n + "() { return " + n + "; }\n" + "// filler\n".repeat(9000),
        ]),
      ),
    );
    const result = await collectReviewSupplement({
      ...base,
      source: f.source,
      requests: [0, 1, 2].map((n) => ({
        path: `src/a${n}.ts`,
        symbol: `value${n}`,
        question: "Check implementation",
      })),
    });
    expect(f.reads.length).toBeLessThanOrEqual(4);
    expect(result.supplement?.sourceBytes).toBeLessThanOrEqual(512 * 1024);
    expect(result.supplement?.snippetBytes).toBeLessThanOrEqual(16 * 1024);
    expect(new Set(result.sources.map((s) => s.path)).size).toBeGreaterThanOrEqual(3);
  });
  it("keeps protected public tests readable but excludes private paths and symlinks", async () => {
    const f = fixture({
      "tests/public.test.ts": "test('supported units', () => check(60));",
      "hidden-acceptance/secret.ts": "private answer",
      ".env": "secret",
    });
    const result = await collectReviewSupplement({
      ...base,
      source: f.source,
      requests: [
        { path: "tests/public.test.ts", question: "Does public coverage exist?" },
        { path: ".env", question: "Read secret" },
        { path: "hidden-acceptance/secret.ts", question: "Read oracle" },
      ],
    });
    expect(f.reads).toEqual(["tests/public.test.ts"]);
    expect(result.sources[0]?.content).toContain("supported units");
    expect(result.unavailable.length).toBe(2);
  });
  it("rejects incomplete and stale evidence and records exhausted source budgets", async () => {
    const f = fixture({ "a.ts": "x".repeat(512 * 1024 + 1), "b.ts": "return 1;" });
    const result = await collectReviewSupplement({
      ...base,
      source: f.source,
      requests: [{ path: "a.ts", question: "Inspect oversized code" }],
    });
    expect(f.reads).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.unavailable.join(" ")).toContain("budget");
    f.source.read = async () => ({ content: "return 2;", truncated: false });
    const stale = await collectReviewSupplement({
      ...base,
      source: f.source,
      requests: [{ path: "b.ts", question: "Check current code" }],
    });
    expect(stale.sources).toEqual([]);
    expect(stale.unavailable.join(" ")).toContain("stale");
  });
});
