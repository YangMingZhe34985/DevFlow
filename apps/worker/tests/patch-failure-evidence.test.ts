import { expect, it } from "vitest";
import { contentHash } from "@devflow/agent";
import type { ToolExecutionResult } from "@devflow/tools";
import { attachPatchFailureEvidence } from "../src/runs/patch-failure-evidence.js";
import { normalizeMutation } from "../src/runs/post-patch.js";

const path = "src/consumer.cpp";
const content = Array.from({ length: 100 }, (_, i) => `const line_${i + 1} = ${i + 1};\r\n`).join(
  "",
);
const sha = contentHash(content);
const patch = `--- a/${path}\n+++ b/${path}\n@@ -66,6 +66,7 @@\n stale context\n+ correct me\n`;
const request = { name: "applyPatch", input: { patch } };
function failure(): ToolExecutionResult {
  const result: ToolExecutionResult = {
    ok: false,
    durationMs: 0,
    error: {
      code: "TOOL_FAILED",
      message: "Patch context does not exactly apply",
      retryable: false,
      details: { patchFailure: { kind: "CONTEXT_MISMATCH", needsRead: false } },
    },
  };
  return {
    ...result,
    mutation: normalizeMutation(result, { [path]: sha }, { [path]: sha }, [path], 2),
  };
}
const current = () => new Map([[path, { content, expectedHash: sha }]]);
function details(result: ToolExecutionResult) {
  if (result.ok) throw new Error("expected unchanged rejection");
  return result.error.details as {
    patchFailure: {
      currentSource: {
        path: string;
        fileSha256: string;
        startLine: number;
        endLine: number;
        content: string;
      }[];
      needsRead: boolean;
      contextEvidenceComplete: boolean;
      additionalPhysicalReads: number;
    };
  };
}
it("returns the current hunk and following branch from already verified source without rewriting the patch", () => {
  const original = structuredClone(request);
  const result = attachPatchFailureEvidence(request, failure(), current());
  const info = details(result).patchFailure;
  expect(info).toMatchObject({
    needsRead: false,
    contextEvidenceComplete: true,
    additionalPhysicalReads: 0,
  });
  expect(info.currentSource).toHaveLength(1);
  expect(info.currentSource[0]).toMatchObject({
    path,
    fileSha256: sha,
    startLine: 58,
    endLine: 79,
  });
  expect(info.currentSource[0]!.content).toContain("const line_72 = 72;\r\n");
  expect(info.currentSource[0]!.content).toBe(
    content
      .match(/[^\n]*\n|[^\n]+$/gu)!
      .slice(57, 79)
      .join(""),
  );
  expect(request).toEqual(original);
  expect(result.mutation).toMatchObject({ workspaceChanged: false, afterRevision: 2 });
});
for (const invalid of [
  "partial",
  "changed",
  "sha",
  "uncached",
  "out-of-range",
  "oversized",
] as const)
  it(`keeps needsRead when current evidence is ${invalid}`, () => {
    const result = failure(),
      sources = current(),
      input = structuredClone(request);
    if (invalid === "partial") result.mutation!.observationComplete = false;
    if (invalid === "changed") result.mutation!.workspaceChanged = true;
    if (invalid === "sha") sources.set(path, { content, expectedHash: "b".repeat(64) });
    if (invalid === "uncached") sources.clear();
    if (invalid === "out-of-range") input.input.patch = patch.replace("-66,6", "-99,6");
    if (invalid === "oversized") {
      const long = content.replace("const line_72 = 72;", "x".repeat(9000));
      const hash = contentHash(long);
      sources.set(path, { content: long, expectedHash: hash });
      result.mutation!.currentHashes[path] = hash;
    }
    const info = details(attachPatchFailureEvidence(input, result, sources)).patchFailure;
    expect(info.needsRead).toBe(true);
    expect(info.contextEvidenceComplete).toBe(false);
    expect(info.currentSource).toHaveLength(0);
  });
it("does not expose an unapproved second target from unrelated cache entries", () => {
  const input = {
    name: "applyPatch",
    input: { patch: patch + "--- a/private.cpp\n+++ b/private.cpp\n@@ -1,1 +1,1 @@\n-old\n+new\n" },
  };
  const info = details(attachPatchFailureEvidence(input, failure(), current())).patchFailure;
  expect(info.contextEvidenceComplete).toBe(false);
  expect(info.needsRead).toBe(true);
  expect(info.currentSource.map((s) => s.path)).toEqual([path]);
});
