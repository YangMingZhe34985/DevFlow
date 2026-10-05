import { expect, it } from "vitest";
import { contentHash, type WorkingSet } from "@devflow/agent";
import { buildWorkingSet, ExplorationBudget, patchTargetPaths } from "../src/runs/working-set.js";
import type { EvidencePack } from "../src/localization/contracts.js";
const ws = { evidenceSufficient: true, relevantCode: [{ path: "a.ts" }] } as WorkingSet;
it("verifies quoted text patch paths and fails closed for ambiguous or metadata-only patches", () => {
  expect(
    patchTargetPaths(
      'diff --git "a/my file.ts" "b/my file.ts"\n--- "a/my file.ts"\n+++ "b/my file.ts"\n@@ -1 +1 @@\n-a\n+b',
    ),
  ).toEqual(["my file.ts"]);
  expect(patchTargetPaths("--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+a")).toEqual(["new.ts"]);
  expect(
    patchTargetPaths("diff --git a/old b/new\nrename from old\nrename to new"),
  ).toBeUndefined();
  expect(patchTargetPaths('--- "a/\\141.ts"\n+++ b/a.ts')).toBeUndefined();
  expect(patchTargetPaths("--- a/./a.ts\n+++ b/./a.ts")).toBeUndefined();
});
it("gates broad tools, bounds batch reads, and grants recovery only once without resetting counters", () => {
  const budget = new ExplorationBudget(ws, { targetedReads: 2, broadSearches: 1, relocations: 1 });
  expect(budget.available("searchCode")).toBe(false);
  expect(budget.consume("readFile", { path: "other.ts" })).toContain("outside");
  expect(budget.consume("batchReadFiles", { paths: ["a.ts", "a.ts", "a.ts"] })).toContain(
    "exceeded",
  );
  expect(budget.consume("readFile", { path: "a.ts" })).toBeUndefined();
  expect(budget.recover("PATCH_REJECTED")).toBe(true);
  expect(budget.available("locateIssue")).toBe(true);
  expect(budget.consume("locateIssue", {})).toBeUndefined();
  expect(budget.available("locateIssue")).toBe(false);
  expect(budget.recover("STALE_EVIDENCE")).toBe(false);
  expect(budget.consume("readFile", { path: "other.ts" })).toBeUndefined();
  expect(budget.available("readFile")).toBe(false);
  expect(budget.available("writeFile")).toBe(true);
});
it("permits bounded public reads outside proposal evidence without widening search or mutation authority", () => {
  const budget = new ExplorationBudget(
    ws,
    { targetedReads: 2, broadSearches: 1, relocations: 1 },
    true,
  );
  expect(
    budget.consume("batchReadFiles", { paths: ["dependency.ts", "graph-outside.ts"] }),
  ).toBeUndefined();
  expect(budget.consume("readFile", { path: "another.ts" })).toContain("unavailable");
  expect(budget.available("searchCode")).toBe(false);
  expect(budget.workingSet).toBe(ws);
});
it("projects a working set without retrieval metrics, preserving uncertainty and test anchors", () => {
  const code = "export const value = 1;\n";
  const pack = {
    evidence: [
      {
        path: "a.ts",
        snippet: code,
        contentHash: contentHash(code),
        startLine: 1,
        endLine: 2,
        fileType: "SOURCE",
        parseStatus: "PARSED",
        reason: "candidate",
        symbol: "value",
      },
      {
        path: "a.test.ts",
        snippet: "assert",
        contentHash: "b",
        startLine: 1,
        endLine: 1,
        fileType: "TEST",
        parseStatus: "PARSED",
        reason: "Exact Issue anchor",
      },
    ],
    viewRevision: "v",
    missingInformation: [],
    incomplete: false,
    truncated: false,
  } as unknown as EvidencePack;
  const result = buildWorkingSet(pack, 0);
  expect(result.evidenceSufficient).toBe(true);
  expect(result.targetFiles).toContain("a.test.ts");
  expect(result).not.toHaveProperty("metrics");
  expect(buildWorkingSet({ ...pack, incomplete: true }, 0).requiresAdditionalExploration).toBe(
    true,
  );
  const noTrailingLf = { ...pack, evidence: [{ ...pack.evidence[0]!, snippet: code.trimEnd() }] };
  expect(buildWorkingSet(noTrailingLf, 0).relevantCode[0]).toMatchObject({ complete: true, code });
  expect(buildWorkingSet(noTrailingLf, 0).evidenceSufficient).toBe(true);
});
