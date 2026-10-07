import { describe, expect, it } from "vitest";
import { hash, type IndexSource } from "../src/localization/contracts.js";
import { navigateImplementation } from "../src/localization/implementation-navigation.js";

function fixture(files: Record<string, string>) {
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    sizeBytes: Buffer.byteLength(content),
    contentHash: hash(content),
    kind: "FILE" as const,
  }));
  const reads: string[] = [];
  const source: IndexSource = {
    manifest: async () => ({ entries, incomplete: false }),
    lookup: async (path) => entries.find((e) => e.path === path),
    read: async (path) => {
      reads.push(path);
      return { content: files[path]!, truncated: false };
    },
  };
  return { source, reads };
}
const base = {
  repositoryId: "navigation",
  baseCommitSha: "a".repeat(40),
  signal: new AbortController().signal,
};

describe("shared implementation navigation", () => {
  it("follows public receiver methods through a named barrel without spending the budget on types or unrelated star exports", async () => {
    const f = fixture({
      "tests/regression/behavior.test.ts":
        "import { Client } from '../../src/index.js';\nconst api = new Client();\nexpect(api.summary()).toEqual(1);",
      "src/index.ts": "export { Client } from './client.js';\nexport * from './errors.js';",
      "src/client.ts":
        "import { Reader } from './reader.js';\nimport type { Options } from './options.js';\nexport class Client {\n readonly #reader: Reader;\n summary() { return this.#reader.report(); }\n}",
      "src/reader.ts": "export class Reader {\n report() { return 0; }\n}",
      "src/options.ts": "export interface Options { summary: string }",
      "src/errors.ts": "export class ClientError extends Error {}",
    });
    const result = await navigateImplementation({
      ...base,
      source: f.source,
      description: "Reported summary should agree with the operation result",
      maxReads: 4,
      behaviorNavigation: true,
    });
    expect(result.windows.map((w) => w.path)).toEqual(
      expect.arrayContaining([
        "tests/regression/behavior.test.ts",
        "src/client.ts",
        "src/reader.ts",
      ]),
    );
    expect(f.reads).not.toContain("src/options.ts");
    expect(f.reads).not.toContain("src/errors.ts");
    expect(result.windows.some((w) => w.snippet.includes("return 0"))).toBe(true);
  });
  it("keeps the actual local helper instead of counting a contained variable as another definition", async () => {
    const f = fixture({
      "tests/regression/behavior.test.ts":
        "import { validate } from '../../src/validate.js';\nexpect(validate('parent.child')).toEqual('parent.child');",
      "src/validate.ts":
        "export function validate(path: string) {\n const result = lookup(path);\n return result;\n}\nfunction lookup(path: string) {\n return path.split('.').at(-1);\n}",
    });
    const result = await navigateImplementation({
      ...base,
      source: f.source,
      description: "Nested validation loses its parent",
      behaviorNavigation: true,
      maxWindows: 2,
    });
    expect(result.windows).toHaveLength(2);
    expect(result.windows.find((w) => w.path === "src/validate.ts")?.snippet).toContain(
      "path.split",
    );
  });
  it("follows imports from fallback test assertions before unrelated declarations", async () => {
    const f = fixture({
      "tests/behavior.test.ts":
        "import { evaluate } from '../src/evaluator.js';\nimport { encode } from '../src/codec.js';\nexpect(evaluate({ nested: { key: 1 } })).toBe(1);\nexpect(encode('nested.key')).toBe('nested.key');",
      "src/evaluator.ts": "export function evaluate(value: any) { return value['key']; }",
      "src/codec.ts": "export function encode(path: string) { return path.split('.').at(-1); }",
      "src/types.ts": "export interface Value { key: number }",
    });
    const result = await navigateImplementation({
      ...base,
      source: f.source,
      description: "Nested values are lost",
      prioritizeCandidates: true,
      candidates: [{ path: "src/types.ts" }, { path: "tests/behavior.test.ts" }],
      maxReads: 4,
    });
    expect(result.windows.map((w) => w.path)).toEqual(
      expect.arrayContaining(["tests/behavior.test.ts", "src/evaluator.ts", "src/codec.ts"]),
    );
    expect(result.windows.map((w) => w.snippet).join("\n")).toContain("return path.split");
  });
  it("visits explicit fifth candidates and public tests before following familiar helper branches", async () => {
    const files = {
      "tests/reopen_test.cpp": "void testReopen() { compact(); reopen(); assert(retained()); }",
      "src/manager.cpp": "void rotate() { rebuild(); }\nvoid rebuild() { rotate(); }",
      "include/record_index.h": "bool isUnused() const { return count == 0; }",
      "include/key_index.h": "int size() const { return keys.size(); }",
      "src/compactor.cpp": "void compact() { persist(); }",
    };
    const f = fixture(files);
    const result = await navigateImplementation({
      ...base,
      source: f.source,
      description: "Retained records disappear after compaction and reopening",
      candidates: Object.keys(files).map((path) => ({ path })),
      prioritizeCandidates: true,
    });
    for (const path of Object.keys(files))
      expect(
        result.windows.some((w) => w.path === path),
        path,
      ).toBe(true);
    expect(result.metrics.reads).toBeLessThanOrEqual(8);
    expect(result.windows.length).toBeLessThanOrEqual(6);
  });
  it("retains a consumer body through an aliased import without claiming a confirmed root cause", async () => {
    const { source } = fixture({
      "src/helper.ts": "export function lookupPath(x: string) { return x; }",
      "src/consumer.ts":
        "import {lookupPath as read} from './helper.js';\nexport function evaluate(x: string) { return read(x).length; }",
    });
    const result = await navigateImplementation({
      ...base,
      source,
      description: "lookupPath() is correct but evaluate consumes its result incorrectly",
      candidates: [{ path: "src/helper.ts", symbol: "lookupPath" }],
    });
    expect(result.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/consumer.ts",
          kind: "REFERENCE",
          reason: expect.stringContaining("unverified"),
        }),
      ]),
    );
    expect(result.metrics.reads).toBeLessThanOrEqual(8);
  });
  it("recognizes real function bodies in an entry file without treating a forwarding-only entry as implementation", async () => {
    const { source } = fixture({
      "src/index.ts":
        "export * from './types.js';\nexport function publicProcess(x: number) { return x - 1; }",
      "src/types.ts": "export interface Result { value: number }",
    });
    const result = await navigateImplementation({
      ...base,
      source,
      description: "publicProcess() returns the wrong value",
      candidates: [{ path: "src/index.ts" }],
    });
    expect(result.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/index.ts",
          symbol: "publicProcess",
          kind: "IMPLEMENTATION",
        }),
      ]),
    );
    expect(result.missing.join(" ")).not.toContain("publicProcess");
  });

  it("follows the requested export alias across barrels despite an earlier unrelated branch", async () => {
    const { source, reads } = fixture({
      "src/index.ts": "export * from './locales/index.js';\nexport * from './schemas.js';",
      "src/locales/index.ts": "export * from './fr.js';",
      "src/locales/fr.ts": "export const hello = 'bonjour';",
      "src/schemas.ts": "export { runEngine as publicProcess } from './internal/engine.js';",
      "src/internal/engine.ts": "export function runEngine(value: number) { return value - 1; }",
    });
    const result = await navigateImplementation({
      ...base,
      source,
      description: "api.publicProcess() returns the wrong value",
      candidates: [{ path: "src/index.ts" }],
      maxReads: 5,
    });
    expect(result.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/internal/engine.ts",
          symbol: "runEngine",
          kind: "IMPLEMENTATION",
        }),
      ]),
    );
    expect(result.windows.map((w) => w.snippet).join(" ")).toContain("return value - 1");
    expect(reads).not.toContain("src/locales/fr.ts");
  });

  it("follows namespace imports and named/default import aliases from observed code", async () => {
    const { source } = fixture({
      "src/wrapper.ts":
        "import * as impl from './worker.js'; export function transformValue(x: number) { return impl.convert(x); }",
      "src/worker.ts": "import actual from './engine.js'; export const convert = actual;",
      "src/engine.ts": "export default function engine(x: number) { return x * 2; }",
    });
    const result = await navigateImplementation({
      ...base,
      source,
      description: "transformValue() fails",
      candidates: [{ path: "src/wrapper.ts" }],
    });
    expect(result.windows.map((w) => w.symbol)).toEqual(
      expect.arrayContaining(["transformValue", "convert", "engine"]),
    );
    expect(
      result.windows.every(
        (w) =>
          w.contentHash ===
          hash(
            (
              {
                "src/wrapper.ts":
                  "import * as impl from './worker.js'; export function transformValue(x: number) { return impl.convert(x); }",
                "src/worker.ts": "import actual from './engine.js'; export const convert = actual;",
                "src/engine.ts": "export default function engine(x: number) { return x * 2; }",
              } as Record<string, string>
            )[w.path]!,
          ),
      ),
    ).toBe(true);
  });

  it("finds camel-case filename alternatives and implementation after overloads in a long file", async () => {
    const content =
      "export function serializeValue(x: number): number;\nexport function serializeValue(x: string): string;\nexport function serializeValue(x: unknown) {\n" +
      "  // padding\n".repeat(300) +
      "  if (cached) throw new Error('recursive cache');\n  return x;\n}";
    const { source } = fixture({ "src/serialize-value.ts": content });
    const result = await navigateImplementation({
      ...base,
      source,
      description: "serializeValue() has a recursive cached error",
      candidates: [{ path: "src/serializeValue.ts", symbol: "serializeValue" }],
    });
    expect(result.windows.some((w) => w.snippet.includes("recursive cache"))).toBe(true);
    expect(result.windows[0]?.endLine).toBeGreaterThan(3);
    expect(result.observations.join(" ")).toContain("new proposal before writing");
  });

  it("terminates cyclic forwarding and reports incomplete implementation coverage", async () => {
    const { source } = fixture({
      "src/a.ts": "export * from './b.js';",
      "src/b.ts": "export * from './a.js';",
    });
    const result = await navigateImplementation({
      ...base,
      source,
      description: "missingAction() fails",
      candidates: [{ path: "src/a.ts" }],
      maxReads: 3,
    });
    expect(result.metrics.reads).toBe(2);
    expect(result.windows).toHaveLength(0);
    expect(result.missing.join(" ")).toContain("not proof of absence");
  });

  it("excludes protected and stale sources, and respects an exhausted source budget", async () => {
    const f = fixture({
      "hidden-acceptance/private.ts": "export function publicAction() {}",
      "src/action.ts": "export function publicAction() {}",
    });
    const result = await navigateImplementation({
      ...base,
      source: { ...f.source, read: async () => ({ content: "changed", truncated: false }) },
      description: "publicAction()",
      candidates: [{ path: "hidden-acceptance/private.ts" }],
    });
    expect(result.windows).toHaveLength(0);
    expect(result.observations.join(" ")).toContain("stale navigation");
    const stopped = await navigateImplementation({
      ...base,
      source: f.source,
      description: "publicAction()",
      maxSourceBytes: 1,
    });
    expect(stopped.metrics.reads).toBe(0);
    expect(stopped.metrics.exitReason).toBe("SOURCE_BUDGET");
  });
});
