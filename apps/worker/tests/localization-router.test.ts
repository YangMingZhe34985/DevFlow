import { describe, expect, it } from "vitest";
import type { RepositoryIndexStore } from "@devflow/database";
import { hash, type IndexSource } from "../src/localization/contracts.js";
import { IssueLocalizer } from "../src/localization/retrieval.js";
import { topK } from "../src/localization/query-index.js";
import { validateSnapshotIntegrity } from "@devflow/sandbox";

const request = {
  repositoryId: "router",
  accessScope: "scope",
  baseCommitSha: "a".repeat(40),
  runId: "r1",
  workspaceRevision: 0,
  signal: new AbortController().signal,
};
function fixture(count: number) {
  const files = new Map(
    Array.from({ length: count }, (_, i) => [
      `src/file${i}.ts`,
      `export function action${i}() { return ${i}; }\n`,
    ]),
  );
  const entries = [...files].map(([path, content]) => ({
    path,
    contentHash: hash(content),
    sizeBytes: Buffer.byteLength(content),
    kind: "FILE" as const,
  }));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  let manifests = 0;
  const source: IndexSource = {
    identity: hash(JSON.stringify(entries)),
    fileCount: entries.length,
    async lookup(path) {
      return byPath.get(path);
    },
    async manifest() {
      manifests++;
      return { entries, incomplete: false };
    },
    async read(path) {
      const content = files.get(path);
      if (!content) throw new Error("Missing");
      return { content, truncated: false };
    },
  };
  const cache = new Map<string, unknown>();
  const store: RepositoryIndexStore = {
    async get(scope, key) {
      return cache.get(scope + key);
    },
    async publish(scope, key, value) {
      if (!cache.has(scope + key)) cache.set(scope + key, value);
    },
  };
  return { files, source, store, manifests: () => manifests };
}

describe("adaptive retrieval router", () => {
  it("computes legacy snapshot identity at validation and rejects a forged identity", () => {
    const content = "export const value = 1;";
    const snapshot = {
      version: 1 as const,
      sourceHead: "a".repeat(40),
      totalBytes: content.length,
      files: [
        {
          kind: "FILE" as const,
          path: "a.ts",
          mode: 0o644,
          sizeBytes: content.length,
          sha256: hash(content),
          contentBase64: Buffer.from(content).toString("base64"),
        },
      ],
    };
    const checked = validateSnapshotIntegrity(snapshot);
    expect(checked.manifestHash).toHaveLength(64);
    expect(validateSnapshotIntegrity(checked).manifestHash).toBe(checked.manifestHash);
    expect(() =>
      validateSnapshotIntegrity({ ...snapshot, manifestHash: "0".repeat(64) }),
    ).toThrow();
  });
  it("recovers postings after a transient source read without reusing partial publication buckets", async () => {
    const f = fixture(1000);
    let fail = true;
    const source = {
      ...f.source,
      async read(path: string, signal: AbortSignal) {
        if (fail && path === "src/file0.ts") {
          fail = false;
          throw new Error("temporary read failure");
        }
        return f.source.read(path, signal);
      },
    };
    await new IssueLocalizer(f.store).retrieve({ ...request, source, description: "file999" });
    const recovered = await new IssueLocalizer(f.store).retrieve({
      ...request,
      source,
      description: "action0()",
    });
    expect(recovered.evidence.map((item) => item.path)).toContain("src/file0.ts");
    expect(f.manifests()).toBe(2);
    await new IssueLocalizer(f.store).retrieve({ ...request, source, description: "action0()" });
    expect(f.manifests()).toBe(2);
  });
  it("short-circuits a 50k exact path without manifest, global ranking or unrelated evidence", async () => {
    const f = fixture(50_000);
    const first = await new IssueLocalizer(f.store).retrieve({
      ...request,
      source: f.source,
      description: "Fix src/file49999.ts action49999()",
    });
    const warm = await new IssueLocalizer(f.store).retrieve({
      ...request,
      runId: "r2",
      source: f.source,
      description: "Fix src/file49999.ts action49999()",
    });
    expect(first.route).toBe("FAST_PATH");
    expect(first.evidenceSufficient).toBe(true);
    expect(first.evidence.map((item) => item.path)).toEqual(["src/file49999.ts"]);
    expect(first.metrics.manifestEntriesVisited).toBe(0);
    expect(first.metrics.postingsVisited).toBe(0);
    expect(first.metrics.filesInspected).toBe(1);
    expect(first.metrics.readBytes).toBeLessThan(256);
    expect(warm.metrics.parsedFiles).toBe(0);
    expect(f.manifests()).toBe(0);
  }, 15_000);

  it("uses small direct search, then persisted postings across instances without a warm manifest/hash pass", async () => {
    const small = fixture(12);
    expect(
      (
        await new IssueLocalizer(small.store).retrieve({
          ...request,
          source: small.source,
          description: "action2()",
        })
      ).route,
    ).toBe("DIRECT_SEARCH");
    const f = fixture(1000);
    const first = await new IssueLocalizer(f.store).retrieve({
      ...request,
      source: f.source,
      description: "file999",
    });
    expect(first.route).toBe("INDEXED_SEARCH");
    expect(first.evidence.map((item) => item.path)).toContain("src/file999.ts");
    expect(f.manifests()).toBe(1);
    const warm = await new IssueLocalizer(f.store).retrieve({
      ...request,
      runId: "another-run",
      source: {
        ...f.source,
        manifest: async () => {
          throw new Error("Warm query enumerated repository");
        },
      },
      description: "file999",
    });
    expect(warm.metrics.manifestEntriesVisited).toBe(0);
    expect(warm.metrics.postingsVisited).toBeLessThanOrEqual(120);
    expect(warm.metrics.parsedFiles).toBe(0);
    expect(warm.evidence.map((item) => item.path)).toContain("src/file999.ts");
  });

  it("filters tombstones and recalls new overlay content without rebuilding base postings", async () => {
    const f = fixture(1000),
      localizer = new IssueLocalizer(f.store);
    await localizer.retrieve({ ...request, source: f.source, description: "file2" });
    const newContent = "export function newlyAdded() { return 42; }";
    const added = {
      path: "new.ts",
      sizeBytes: newContent.length,
      contentHash: hash(newContent),
      kind: "FILE" as const,
    };
    const source: IndexSource = {
      ...f.source,
      base: f.source,
      async changes() {
        return { entries: [added], deleted: ["src/file2.ts"], incomplete: false };
      },
      async lookup(path, signal) {
        return path === "src/file2.ts"
          ? undefined
          : path === "new.ts"
            ? added
            : f.source.lookup!(path, signal);
      },
      async read(path, signal) {
        if (path === "src/file2.ts") throw new Error("deleted");
        return path === "new.ts"
          ? { content: newContent, truncated: false }
          : f.source.read(path, signal);
      },
    };
    const pack = await localizer.retrieve({
      ...request,
      workspaceRevision: 1,
      source,
      description: "newlyAdded() file2",
    });
    expect(pack.evidence.map((item) => item.path)).toContain("new.ts");
    expect(pack.evidence.map((item) => item.path)).not.toContain("src/file2.ts");
    expect(pack.metrics.manifestEntriesVisited).toBe(0);
    expect(f.manifests()).toBe(1);
  });

  it("keeps deterministic bounded Top-K independent of candidate arrival order", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ path: `p${i}`, score: i % 7 }));
    expect(topK(rows, 40)).toEqual(topK(rows.reverse(), 40));
    expect(topK(rows, 40)).toHaveLength(40);
  });
  it("verifies a unique indexed symbol against current syntax before fast routing", async () => {
    const f = fixture(1000);
    const first = await new IssueLocalizer(f.store).retrieve({
      ...request,
      source: f.source,
      description: "action12()",
    });
    expect(first.route).toBe("FAST_PATH");
    expect(first.evidence.map((item) => item.path)).toEqual(["src/file12.ts"]);
    expect(first.evidence[0]!.symbol).toBe("action12");
    const warm = await new IssueLocalizer(f.store).retrieve({
      ...request,
      source: f.source,
      description: "action12()",
    });
    expect(warm.metrics.manifestEntriesVisited).toBe(0);
    expect(warm.metrics.parsedFiles).toBe(0);
  });
});
