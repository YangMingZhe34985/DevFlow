import { describe, expect, it } from "vitest";
import { hash, type IndexEntry, type IndexSource } from "../src/localization/contracts.js";
import { RepositoryRelationGraph } from "../src/localization/relation-graph.js";
import {
  queryRepositoryRelations,
  resolveRelationPaths,
} from "../src/localization/relation-query.js";

const base = { repositoryId: "relation-query", baseCommitSha: "a".repeat(40) };
function fixture(files: Record<string, string>, incomplete = false, extra: IndexEntry[] = []) {
  const reads: string[] = [];
  let manifests = 0;
  const entries: IndexEntry[] = [
    ...Object.entries(files).map(([path, content]) => ({
      path,
      kind: "FILE" as const,
      sizeBytes: Buffer.byteLength(content),
      contentHash: hash(content),
    })),
    ...extra,
  ];
  const source: IndexSource = {
    manifest: async () => {
      manifests++;
      return { entries, incomplete };
    },
    read: async (path) => {
      reads.push(path);
      if (!(path in files)) throw new Error(`Missing ${path}`);
      return { content: files[path]!, truncated: false };
    },
  };
  const graph = new RepositoryRelationGraph({ ...base, source });
  const query = (paths: string[], symbols?: string[]) =>
    queryRepositoryRelations({
      repositoryId: base.repositoryId,
      source,
      graph,
      paths,
      ...(symbols ? { symbols } : {}),
      description: "Preserve the public operation behavior",
      signal: AbortSignal.timeout(30_000),
    });
  return { source, graph, reads, entries, query, manifests: () => manifests };
}

describe("bounded directory relation queries", () => {
  it("uses observed symbol definitions before alphabetical unrelated files and does not pre-read the selected files", async () => {
    const files = {
      "src/operations/a-unrelated.ts": "export function unrelated() { return 0; }",
      "src/operations/z-normalize.ts":
        "export function normalize(value: string) { return value.trim(); }",
      "src/operations/run.ts":
        "import { normalize } from './z-normalize.js';\nexport function run(value: string) { return normalize(value); }",
      "src/elsewhere/normalize.ts": "export function normalize(value: string) { return value; }",
      "eslint.config.js": "export default [];",
    };
    const f = fixture(files);
    for (const path of ["src/operations/z-normalize.ts", "src/operations/run.ts"])
      await f.graph.observe(path, files[path as keyof typeof files], AbortSignal.timeout(30_000));
    const result = await f.query(["src/operations/"], ["normalize"]);
    expect(result.pathResolution[0]).toMatchObject({
      kind: "DIRECTORY",
      source: "MANIFEST_DESCENDANTS",
      candidateCount: 3,
    });
    expect(result.actualScope.resolvedSeeds[0]).toBe("src/operations/z-normalize.ts");
    expect(
      result.implementationEvidence.some(
        (window) =>
          window.path === "src/operations/z-normalize.ts" &&
          window.snippet.includes("value.trim()"),
      ),
    ).toBe(true);
    expect(
      result.relations.some(
        (relation) =>
          relation.from === "src/operations/run.ts" &&
          relation.to === "src/operations/z-normalize.ts",
      ),
    ).toBe(true);
    expect(f.reads.every((path) => path.startsWith("src/operations/"))).toBe(true);
    expect(new Set(f.reads).size).toBe(f.reads.length);
    expect(f.reads.length).toBeLessThanOrEqual(4);
    expect(f.manifests()).toBe(1);
    expect(result.actualScope.readPaths).toEqual(f.reads);
  });

  it("stays inside a directory when no symbol is observed, without guessing a whole-repository fallback", async () => {
    const f = fixture({
      "src/module/a.ts": "export const other = 1;",
      "src/module/b.ts": "export const another = 2;",
      "src/unrelated/wanted.ts": "export function wanted() { return 3; }",
      "tests/regression/wanted.test.ts": "expect(wanted()).toBe(4);",
    });
    const result = await f.query(["src/module"], ["wanted"]);
    expect(f.reads).toEqual(["src/module/a.ts", "src/module/b.ts"]);
    expect(result.observations.join(" ")).toContain("source candidates");
    expect(result.missingInformation.join(" ")).toContain("Implementation not observed for wanted");
    expect(result.relatedTests).toEqual([]);
  });

  it.each([false, true])(
    "distinguishes missing paths from incomplete-manifest unknown paths (%s)",
    async (incomplete) => {
      const f = fixture({ "src/existing.ts": "export const value = 1;" }, incomplete);
      const result = await f.query(["src/missing"], ["value"]);
      expect(result.pathResolution[0]?.kind).toBe(incomplete ? "UNKNOWN" : "MISSING");
      expect(result.actualScope.resolvedSeeds).toEqual([]);
      expect(result.implementationEvidence).toEqual([]);
      expect(result.observations.join(" ")).toContain("no repository-wide fallback");
      expect(f.reads).toEqual([]);
    },
  );

  it("keeps manifest failures unknown without probing arbitrary source paths", async () => {
    const f = fixture({ "src/file.ts": "export const value = 1;" });
    f.source.manifest = async () => {
      throw new Error("permission denied");
    };
    const result = await f.query(["src"], ["value"]);
    expect(result.pathResolution[0]?.kind).toBe("UNKNOWN");
    expect(f.reads).toEqual([]);
  });

  it("recognizes explicit empty directories and refuses unsafe/symlink paths", async () => {
    const f = fixture({}, false, [
      { path: "src/empty", kind: "DIRECTORY", sizeBytes: 0 },
      { path: "src/link", kind: "SYMLINK", sizeBytes: 0 },
    ]);
    const result = await f.query(["src/empty", "../private", ".env", "src/link"], ["value"]);
    expect(result.pathResolution.map((row) => row.kind)).toEqual([
      "DIRECTORY",
      "REJECTED",
      "REJECTED",
      "MISSING",
    ]);
    expect(f.reads).toEqual([]);
  });

  it("reports symbol ambiguity and applies one shared four-seed bound", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [
        `src/module/${index}.ts`,
        `export function same() { return ${index}; }`,
      ]),
    );
    const f = fixture(files, true);
    for (const [path, content] of Object.entries(files))
      await f.graph.observe(path, content, AbortSignal.timeout(30_000));
    const resolved = resolveRelationPaths({
      paths: ["src/module", "src/module/6.ts"],
      symbols: ["same"],
      manifest: { entries: f.entries, incomplete: true },
      graph: f.graph.snapshot(),
    });
    expect(resolved.seeds).toHaveLength(4);
    expect(resolved.pathResolution[0]).toMatchObject({
      manifestIncomplete: true,
      omittedCandidates: 3,
      ambiguousSymbols: ["same"],
    });
    expect(resolved.observations.join(" ")).toContain("do not infer one unique definition");
  });

  it("can follow an observed barrel/alias beyond the directory without reading unrelated peers or looping", async () => {
    const f = fixture({
      "src/public/index.ts": "export { compute as publicCompute } from '../internal/compute.js';",
      "src/internal/compute.ts":
        "import { publicCompute } from '../public/index.js';\nexport function compute(value: number) { return value + 1; }",
      "src/internal/unrelated.ts": "export const unused = 0;",
    });
    const result = await f.query(["src/public"], ["publicCompute"]);
    expect(
      result.implementationEvidence.some(
        (window) =>
          window.path === "src/internal/compute.ts" && window.snippet.includes("value + 1"),
      ),
    ).toBe(true);
    expect(f.reads).toEqual(["src/public/index.ts", "src/internal/compute.ts"]);
    expect(result.actualScope.resolvedSeeds).toEqual(["src/public/index.ts"]);
    expect(result.actualScope.evidencePaths).toContain("src/internal/compute.ts");
  });

  it("returns no unrelated whole-graph edges and exposes file-only queries' physical reads", async () => {
    const files = {
      "src/one/a.ts": "import { b } from './b.js'; export const a = b;",
      "src/one/b.ts": "export const b = 1;",
      "src/two/c.ts": "import { d } from './d.js'; export const c = d;",
      "src/two/d.ts": "export const d = 2;",
    };
    const f = fixture(files);
    await f.graph.observe("src/two/c.ts", files["src/two/c.ts"], AbortSignal.timeout(30_000));
    const result = await f.query(["src/one"]);
    expect(result.actualScope.readPaths).toEqual(["src/one/a.ts", "src/one/b.ts"]);
    expect(result.relations.every((relation) => relation.from.startsWith("src/one/"))).toBe(true);
    expect(result.files.every((file) => file.path.startsWith("src/one/"))).toBe(true);
  });

  it("enforces total source bytes and preserves a source-budget explanation", async () => {
    const f = fixture({ "src/large/a.ts": "a".repeat(600 * 1024) });
    const result = await f.query(["src/large"]);
    expect(f.reads).toEqual([]);
    expect(result.observations.join(" ")).toContain("SOURCE_BUDGET");
  });

  it("counts failed physical reads against the same four-read allowance", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `src/module/${index}.ts`,
        "export const value = 1;",
      ]),
    );
    const f = fixture(files);
    const attempted: string[] = [];
    f.source.read = async (path) => {
      attempted.push(path);
      throw new Error("source unavailable");
    };
    const result = await f.query(["src/module"], ["value"]);
    expect(attempted).toHaveLength(4);
    expect(result.navigationMetrics?.reads).toBe(4);
    expect(result.actualScope.readPaths).toEqual(attempted);
    expect(result.navigationMetrics?.exitReason).toBe("SOURCE_BUDGET");
  });

  it("keeps output within the total response budget without partial records", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => [
        `src/${"long".repeat(180)}/${index}.ts`,
        `export function same() { return '${"x".repeat(900)}'; }`,
      ]),
    );
    const f = fixture(files);
    const result = await f.query(Object.keys(files), ["same"]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
    expect(result.outputTruncated).toBe(true);
    expect(result.observations.join(" ")).toContain("OUTPUT_BUDGET");
    expect(result.actualScope.evidencePaths).toEqual([
      ...new Set(result.implementationEvidence.map((window) => window.path)),
    ]);
  });
});
