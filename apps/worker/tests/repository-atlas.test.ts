import { describe, expect, it } from "vitest";
import type { RepositoryIndexStore } from "@devflow/database";
import { hash, type IndexSource } from "../src/localization/contracts.js";
import {
  atlasPage,
  atlasSource,
  buildRepositoryAtlas,
  rankAtlasRegions,
} from "../src/localization/repository-atlas.js";

const signal = new AbortController().signal;
function fixture(paths: string[], incomplete = false) {
  const entries = paths.map((path) => ({
    path,
    kind: "FILE" as const,
    sizeBytes: 1,
    contentHash: hash(path),
  }));
  let manifests = 0;
  const source: IndexSource = {
    identity: hash(JSON.stringify(entries)),
    async manifest() {
      manifests++;
      return { entries, incomplete };
    },
    async read() {
      throw new Error("Atlas must not read source");
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
  return { source, store, cache, manifests: () => manifests };
}
describe("PRG structural atlas", () => {
  it("builds a large hierarchy once, shares complete shards and pages without reading source", async () => {
    const f = fixture([
      "modules/cache/package.json",
      ...Array.from({ length: 2000 }, (_, i) => `modules/cache/deep/file${i}.ts`),
      ".env",
      "node_modules/a.ts",
    ]);
    const first = await buildRepositoryAtlas({ ...f, scope: "repo", signal });
    const warm = await buildRepositoryAtlas({ ...f, scope: "repo", signal });
    expect(f.manifests()).toBe(1);
    expect(first.metrics.sourceReads).toBe(0);
    expect(warm.metrics.cacheHits).toBe(1);
    expect(first.nodes.find((n) => n.path === "modules/cache")?.kind).toBe("MODULE");
    expect(first.entries).toHaveLength(2001);
    expect(atlasPage(first, "modules/cache/deep").nextOffset).toBe(24);
    const adapted = atlasSource(f.source, first);
    await adapted.manifest(signal);
    expect(f.manifests()).toBe(1);
    expect(rankAtlasRegions(first, "cache")).toHaveLength(first.nodes.length - 1);
  });
  it("does not publish incomplete manifests or infer absence in a partial view", async () => {
    const f = fixture(["src/a.ts"], true);
    const atlas = await buildRepositoryAtlas({ ...f, scope: "repo", signal });
    expect(atlas.coverage).toBe("PARTIAL");
    expect(f.cache.size).toBe(0);
    const outside = { path: "src/b.ts", kind: "FILE" as const, sizeBytes: 1 };
    expect(
      await atlasSource({ ...f.source, lookup: async () => outside }, atlas).lookup?.(
        outside.path,
        signal,
      ),
    ).toEqual(outside);
  });
  it("isolates overlays and changed configuration/file identities from shared baseline", async () => {
    const f = fixture(["a.ts", "package.json"]);
    const baseline = await buildRepositoryAtlas({ ...f, scope: "repo", signal });
    const changed = fixture(["b.ts", "pyproject.toml"]);
    const overlay = await buildRepositoryAtlas({
      source: {
        ...changed.source,
        identity: f.source.identity!,
        changes: async () => ({ entries: [], deleted: ["a.ts"], incomplete: false }),
      },
      store: f.store,
      scope: "repo",
      signal,
    });
    expect(overlay.entries.map((e) => e.path)).toEqual(["b.ts", "pyproject.toml"]);
    expect((await buildRepositoryAtlas({ ...f, scope: "repo", signal })).entries).toEqual(
      baseline.entries,
    );
    expect(
      (await buildRepositoryAtlas({ ...changed, store: f.store, scope: "repo", signal })).identity,
    ).not.toBe(baseline.identity);
  });
  it("rejects corrupt shards and ambiguous manifest paths without caching false completeness", async () => {
    const f = fixture(["a.ts", "a.ts", "../private.ts", "x/./b.ts"]);
    const atlas = await buildRepositoryAtlas({ ...f, scope: "repo", signal });
    expect(atlas.coverage).toBe("PARTIAL");
    expect(atlas.entries.map((e) => e.path)).toEqual(["a.ts"]);
    expect(f.cache.size).toBe(0);
  });
});
