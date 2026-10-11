import { describe, expect, it } from "vitest";
import { parsePrgSyntax, sourceUnitFromSyntax } from "../src/localization/prg-parser.js";
import { hash, type IndexSource } from "../src/localization/contracts.js";
import { RepositoryRelationGraph } from "../src/localization/relation-graph.js";
import { queryPrgFacts } from "../src/localization/prg-facts.js";
const signal = new AbortController().signal;
describe("PRG four-language facts", () => {
  it("reuses immutable syntax facts, recomputes bindings and invalidates changed source", async () => {
    const files: Record<string, string> = {
      "pkg/use.py": "from .core import check\ndef run(x):\n    return check(x)\n",
      "pkg/core.py": "def check(x):\n    return x\n",
    };
    const cache = new Map<string, unknown>();
    const store = {
      get: async (scope: string, key: string) => cache.get(scope + key),
      publish: async (scope: string, key: string, value: unknown) => {
        cache.set(scope + key, value);
      },
    };
    const make = () =>
      new RepositoryRelationGraph({
        repositoryId: "repo",
        baseCommitSha: "a".repeat(40),
        prg: true,
        factStore: store,
        source: {
          manifest: async () => ({
            entries: Object.entries(files).map(([path, content]) => ({
              path,
              kind: "FILE" as const,
              sizeBytes: content.length,
              contentHash: hash(content),
            })),
            incomplete: false,
          }),
          read: async (p: string) => ({ content: files[p]!, truncated: false }),
        },
      });
    const cold = make();
    await cold.inspect(["pkg/use.py"], signal, false);
    const warm = make();
    await warm.inspect(["pkg/use.py"], signal, false);
    expect(cold.snapshot().metrics.coldParses).toBe(1);
    expect(warm.snapshot().metrics.coldParses).toBe(0);
    expect(warm.snapshot().metrics.cacheHits).toBe(1);
    files["pkg/use.py"] += "\ndef another():\n    return 2\n";
    const changed = make();
    await changed.inspect(["pkg/use.py"], signal, false);
    expect(changed.snapshot().metrics.coldParses).toBe(1);
    expect(
      changed
        .snapshot()
        .files.find((f) => f.path === "pkg/use.py")
        ?.sourceUnit?.definitions.some((d) => d.name === "another"),
    ).toBe(true);
  });
  it.each([
    [
      "a.py",
      "from .service import validate as check\ndef run(value):\n    return check(value)\n",
      "run",
      "check",
    ],
    [
      "A.java",
      "package app; import app.Service; class A { int run(int x) { return Service.check(x); } int run(String x) { return 1; } }",
      "run",
      "check",
    ],
    [
      "a.cpp",
      '#include "service.h"\n#define CHECK(x) check(x)\nint run(int x) { return CHECK(x); }',
      "run",
      "CHECK",
    ],
  ])(
    "parses pinned WASM %s without executing repository code",
    async (path, content, definition, call) => {
      const facts = await parsePrgSyntax(path, content, signal);
      expect(facts.status).toBe("PARSED");
      expect(facts.declarations.some((d) => d.name === definition)).toBe(true);
      expect(facts.calls.some((c) => c.name === call)).toBe(true);
      const unit = sourceUnitFromSyntax(
        path,
        content,
        [path, "service.py", "service.h", "app/Service.java"],
        facts,
      );
      expect(unit.parser).toBe("TREE_SITTER_WASM");
      expect(unit.unknown.join(" ")).toContain("do not prove");
    },
  );
  it("reuses TS alias resolution and exposes syntax without claiming unique call targets", async () => {
    const files: Record<string, string> = {
      "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
      "src/core.ts": "export function check(x: number) { return x; }",
      "src/view.ts":
        "import {check as validate} from '@/core'; export function run(check: Function) { return check(validate(1)); }",
    };
    const entries = Object.entries(files).map(([path, content]) => ({
      path,
      kind: "FILE" as const,
      contentHash: hash(content),
      sizeBytes: content.length,
    }));
    const source: IndexSource = {
      manifest: async () => ({ entries, incomplete: false }),
      read: async (p) => ({ content: files[p]!, truncated: false }),
    };
    const graph = new RepositoryRelationGraph({
      source,
      repositoryId: "test",
      baseCommitSha: "a".repeat(40),
      prg: true,
    });
    await graph.inspect(["src/view.ts", "src/core.ts"], signal, false);
    const result = queryPrgFacts(graph.snapshot(), ["src/core.ts"]);
    expect(result.facts).toContainEqual(
      expect.objectContaining({
        from: "src/view.ts",
        to: "src/core.ts",
        relation: "IMPORTS",
        status: "VERIFIED",
      }),
    );
    expect(
      result.facts.filter((f) => f.relation === "CALLS").every((f) => f.status === "UNRESOLVED"),
    ).toBe(true);
    graph.invalidate(["src/view.ts"], 1);
    expect(
      queryPrgFacts(graph.snapshot(), ["src/core.ts"]).facts.some((f) => f.from === "src/view.ts"),
    ).toBe(false);
  });
  it("marks syntax errors and bounds file parsing", async () => {
    const syntax = await parsePrgSyntax("bad.py", "def broken(:\n return 1", signal);
    expect(syntax.status).toBe("PARSE_ERROR");
    expect(
      sourceUnitFromSyntax("bad.py", "def broken(:\n return 1", ["bad.py"], syntax).dependencies,
    ).toEqual([]);
    await expect(parsePrgSyntax("large.py", "x".repeat(512 * 1024 + 1), signal)).rejects.toThrow(
      "512 KiB",
    );
  });
  it.each([
    [
      "pkg/use.py",
      "import service\ndef run():\n    return service.check()\n",
      ["vendor/service.py"],
    ],
    ["pkg/A.java", "package pkg; import other.Service; class A {}", ["wrong/other/Service.java"]],
    ["src/use.cpp", "#include <service.h>\nint run() { return 1; }", ["other/service.h"]],
  ])(
    "does not upgrade unique path suffixes to verified import targets: %s",
    async (path, content, candidates) => {
      const syntax = await parsePrgSyntax(path, content, signal);
      const unit = sourceUnitFromSyntax(path, content, [path, ...candidates], syntax);
      expect(unit.dependencies.length).toBeGreaterThan(0);
      expect(unit.dependencies.every((d) => d.resolution !== "RESOLVED")).toBe(true);
    },
  );
});
