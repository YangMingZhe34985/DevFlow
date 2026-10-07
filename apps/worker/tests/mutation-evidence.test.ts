import { expect, it } from "vitest";
import { contentHash, type WorkingCode } from "@devflow/agent";
import { DevflowError } from "@devflow/shared";
import { normalizeMutation, reconcileMutationEvidence } from "../src/runs/post-patch.js";

const hashes = { a: contentHash("a"), b: contentHash("b") };
const ok = { ok: true as const, output: {}, durationMs: 0 };
const failed = {
  ok: false as const,
  durationMs: 0,
  error: new DevflowError({ code: "TOOL_FAILED", message: "failed after write" }).toJSON(),
};
function fixture() {
  return {
    versions: new Map(Object.entries(hashes)),
    fullReads: new Set(["a", "b"]),
    stalePaths: new Set<string>(),
    observedSources: ["a", "b"].map((path) => ({
      path,
      code: path,
      contentHash: hashes[path as keyof typeof hashes],
      startLine: 1,
      endLine: 1,
      complete: true,
      role: "TARGET",
      workspaceRevision: 0,
    })) as WorkingCode[],
  };
}
it("keeps trusted versions, complete reads and source seeds after a fully observed failed no-write", () => {
  const state = fixture();
  const effect = reconcileMutationEvidence(
    "replaceText",
    { ...failed, mutation: normalizeMutation(failed, hashes, hashes, ["a"], 0) },
    state,
  );
  expect(effect).toEqual({ unchanged: true, paths: [], unknownScope: false });
  expect([...state.versions]).toEqual(Object.entries(hashes));
  expect([...state.fullReads]).toEqual(["a", "b"]);
  expect(state.observedSources.map((source) => source.path)).toEqual(["a", "b"]);
});
it("invalidates a failed actual write and its graph effect while retaining unrelated code", () => {
  const state = fixture(),
    after = { ...hashes, a: contentHash("changed") };
  const effect = reconcileMutationEvidence(
    "applyPatch",
    { ...failed, mutation: normalizeMutation(failed, hashes, after, ["a"], 0) },
    state,
  );
  expect(effect).toEqual({ unchanged: false, paths: ["a"], unknownScope: false });
  expect([...state.versions.keys()]).toEqual(["b"]);
  expect([...state.fullReads]).toEqual(["b"]);
  expect([...state.stalePaths]).toEqual(["a"]);
  expect(state.observedSources.map((source) => source.path)).toEqual(["b"]);
});
it("only trusts successful write output whose SHA agrees with the complete host observation", () => {
  const state = fixture(),
    next = contentHash("new"),
    result = { ...ok, output: { path: "a", sha256: next } };
  reconcileMutationEvidence(
    "replaceText",
    { ...result, mutation: normalizeMutation(result, hashes, { ...hashes, a: next }, ["a"], 0) },
    state,
  );
  expect(state.versions.get("a")).toBe(next);
  expect(state.fullReads.has("a")).toBe(true);
  expect(state.versions.get("b")).toBe(hashes.b);
  const inconsistent = fixture();
  reconcileMutationEvidence(
    "replaceText",
    {
      ...result,
      mutation: normalizeMutation(result, hashes, { ...hashes, a: contentHash("other") }, ["a"], 0),
    },
    inconsistent,
  );
  expect(inconsistent.versions.has("a")).toBe(false);
});
it("keeps unknown command outcomes conservative and represents deleted files without stale authority", () => {
  const state = fixture();
  expect(reconcileMutationEvidence("runCommand", failed, state).unknownScope).toBe(true);
  expect(state.versions.size).toBe(0);
  expect(state.fullReads.size).toBe(0);
  const deleted = fixture();
  reconcileMutationEvidence(
    "applyPatch",
    { ...ok, mutation: normalizeMutation(ok, hashes, { b: hashes.b, a: "ABSENT" }, ["a"], 0) },
    deleted,
  );
  expect(deleted.versions.has("a")).toBe(false);
  expect(deleted.versions.has("b")).toBe(true);
});
