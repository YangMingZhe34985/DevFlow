import { describe, expect, it, vi } from "vitest";
import { hash, isTestFile, type IndexSource } from "../src/localization/contracts.js";
import {
  RepositoryRelationGraph,
  relationGraphDigest,
} from "../src/localization/relation-graph.js";
const signal = new AbortController().signal;
function source(files: Record<string, string>): IndexSource {
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    kind: "FILE" as const,
    sizeBytes: Buffer.byteLength(content),
    contentHash: hash(content),
  }));
  return {
    identity: "fixed",
    manifest: async () => ({ entries, incomplete: false }),
    lookup: async (p) => entries.find((e) => e.path === p),
    read: vi.fn(async (path) => {
      if (!(path in files)) throw new Error("missing");
      return { content: files[path]!, truncated: false };
    }),
  };
}
const graph = (s: IndexSource) =>
  new RepositoryRelationGraph({ repositoryId: "repo", baseCommitSha: "a".repeat(40), source: s });
describe("versioned repository relations", () => {
  it("resolves captured solution-reference aliases and rejects conflicting referenced targets", async () => {
    const files = {
      "tsconfig.json": JSON.stringify({
        files: [],
        references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.test.json" }],
      }),
      "tsconfig.app.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      "tsconfig.test.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      "tests/check.test.ts": "import { value } from '@/value'; expect(value).toBe(1);",
      "src/value.ts": "export const value = 0;",
      "other/value.ts": "export const value = 2;",
    };
    const g = graph(source(files));
    await g.inspect(["tests/check.test.ts"], signal, false);
    expect(g.snapshot().edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: "src/value.ts", resolution: "RESOLVED" }),
      ]),
    );
    files["tsconfig.test.json"] = JSON.stringify({
      compilerOptions: { paths: { "@/*": ["./other/*"] } },
    });
    const conflict = graph(source(files));
    await conflict.inspect(["tests/check.test.ts"], signal, false);
    expect(conflict.snapshot().edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ to: null, resolution: "UNRESOLVED" })]),
    );
  });
  it("reports AST and partial lexical coverage separately without calling the graph complete", async () => {
    const g = graph(
      source({
        "src/registry.py": "def lookup(name): return name\n",
        "src/Main.java": "class Main {}",
      }),
    );
    await g.inspect(["src/registry.py"], signal);
    expect(g.snapshot().coverage).toMatchObject({
      supportedLanguages: ["TypeScript", "JavaScript", "Python", "Java", "C++"],
      astParsedFiles: 0,
      lexicalParsedFiles: 1,
      unsupportedSourceFiles: 0,
      incomplete: true,
    });
  });
  it("connects declared workspace dependencies to members and keeps registry dependencies external", async () => {
    const g = graph(
      source({
        "package.json": '{"workspaces":{"packages":["packages/*"]}}',
        "packages/app/package.json": JSON.stringify({
          name: "app",
          dependencies: {
            lib: "workspace:*",
            alias: "workspace:@scope/lib@*",
            sibling: "workspace:../lib",
            react: "^19",
            registryLib: "npm:lib@1",
          },
        }),
        "packages/lib/package.json": '{"name":"lib","exports":"./index.ts"}',
        "packages/scoped/package.json": '{"name":"@scope/lib"}',
        "packages/lib/index.ts": "export const value=1;",
        "packages/app/main.ts": 'import {value} from "lib";',
      }),
    );
    await g.inspect(["packages/app/main.ts"], signal);
    const edges = g.snapshot().moduleEdges;
    for (const to of [
      "packages/lib/package.json",
      "packages/scoped/package.json",
      "external:react",
      "external:registryLib",
    ])
      expect(edges).toContainEqual(
        expect.objectContaining({
          from: "packages/app/package.json",
          to,
          kind: "DECLARED_dependencies",
        }),
      );
    expect(
      edges.filter(
        (e) => e.kind === "DECLARED_dependencies" && e.to === "packages/lib/package.json",
      ),
    ).toHaveLength(2);
    expect(edges).not.toContainEqual(expect.objectContaining({ to: "external:lib" }));
    expect(edges).toContainEqual(
      expect.objectContaining({ to: "packages/lib/package.json", kind: "STATIC_IMPORT" }),
    );
  });

  it("does not guess declared workspace targets when excluded, missing or ambiguous", async () => {
    const g = graph(
      source({
        "package.json": "{}",
        "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - '!packages/excluded'\n",
        "packages/app/package.json":
          '{"name":"app","dependencies":{"duplicate":"workspace:*","excluded":"workspace:*","missing":"workspace:*"}}',
        "packages/one/package.json": '{"name":"duplicate"}',
        "packages/two/package.json": '{"name":"duplicate"}',
        "packages/excluded/package.json": '{"name":"excluded"}',
        "packages/app/main.ts": "export const value=1;",
      }),
    );
    await g.inspect(["packages/app/main.ts"], signal);
    const a = g.snapshot();
    expect(a.coverage.incomplete).toBe(true);
    for (const name of ["duplicate", "excluded", "missing"])
      expect(a.moduleEdges).toContainEqual(
        expect.objectContaining({ to: `unresolved:${name}`, kind: "DECLARED_dependencies" }),
      );
    expect(a.coverage.reasons).toContain(
      "Workspace dependency ambiguous: packages/app/package.json -> duplicate",
    );
  });

  it.each([
    ["src/roundToNearestMinutes/test.ts", true],
    ["src/test.cts", true],
    ["src/spec.jsx", true],
    ["src/main.test.ts", true],
    ["src/main.spec.js", true],
    ["src/__tests__/main.ts", true],
    ["src/latest.ts", false],
    ["src/inspector.ts", false],
    ["src/testSupport.ts", false],
  ])("classifies %s as a test only when the path identifies a test (%s)", (path, expected) => {
    expect(isTestFile(path)).toBe(expected);
  });

  it("discovers and indexes an adjacent test.ts for a directory entry point", async () => {
    const g = graph(
      source({
        "src/roundToNearestMinutes/index.ts": "export const roundToNearestMinutes=1;",
        "src/roundToNearestMinutes/test.ts": 'import "./index.js";',
        "src/roundToNearestMinutes/unrelated.test.ts": "export const unrelated=1;",
        "src/unrelated/index.test.ts": "export const unrelated=1;",
      }),
    );
    await g.inspect(["src/roundToNearestMinutes/index.ts"], signal);
    await g.publicTests(["src/roundToNearestMinutes/index.ts"], signal);
    const a = g.snapshot();
    expect(a.files.find((f) => f.path === "src/roundToNearestMinutes/test.ts")).toMatchObject({
      state: "CURRENT",
      fileType: "TEST",
    });
    expect(g.issueView(["src/roundToNearestMinutes/index.ts"]).relatedTests).toContain(
      "src/roundToNearestMinutes/test.ts",
    );
    expect(a.files.some((f) => f.path === "src/roundToNearestMinutes/unrelated.test.ts")).toBe(
      false,
    );
  });

  it("marks file-count clipping even when the full graph and byte budget are complete", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`src/capped${i}.ts`, `export const value${i}=1;`]),
    );
    const g = graph(source(files));
    await g.inspect(Object.keys(files), signal);
    expect(g.snapshot().coverage.incomplete).toBe(false);
    const v = g.issueView(Object.keys(files), [], 100_000);
    expect(v.files).toHaveLength(8);
    expect(v).toMatchObject({ viewTruncated: true, incomplete: true });
  }, 15_000);

  it("marks relation-count clipping independently of the byte budget", async () => {
    const g = graph(
      source({
        "src/imports.ts": Array.from({ length: 21 }, () => 'import "./target.js";').join("\n"),
        "src/target.ts": "export const target=1;",
      }),
    );
    await g.inspect(["src/imports.ts"], signal);
    expect(g.snapshot().coverage.incomplete).toBe(false);
    const v = g.issueView(["src/imports.ts"], [], 100_000);
    expect(v.relations).toHaveLength(20);
    expect(v).toMatchObject({ viewTruncated: true, incomplete: true });
  });

  it("marks symbol/export previews as truncated but preserves a complete requested symbol view", async () => {
    const g = graph(
      source({
        "src/symbols.ts": Array.from({ length: 21 }, (_, i) => `export const item${i}=1;`).join(
          "\n",
        ),
      }),
    );
    await g.inspect(["src/symbols.ts"], signal);
    const preview = g.issueView(["src/symbols.ts"], [], 100_000);
    expect(preview.files[0]?.symbols).toHaveLength(20);
    expect(preview.files[0]?.exports).toHaveLength(20);
    expect(preview).toMatchObject({ viewTruncated: true, incomplete: true });
    const requested = g.issueView(["src/symbols.ts"], [], 100_000, ["item20"]);
    expect(requested.files[0]?.symbols[0]?.name).toBe("item20");
    expect(requested).toMatchObject({ viewTruncated: false, incomplete: false });
  });

  it("marks seed and candidate count limits independently", async () => {
    const g = graph(source({ "src/a.ts": "export const value=1;" }));
    await g.inspect(["src/a.ts"], signal);
    const seeds = g.issueView(
      Array.from({ length: 17 }, (_, i) => `src/seed${i}.ts`),
      [],
      100_000,
    );
    expect(seeds.seeds).toHaveLength(16);
    expect(seeds).toMatchObject({ viewTruncated: true, incomplete: true });
    const candidates = g.issueView(
      [],
      Array.from({ length: 9 }, (_, i) => ({
        path: `src/candidate${i}.ts`,
        explanation: "Candidate only",
      })),
      100_000,
    );
    expect(candidates.candidatePaths).toHaveLength(8);
    expect(candidates).toMatchObject({ viewTruncated: true, incomplete: true });
  });

  it("marks related-test limits independently", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`tests/check${i}.ts`, `export const check${i}=1;`]),
    );
    const g = graph(source(files));
    await g.inspect(Object.keys(files), signal);
    const v = g.issueView([], [], 100_000);
    expect(v.files).toHaveLength(0);
    expect(v.relatedTests).toHaveLength(8);
    expect(v).toMatchObject({ viewTruncated: true, incomplete: true });
  }, 15_000);

  it("preserves a complete small view and marks byte-only clipping", async () => {
    const g = graph(source({ "src/complete.ts": "export const value=1;" }));
    await g.inspect(["src/complete.ts"], signal);
    const full = g.issueView(["src/complete.ts"], [], 100_000);
    expect(full).toMatchObject({ viewTruncated: false, incomplete: false });
    const clipped = g.issueView(
      ["src/complete.ts"],
      [{ path: "src/complete.ts", explanation: "x".repeat(2000) }],
      1000,
    );
    expect(clipped).toMatchObject({ viewTruncated: true, incomplete: true });
    expect(Buffer.byteLength(JSON.stringify(clipped))).toBeLessThanOrEqual(1000);
  });

  it("does not mark exact count boundaries as truncated", async () => {
    const g = graph(
      source({
        "src/boundary.ts": Array.from(
          { length: 20 },
          (_, i) => `import "./boundary.js"; export const item${i}=1;`,
        ).join("\n"),
      }),
    );
    await g.inspect(["src/boundary.ts"], signal);
    const seeds = ["src/boundary.ts", ...Array.from({ length: 15 }, (_, i) => `src/seed${i}.ts`)];
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      path: `src/candidate${i}.ts`,
      explanation: "Candidate only",
    }));
    const v = g.issueView(seeds, candidates, 100_000);
    expect(v.relations).toHaveLength(20);
    expect(v.files[0]?.symbols).toHaveLength(20);
    expect(v.files[0]?.exports).toHaveLength(20);
    expect(v.seeds).toHaveLength(16);
    expect(v.candidatePaths).toHaveLength(8);
    expect(v).toMatchObject({ incomplete: false, viewTruncated: false });
  });

  it("uses declared pnpm workspace membership, preserves import/require conditions, and refuses ambiguous package names", async () => {
    const files = {
      "package.json": '{"name":"root"}',
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - '!packages/excluded'\n",
      "packages/lib/package.json":
        '{"name":"lib","exports":{".":{"import":"./esm.ts","require":"./cjs.ts"}}}',
      "packages/lib/esm.ts": "export default function() {}\nexport const {a,b}={a:1,b:2};",
      "packages/lib/cjs.ts": "export const c=1;",
      "src/a.ts": 'import lib from "lib"; require("lib");',
    };
    const g = graph(source(files));
    await g.inspect(["src/a.ts"], signal);
    expect(g.snapshot().edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "IMPORT", to: "packages/lib/esm.ts" }),
        expect.objectContaining({ kind: "REQUIRE", to: "packages/lib/cjs.ts" }),
      ]),
    );
    expect(
      g
        .snapshot()
        .files.find((f) => f.path === "packages/lib/esm.ts")
        ?.parse?.exports.map((e) => e.name),
    ).toEqual(expect.arrayContaining(["default", "a", "b"]));
    const ambiguous = graph(
      source({
        ...files,
        "packages/duplicate/package.json": '{"name":"lib","exports":"./index.ts"}',
        "packages/duplicate/index.ts": "export const bad=1;",
      }),
    );
    await ambiguous.inspect(["src/a.ts"], signal);
    expect(ambiguous.snapshot().edges.every((e) => e.to === null)).toBe(true);
  });
  it("does not turn a shadowed require call or a missing manifest into a static fact", async () => {
    const s = source({
      "src/a.ts": 'function require(p:string){return p;} require("./b.js");',
      "src/b.ts": "export const value=1;",
    });
    const g = graph(s);
    await g.inspect(["src/a.ts"], signal);
    expect(g.snapshot().edges[0]).toMatchObject({
      kind: "REQUIRE",
      resolution: "DYNAMIC",
      to: null,
    });
    s.manifest = async () => {
      throw new Error("unavailable");
    };
    const partial = graph(s);
    await partial.observe("src/a.ts", 'export {value} from "./b.js";', signal);
    expect(partial.snapshot().coverage.incomplete).toBe(true);
    expect(partial.snapshot().edges[0]?.to).toBeNull();
  });
  it("resolves aliases/JS extension substitution/barrels/cycles and isolates duplicate symbols", async () => {
    const files = {
      "tsconfig.json": JSON.stringify({
        extends: "./config/base.json",
        compilerOptions: { moduleResolution: "bundler", module: "esnext" },
      }),
      "config/base.json": JSON.stringify({
        compilerOptions: { baseUrl: "..", paths: { "@/*": ["src/*"] } },
      }),
      "src/main.ts": 'import {same} from "@/barrel.js"; export function run(){return same();}',
      "src/barrel.ts": 'export {same} from "./helper.js";',
      "src/helper.ts": 'import {run} from "./main.js"; export function same(){ return 1; }',
      "src/other.ts": "export function same(){return 2;}",
      "src/main.test.ts": 'import {run} from "./main.js"; export const test=run;',
    };
    const g = graph(source(files));
    await g.inspect(["src/main.ts", "src/other.ts"], signal);
    await g.publicTests(["src/main.ts"], signal);
    const a = g.snapshot();
    expect(a.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "src/main.ts",
          to: "src/barrel.ts",
          resolution: "RESOLVED",
        }),
        expect.objectContaining({ from: "src/barrel.ts", to: "src/helper.ts", kind: "REEXPORT" }),
        expect.objectContaining({ from: "src/helper.ts", to: "src/main.ts" }),
      ]),
    );
    expect(a.cycles).toContainEqual(["src/main.ts", "src/barrel.ts", "src/helper.ts"]);
    expect(a.files.filter((f) => f.parse?.symbols.some((s) => s.name === "same"))).toHaveLength(2);
    expect(a.files.find((f) => f.path === "src/barrel.ts")?.parse?.exports[0]).toMatchObject({
      name: "same",
      local: "same",
      specifier: "./helper.js",
    });
    const issue = g.issueView(["src/main.ts"]);
    expect(issue.relatedTests).toContain("src/main.test.ts");
    expect(issue.graphSha256).toBe(relationGraphDigest(g.snapshot()));
  });
  it("resolves workspace package exports and records external/dynamic/missing imports separately", async () => {
    const g = graph(
      source({
        "package.json": '{"name":"app","workspaces":["packages/*"]}',
        "packages/lib/package.json": '{"name":"@scope/lib","exports":{".":"./src/index.ts"}}',
        "packages/lib/src/index.ts": "export const value=1;",
        "src/a.ts":
          'import {value} from "@scope/lib"; import "absent-package"; import "./missing.js"; import("./literal.js"); import(name); require("./literal.js");',
        "src/literal.ts": "export const yes=true;",
      }),
    );
    await g.inspect(["src/a.ts"], signal);
    const a = g.snapshot();
    expect(a.edges).toContainEqual(
      expect.objectContaining({
        specifier: "@scope/lib",
        to: "packages/lib/src/index.ts",
        resolution: "RESOLVED",
      }),
    );
    expect(a.moduleEdges).toContainEqual(
      expect.objectContaining({
        from: "package.json",
        to: "packages/lib/package.json",
        kind: "STATIC_IMPORT",
      }),
    );
    expect(a.edges).toContainEqual(
      expect.objectContaining({ specifier: "absent-package", resolution: "EXTERNAL", to: null }),
    );
    expect(a.edges).toContainEqual(
      expect.objectContaining({ specifier: "./missing.js", resolution: "UNRESOLVED", to: null }),
    );
    expect(a.edges).toContainEqual(
      expect.objectContaining({
        kind: "DYNAMIC_IMPORT",
        specifier: null,
        resolution: "DYNAMIC",
        to: null,
      }),
    );
  });
  it("keeps baseline immutable and invalidates transitive dependents before rebuilding an overlay", async () => {
    const s = source({
      "src/a.ts": 'export {value} from "./b.js";',
      "src/b.ts": "export const value=1;",
    });
    const g = graph(s);
    await g.inspect(["src/a.ts"], signal);
    const baseline = g.snapshot(),
      original = JSON.stringify(baseline);
    const overlay = new RepositoryRelationGraph({
      repositoryId: "repo",
      baseCommitSha: "a".repeat(40),
      source: s,
      baseline,
      workspaceRevision: 1,
    });
    overlay.invalidate(["src/b.ts"], 2);
    expect(overlay.issueView(["src/a.ts"]).relations).toEqual([]);
    await overlay.observe("src/b.ts", "export const value=2;", signal);
    expect(overlay.snapshot().files.find((f) => f.path === "src/b.ts")).toMatchObject({
      sha256: hash("export const value=2;"),
      state: "CURRENT",
    });
    expect(overlay.snapshot().files.find((f) => f.path === "src/a.ts")?.state).toBe("STALE");
    expect(JSON.stringify(baseline)).toBe(original);
  });
  it("requeries edited dependencies against a fresh manifest without changing the baseline", async () => {
    const files: Record<string, string> = {
      "src/a.ts": 'export {value} from "./b.js";',
      "src/b.ts": "export const value=1;",
    };
    const current: IndexSource = {
      manifest: async () => source(files).manifest(signal),
      read: async (path) => ({ content: files[path]!, truncated: false }),
    };
    const g = graph(current);
    await g.inspect(["src/a.ts"], signal);
    const baseline = g.snapshot();
    const original = JSON.stringify(baseline);
    files["src/b.ts"] = 'export {value} from "./new.js";';
    files["src/new.ts"] = "export const value=2;";
    g.invalidate(["src/b.ts", "src/new.ts"], 1);
    expect(g.issueView(["src/a.ts"]).relations).toEqual([]);
    await g.inspect(["src/a.ts"], signal);
    const view = g.issueView(["src/a.ts", "src/b.ts"]);
    expect(view.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/b.ts",
          state: "CURRENT",
          sha256: hash(files["src/b.ts"]!),
        }),
        expect.objectContaining({
          path: "src/new.ts",
          state: "CURRENT",
          sha256: hash(files["src/new.ts"]!),
        }),
      ]),
    );
    expect(view.relations).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: "src/b.ts", to: "src/new.ts" })]),
    );
    expect(JSON.stringify(baseline)).toBe(original);
  });
  it("uses warm parse cache with no false facts from parse errors or truncated sources", async () => {
    const s = source({
      "src/unique-warm.ts": "export const foo=1;",
      "src/bad.ts": 'import "./x.js"; export function {',
    });
    const cold = graph(s);
    await cold.inspect(["src/unique-warm.ts", "src/bad.ts"], signal);
    const warm = graph(s);
    await warm.inspect(["src/unique-warm.ts"], signal);
    expect(warm.snapshot().metrics.cacheHits).toBe(1);
    expect(cold.snapshot().edges.some((e) => e.from === "src/bad.ts")).toBe(false);
    s.read = async () => ({ content: "truncated", truncated: true });
    const bad = graph(s);
    await bad.inspect(["src/unique-warm.ts"], signal);
    expect(bad.snapshot().coverage.parsedFiles).toBe(0);
  });
  it("never traverses hidden material, symlinks, secrets or executes repository configuration", async () => {
    const s = source({
      "src/a.ts": 'import "../hidden-acceptance/check.js";',
      "hidden-acceptance/check.js": "secret",
      ".env": "SECRET",
      "node_modules/foo/index.ts": "secret",
    });
    const g = graph(s);
    await g.inspect(["src/a.ts", "hidden-acceptance/check.js", ".env"], signal);
    expect(JSON.stringify(g.snapshot())).not.toContain('"path":"hidden-acceptance/check.js"');
    expect(s.read).toHaveBeenCalledTimes(1);
    expect(g.snapshot().edges[0]).toMatchObject({ to: null, resolution: "UNRESOLVED" });
  });
  it("supports source files larger than 64 KiB within the shared 512 KiB limit", async () => {
    const content = "// padding\n".repeat(9000) + 'export {value} from "./b.js";',
      g = graph(source({ "src/large.ts": content, "src/b.ts": "export const value=1;" }));
    await g.inspect(["src/large.ts"], signal);
    expect(g.snapshot().edges[0]?.to).toBe("src/b.ts");
  });
  it("queries a declaration beyond the default preview while retaining distinct same-name symbols", async () => {
    const padding = Array.from({ length: 60 }, (_, i) => `export const early${i}=1;`).join("\n");
    const g = graph(
      source({
        "src/a.ts": padding + '\nimport "./b.js"; export const $ZodRecord=1;',
        "src/b.ts": "export const $ZodRecord=2;",
      }),
    );
    await g.inspect(["src/a.ts"], signal);
    expect(
      g
        .issueView(["src/a.ts"])
        .files.find((f) => f.path === "src/a.ts")
        ?.symbols.some((s) => s.name === "$ZodRecord"),
    ).toBe(false);
    const symbols = g
      .issueView(["src/a.ts"], [], 8192, ["ZodRecord"])
      .files.flatMap((f) => f.symbols);
    expect(symbols).toHaveLength(2);
    expect(new Set(symbols.map((s) => s.id)).size).toBe(2);
  });
});
