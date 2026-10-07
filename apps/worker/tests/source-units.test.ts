import { describe, expect, it } from "vitest";
import { hash, type IndexSource } from "../src/localization/contracts.js";
import { parseStaticSource } from "../src/localization/source-units.js";
import { navigateImplementation } from "../src/localization/implementation-navigation.js";
import { RepositoryRelationGraph } from "../src/localization/relation-graph.js";
function source(files: Record<string, string>): IndexSource {
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    kind: "FILE" as const,
    sizeBytes: Buffer.byteLength(content),
    contentHash: hash(content),
  }));
  return {
    manifest: async () => ({ entries, incomplete: false }),
    lookup: async (path) => entries.find((e) => e.path === path),
    read: async (path) => ({ content: files[path]!, truncated: false }),
  };
}
const signal = new AbortController().signal;
const context = { repositoryId: "static-languages", baseCommitSha: "a".repeat(40), signal };
describe("C++ source units", () => {
  it.each(["search_engine", "moved_index"])(
    "follows namespace declarations into a paired implementation (%s)",
    async (name) => {
      const files = {
        [`include/index/${name}.hpp`]:
          "namespace index {\nclass Engine {\n public:\n Result search(Query query) const;\n};\n}\n",
        [`src/${name}.cpp`]: `#include "index/${name}.hpp"\nnamespace index {\nResult Engine::search(Query query) const {\n auto result = lookup(query);\n if (result.empty()) return {};\n return result;\n}\n}\n`,
        "tests/decoy.cpp": "Result Other::search(Query query) { return {}; }",
      };
      const result = await navigateImplementation({
        ...context,
        source: source(files),
        description: "Engine.search() loses results",
        candidates: [{ path: `include/index/${name}.hpp`, symbol: "search" }],
      });
      expect(result.windows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: `src/${name}.cpp`,
            symbol: "search",
            kind: "IMPLEMENTATION",
            parser: "LEXICAL_STATIC",
          }),
        ]),
      );
      expect(result.windows.map((w) => w.snippet).join(" ")).toContain("result.empty()");
    },
  );
  it("does not promote duplicate implementation names or virtual/template calls to confirmed semantic edges", () => {
    const unit = parseStaticSource(
      "include/a.hpp",
      "#ifndef A_H\n#define A_H\nclass A {\n virtual void run();\n};\n#endif\n",
      ["one/a.cpp", "two/a.cpp"],
    )!;
    expect(unit.dependencies.find((d) => d.kind === "IMPLEMENTATION_PAIR")?.resolution).toBe(
      "AMBIGUOUS",
    );
    expect(unit.unknown.join(" ")).toContain("virtual dispatch");
    expect(unit.definitions.find((d) => d.name === "run")?.implementation).toBe(false);
  });
});
describe("Java source units", () => {
  it("navigates a listener's declared receiver to the imported cache while retaining overload uncertainty", async () => {
    const files = {
      "src/app/Listener.java":
        "package app;\nimport core.Cache;\nclass Listener {\n private final Cache cache;\n public void updated(Event event) {\n  cache.invalidate(event.id());\n }\n}\n",
      "src/core/Cache.java":
        "package core;\nclass Cache {\n public void invalidate(String id) {\n  values.remove(id);\n }\n public void invalidate(int id) {\n  values.clear();\n }\n}\n",
      "test/fake/Cache.java": "class Cache { void invalidate() {} }",
    };
    const result = await navigateImplementation({
      ...context,
      source: source(files),
      description: "Listener.updated() invalidation fails",
      candidates: [{ path: "src/app/Listener.java", symbol: "updated" }],
    });
    expect(result.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/core/Cache.java",
          symbol: "invalidate",
          parser: "LEXICAL_STATIC",
        }),
      ]),
    );
    expect(result.windows.some((w) => w.path === "test/fake/Cache.java")).toBe(false);
    expect(
      parseStaticSource("src/core/Cache.java", files["src/core/Cache.java"])?.unknown.join(" "),
    ).toContain("Overloaded");
  });
  it("keeps interface and injection selection unknown, and rejects unmatched braces as complete bodies", () => {
    const unit = parseStaticSource(
      "app/Service.java",
      "package app;\nimport api.Store;\nclass Service {\n @Autowired\n Store store;\n public Object fetch() {\n return store.get();\n }\n}",
      ["api/Store.java"],
    )!;
    expect(unit.receivers.store).toBe("Store");
    expect(unit.unknown.join(" ")).toContain("implementation selection is unknown");
    expect(
      parseStaticSource("Broken.java", "class Broken {\n void broken() {\n")?.definitions,
    ).toEqual([]);
  });
});
describe("Python source units", () => {
  it.each(["registry", "different_name"])(
    "follows explicit relative imports and typed receivers despite same-name distractors (%s)",
    async (name) => {
      const files = {
        "src/app/wrapper.py": `from .${name} import Registry as R\nclass Commands:\n    def __init__(self, registry: R):\n        self._registry = registry\n    def resolve(self, name):\n        return self._registry.resolve(name)\n`,
        [`src/app/${name}.py`]:
          "class Registry:\n    def resolve(self, name):\n        if name not in self.commands:\n            raise KeyError(name)\n        return self.commands[name]\n",
        "tests/registry.py": "class Registry:\n    def resolve(self, name):\n        return None\n",
      };
      const result = await navigateImplementation({
        ...context,
        source: source(files),
        description: "Commands.resolve() returns stale entries",
        candidates: [{ path: "src/app/wrapper.py", symbol: "resolve" }],
      });
      expect(result.windows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: `src/app/${name}.py`,
            symbol: "resolve",
            kind: "IMPLEMENTATION",
            parser: "LEXICAL_STATIC",
          }),
        ]),
      );
      expect(result.windows.find((w) => w.path === "src/app/wrapper.py")?.sourceRole).toBe(
        "FORWARDER",
      );
      expect(result.windows.some((w) => w.path === "tests/registry.py")).toBe(false);
    },
  );
  it("masks strings/comments, retains ambiguous imports and marks runtime decorators unknown", () => {
    const content =
      'from services.registry import Registry\ntext = "def invented(): pass"\n# def fake():\n@register\ndef actual():\n    return Registry()\n';
    const unit = parseStaticSource("src/a.py", content, [
      "one/services/registry.py",
      "two/services/registry.py",
    ])!;
    expect(unit.definitions.map((d) => d.name)).toEqual(["actual"]);
    expect(unit.dependencies[0]?.resolution).toBe("AMBIGUOUS");
    expect(unit.unknown.join(" ")).toContain("Decorators");
  });
  it("bounds cyclic navigation and invalidates source identity rather than reusing stale units", async () => {
    const files = {
      "src/a.py": "from .b import loop\ndef run():\n    return loop()\n",
      "src/b.py": "from .a import run\ndef loop():\n    return run()\n",
    };
    const src = source(files),
      graph = new RepositoryRelationGraph({ ...context, source: src });
    await graph.inspect(["src/a.py"], signal);
    expect(graph.snapshot().coverage).toMatchObject({ astParsedFiles: 0, lexicalParsedFiles: 2 });
    expect(graph.snapshot().cycles.length).toBeGreaterThan(0);
    graph.invalidate(["src/b.py"], 1);
    expect(graph.issueView(["src/a.py"]).files).toEqual([]);
    expect(graph.snapshot().files.every((f) => f.state === "STALE")).toBe(true);
    const result = await navigateImplementation({
      ...context,
      source: src,
      description: "run() fails",
      candidates: [{ path: "src/a.py", symbol: "run" }],
      maxReads: 3,
    });
    expect(result.metrics.reads).toBeLessThanOrEqual(3);
    expect(result.windows.every((w) => w.kind === "REFERENCE")).toBe(true);
  });
});

it("does not restore a receiver after contradictory lexical type observations", () => {
  const unit = parseStaticSource(
    "src/a.py",
    "def one(cache: Fast):\n    return cache.get()\ndef two(cache: Slow):\n    return cache.get()\ndef three(cache: Fast):\n    return cache.get()\n",
    [],
  )!;
  expect(unit.receivers.cache).toBeUndefined();
  expect(unit.unknown.join(" ")).toContain("Ambiguous Python receiver cache");
});
