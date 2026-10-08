import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ContinuationTools } from "../src/runs/continuation-tools.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
it("reserves actual changed paths rather than every approved file and reuses source only with full identity", () => {
  const c = new ContinuationTools(["a", "b", "c", "d"]);
  const before = c.reserve(4, true, ["serializer", "codec", "dto"]);
  expect(before.operations.checkpoint).toBe(3);
  expect(before.operations.checkpointRestore).toBe(2);
  c.observe("readFile", {
    ok: true,
    durationMs: 0,
    output: { path: "serializer", content: "source", fileSha256: sha("source"), truncated: false },
  });
  const after = c.reserve(4, true, ["serializer", "codec", "dto"]);
  expect(after.total).toBe(before.total - 1);
  expect(c.reserve(4, true, ["serializer", "codec", "dto"])).toEqual(after);
  c.observe("runCommand", { ok: true, durationMs: 0, output: {} });
  expect(c.current.size).toBe(0);
  expect(c.reserve(4, true).operations.checkpoint).toBe(11);
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
    reviewReads: 8,
  });
  expect(remaining.total).toBe(19);
  expect(remaining.total).toBeLessThan(c.reserve(4, true).total);
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
    reviewReads: 8,
  });
});
