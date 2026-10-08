import { expect, it } from "vitest";
import {
  contentHash,
  createInitialAgentState,
  FakeLanguageModel,
  type WorkingSet,
} from "@devflow/agent";
import { randomUUID } from "node:crypto";
import { CodingSession } from "../src/runs/coding-session.js";
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

it("separates three approved edits and two inspect reads from four optional exploration reads", () => {
  const paths = ["form.ts", "restore.ts", "validate.ts", "schema.ts", "field.ts"];
  const budget = new ExplorationBudget(
    ws,
    { targetedReads: 4, broadSearches: 2, relocations: 1 },
    true,
    paths,
  );
  expect(budget.authorize("batchReadFiles", { paths: paths.slice(0, 3) })).toBeUndefined();
  expect(budget.authorize("batchReadFiles", { paths: paths.slice(3) })).toBeUndefined();
  expect(budget.snapshot()).toMatchObject({ reads: 0, necessaryReadRequests: 5 });
  for (let index = 0; index < 4; index++)
    expect(budget.authorize("readFile", { path: `other${index}.ts` })).toBeUndefined();
  expect(budget.authorize("readFile", { path: "extra.ts" })).toMatchObject({
    code: "PERMISSION_DENIED",
    details: {
      failureOrigin: "HOST_EXPLORATION",
      category: "EXPLORATION_LIMIT",
      reasonCode: "OPTIONAL_READ_LIMIT",
    },
  });
  expect(budget.authorize("readFile", { path: "restore.ts" })).toBeUndefined();
  expect(budget.authorize("replaceText", { path: "restore.ts" })).toBeUndefined();
  expect(budget.snapshot()).toMatchObject({ reads: 4, necessaryReadRequests: 6 });
});

it("restores optional consumption and only accepts necessary read authority from the current host plan", () => {
  const original = new ExplorationBudget(
    ws,
    { targetedReads: 1, broadSearches: 1, relocations: 1 },
    true,
    ["a.ts"],
  );
  original.authorize("readFile", { path: "other.ts" });
  const source = "export const a = 1;";
  original.observe("readFile", {
    ok: true,
    durationMs: 0,
    output: { path: "a.ts", content: source, fileSha256: contentHash(source), truncated: false },
  });
  const restored = new ExplorationBudget(ws, original.limits, true, ["new-approved.ts"]);
  restored.restore(JSON.parse(JSON.stringify(original.snapshot())), true);
  expect(restored.snapshot().evidence).toEqual([]);
  expect(restored.authorize("readFile", { path: "a.ts" })?.details).toMatchObject({
    category: "EXPLORATION_LIMIT",
  });
  expect(restored.authorize("readFile", { path: "new-approved.ts" })).toBeUndefined();
  expect(restored.snapshot().reads).toBe(1);
  expect(restored.recover("STALE_EVIDENCE")).toBe(true);
  expect(restored.snapshot().reads).toBe(1);
});

it("does not invent unused exploration quota for an old or malformed checkpoint", () => {
  for (const saved of [undefined, { reads: 0 }]) {
    const budget = new ExplorationBudget(
      ws,
      { targetedReads: 4, broadSearches: 2, relocations: 1 },
      true,
      ["a.ts"],
    );
    budget.restore(saved, true);
    expect(budget.snapshot()).toMatchObject({
      reads: 4,
      searches: 2,
      relocations: 1,
      legacyConsumptionUnknown: true,
    });
    expect(budget.authorize("readFile", { path: "optional.ts" })?.details).toMatchObject({
      category: "EXPLORATION_LIMIT",
    });
    expect(budget.authorize("readFile", { path: "a.ts" })).toBeUndefined();
  }
});

it("records full current SHA and invalidates only changed necessary evidence without replenishing quota", () => {
  const budget = new ExplorationBudget(
    ws,
    { targetedReads: 4, broadSearches: 2, relocations: 1 },
    true,
    ["a.ts", "b.ts"],
  );
  for (const path of ["a.ts", "b.ts"])
    budget.observe("readFile", {
      ok: true,
      durationMs: 0,
      output: { path, content: "current", fileSha256: contentHash("current"), truncated: false },
    });
  budget.authorize("readFile", { path: "optional.ts" });
  budget.invalidate(["a.ts"], false);
  expect(budget.snapshot().evidence.map((row) => row.path)).toEqual(["b.ts"]);
  budget.observe("readFile", {
    ok: true,
    durationMs: 0,
    output: {
      path: "a.ts",
      content: "changed",
      fileSha256: contentHash("current"),
      truncated: false,
    },
  });
  expect(budget.snapshot().evidence.map((row) => row.path)).toEqual(["b.ts"]);
  budget.invalidate([], true);
  expect(budget.snapshot().evidence).toEqual([]);
  expect(budget.snapshot().reads).toBe(1);
});

it("preserves the exploration ledger through actual CodingSession.save and a newly constructed session", async () => {
  const budget = new ExplorationBudget(
    ws,
    { targetedReads: 4, broadSearches: 2, relocations: 1 },
    true,
    ["a.ts"],
  );
  for (let index = 0; index < 4; index++)
    budget.authorize("readFile", { path: `optional${index}.ts` });
  budget.authorize("readFile", { path: "a.ts" });
  let artifact = "";
  const session = new CodingSession(new FakeLanguageModel([]), async (state) => {
    artifact = JSON.stringify(state);
  });
  await session.save({
    ...createInitialAgentState(randomUUID(), [], new Date().toISOString()),
    hostToolState: { exploration: budget.snapshot() },
  });
  const restored = new CodingSession(
    new FakeLanguageModel([]),
    async () => {},
    JSON.parse(artifact),
  );
  const nextBudget = new ExplorationBudget(ws, budget.limits, true, ["a.ts"]);
  nextBudget.restore((await restored.load())!.hostToolState?.exploration, true);
  expect(nextBudget.snapshot()).toMatchObject({ reads: 4, necessaryReadRequests: 1 });
  expect(
    nextBudget.authorize("readFile", { path: "optional-after-restart.ts" })?.details,
  ).toMatchObject({ reasonCode: "OPTIONAL_READ_LIMIT" });
  expect(nextBudget.authorize("readFile", { path: "a.ts" })).toBeUndefined();
  expect(nextBudget.snapshot()).toMatchObject({ reads: 4, necessaryReadRequests: 2 });
});
