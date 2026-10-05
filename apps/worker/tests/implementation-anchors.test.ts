import { describe, expect, it, vi } from "vitest";
import {
  implementationAnchors,
  rankIssueCandidates,
} from "../src/localization/implementation-anchors.js";
import { PlanAgent } from "../src/runs/plan-agent.js";
import { hash, type IndexSource } from "../src/localization/contracts.js";

describe("implementation investigation anchors", () => {
  it("follows a verified barrel and namespace helper without browsing unrelated exports", async () => {
    const files: Record<string, string> = {
      "src/classic/checks.ts": 'export { multipleOf } from "../core/index.js";',
      "src/core/index.ts": 'export * from "./checks.js";\nexport * from "./locale.js";',
      "src/core/checks.ts":
        'import * as util from "./util.js";\nexport const MultipleOf = (x) => util.floatSafeRemainder(x, 3);',
      "src/core/util.ts": "export function floatSafeRemainder(x, y) { return x % y; }",
      "src/core/locale.ts": 'export const unrelated = "unrelated";',
    };
    const read = vi.fn(async (path: string) => ({ content: files[path]!, truncated: false }));
    const entries = Object.entries(files).map(([path, content]) => ({
      path,
      kind: "FILE" as const,
      sizeBytes: Buffer.byteLength(content),
      contentHash: hash(content),
    }));
    const source: IndexSource = {
      lookup: async (path) => entries.find((e) => e.path === path),
      manifest: async () => ({ entries, incomplete: false }),
      read,
    };
    const result = await new PlanAgent().prepare({
      title: "multipleOf() fails",
      description: "Inspect floatSafeRemainder()",
      source,
      repositoryId: "repo",
      baseCommitSha: "base",
      workspaceRevision: 0,
      signal: new AbortController().signal,
      discoveryCandidates: [
        {
          path: "src/classic/checks.ts",
          intent: "INSPECT",
          symbol: "floatSafeRemainder",
          reason: "multipleOf delegates to helper",
        },
      ],
      limits: { maxTotalTokens: 60000 },
    });
    expect(result.status).toBe("READY");
    expect(JSON.stringify(result.preparedFinalRequest?.messages)).toContain("return x % y");
    expect(result.attempt.metrics.reads).toBeLessThanOrEqual(6);
    expect(read.mock.calls.some(([path]) => path === "src/core/locale.ts")).toBe(false);
  });
  it("prefers constructor implementations over same-name interfaces, calls and barrels", () => {
    const content =
      "export interface $ZodDefault { value: unknown }\n" +
      "// gap\n".repeat(350) +
      "export const $ZodDefault = core.$constructor(\n  (inst, def) => { inst.parse = () => def.defaultValue; }\n);\n" +
      "const schema = $ZodDefault();\nexport { $ZodDefault };";
    const anchors = implementationAnchors(
      content,
      "default() should preserve defaults",
      "$ZodDefault",
    );
    expect(anchors[0]).toMatchObject({ line: 352, kind: "IMPLEMENTATION" });
    expect(anchors.find((a) => a.line === 1)?.kind).toBe("DECLARATION");
  });
  it("ranks matching source versions before protected tests and deduplicates file/symbol", () => {
    const candidates = [
      { path: "src/v4/tests/default.test.ts", symbol: "default" },
      { path: "src/v3/schemas.ts", symbol: "$ZodDefault" },
      { path: "src/v4/schemas.ts", symbol: "$ZodDefault" },
      { path: "src/v4/schemas.ts", symbol: "$ZodDefault" },
    ];
    expect(rankIssueCandidates(candidates, "v4 default() regression").map((c) => c.path)).toEqual([
      "src/v4/schemas.ts",
      "src/v3/schemas.ts",
      "src/v4/tests/default.test.ts",
    ]);
  });
  it("feeds a bounded implementation window and full SHA to the actual proposal request", async () => {
    const content =
      "export interface Transform { value: unknown }\n" +
      "// gap\n".repeat(350) +
      "export const Transform = (value) => { return convert(value); };\n";
    const entry = {
      path: "src/transform.ts",
      kind: "FILE" as const,
      sizeBytes: Buffer.byteLength(content),
      contentHash: hash(content),
    };
    const source: IndexSource = {
      lookup: async () => entry,
      manifest: async () => ({ entries: [entry], incomplete: false }),
      read: async () => ({ content, truncated: false }),
    };
    const result = await new PlanAgent().prepare({
      title: "Transform() conversion",
      description: "Inspect the transformation",
      repositoryId: "repo",
      baseCommitSha: "base",
      workspaceRevision: 0,
      source,
      signal: new AbortController().signal,
      discoveryCandidates: [
        {
          path: entry.path,
          intent: "INSPECT",
          symbol: "Transform",
          reason: "Find actual implementation",
        },
      ],
    });
    expect(result.status).toBe("READY");
    const request = JSON.stringify(result.preparedFinalRequest?.messages);
    expect(request).toContain("return convert(value)");
    expect(request).toContain(hash(content));
    expect(result.attempt.metrics.modelCalls).toBe(0);
    expect(request).toContain("IMPLEMENTATION");
  });
});
