import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ContinuationTools } from "../src/runs/continuation-tools.js";
import { CurrentSourceCache } from "../src/runs/current-source-cache.js";
import type { SandboxSession } from "@devflow/sandbox";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const quote = (c: ContinuationTools, paths: readonly string[] = ["candidate", "test-source"]) =>
  c.operationPlan({
    sourceReadPaths: paths,
    repairContextPaths: paths,
    publicChecks: ["build", "typecheck", "lint", "test"],
    publicProfileDiscovered: true,
    correctionAvailable: true,
    review: { requiredSourcePaths: c.approved, candidateCaptureRequired: true },
  });
it("reserves actual changed paths rather than every approved file and reuses source only with full identity", () => {
  const c = new ContinuationTools(["a", "b", "c", "d"]);
  const before = quote(c, ["serializer", "codec", "dto"]);
  expect(before.byPhase.checkpoint).toBe(2);
  expect(before.byPhase.restore).toBe(2);
  c.observe("readFile", {
    ok: true,
    durationMs: 0,
    output: { path: "serializer", content: "source", fileSha256: sha("source"), truncated: false },
  });
  const after = quote(c, ["serializer", "codec", "dto"]);
  expect(after.requiredToolCalls).toBe(before.requiredToolCalls - 1);
  expect(quote(c, ["serializer", "codec", "dto"])).toEqual(after);
  c.observe("runCommand", { ok: true, durationMs: 0, output: {} });
  expect(c.current.size).toBe(0);
  expect(quote(c).byPhase.checkpoint).toBe(10);
});
it("does not reduce preparation for stale, partial or forged source", () => {
  const c = new ContinuationTools(["a"]);
  c.observe("readFile", {
    ok: true,
    durationMs: 0,
    output: { path: "a", content: "x", fileSha256: sha("y"), truncated: false },
  });
  expect(c.current.size).toBe(0);
});

it("releases consumed replan preparation while preserving remaining candidate and final checks", () => {
  const c = new ContinuationTools(["old.ts", "new.ts", "untouched.ts", "new.ts"]);
  const remaining = c.afterReplan(4, ["old.ts"]);
  expect(remaining.operations).toEqual({
    checkpoint: 4,
    sourceIdentity: 3,
    publicChecks: 4,
    reviewReads: 0,
  });
  expect(remaining.total).toBe(11);
  expect(remaining.total).toBeLessThan(quote(c).requiredToolCalls);
  expect(c.afterReplan(4, ["old.ts"])).toEqual(remaining);
  expect(c.changed.size).toBe(0); // A reserve never records consumption or mutation.
});

it("counts restored, added and deleted changes once and grows conservatively on unknown mutation", () => {
  const c = new ContinuationTools(["old.ts", "added.ts", "deleted.ts", "untouched.ts"]);
  c.changed.add("old.ts");
  c.changed.add("added.ts");
  c.changed.add("deleted.ts");
  expect(c.afterReplan(2, ["old.ts"]).operations.checkpoint).toBe(8);
  expect(c.afterReplan(0, []).operations.publicChecks).toBe(0);
  c.observe("runCommand", { ok: true, durationMs: 0, output: {} });
  expect(c.afterReplan(2, ["old.ts"]).operations.checkpoint).toBe(10);
  expect(c.afterReplan(2, ["old.ts"]).operations.sourceIdentity).toBe(4);
});

it("keeps base/clean checkpoint validation even for a resumed candidate with no changes", () => {
  const c = new ContinuationTools(["a.ts"]);
  expect(c.afterReplan(1, []).operations).toEqual({
    checkpoint: 2,
    sourceIdentity: 1,
    publicChecks: 1,
    reviewReads: 0,
  });
});

it("submits without reserving an unchosen scope investigation and retains only pending host operations", () => {
  const c = new ContinuationTools(["a.ts", "b.ts", "c.ts"]);
  c.changed.add("a.ts");
  c.changed.add("b.ts");
  c.changed.add("c.ts");
  expect(quote(c).byPhase.checkpoint).toBe(8);
  expect(c.finalization(4, { observeIdentity: false })).toEqual({
    operations: { checkpoint: 0, sourceIdentity: 0, publicChecks: 4, reviewReads: 0 },
    total: 4,
  });
  expect(c.finalization(4, { observeIdentity: true }).total).toBe(7);
  expect(c.finalization(4, { observeIdentity: true, restoredChangedPaths: ["a.ts"] })).toEqual(
    c.afterReplan(4, ["a.ts"]),
  );
});

it("quotes checkpoint growth before editing a second file, then consumes cached identity only after actual confirmation", () => {
  const sandbox = {} as SandboxSession;
  const cache = new CurrentSourceCache(sandbox);
  cache.rememberHead(sandbox, "a".repeat(40));
  cache.rememberBaseline(sandbox, "a".repeat(40), "old.ts", "before");
  for (const [path, content] of [
    ["old.ts", "changed"],
    ["second.ts", "unchanged"],
  ] as const)
    cache.remember(sandbox, {
      path,
      content,
      contentHash: sha(content),
      sizeBytes: content.length,
    });
  const continuation = new ContinuationTools(["old.ts", "second.ts"], cache, sandbox);
  continuation.changed.add("old.ts");
  const before = continuation.finalization(1, {
    observeIdentity: true,
    restoredChangedPaths: ["old.ts"],
  });
  const after = continuation.finalization(1, {
    observeIdentity: true,
    restoredChangedPaths: ["old.ts"],
    prospectiveEditPaths: ["second.ts"],
  });
  expect(before.operations.checkpoint).toBe(1); // status, other current and baseline observations are cached.
  expect(after.operations.checkpoint).toBe(3); // new second-file baseline + current content will be needed.
  expect(after.total - before.total).toBe(2);
  expect(after.operations.sourceIdentity).toBe(0); // the scheduled checkpoint supplies this exact identity.
  expect(continuation.changed).toEqual(new Set(["old.ts"])); // quotation cannot pretend an edit occurred.
  expect(cache.source(sandbox, "second.ts")?.content).toBe("unchanged");
});
