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
