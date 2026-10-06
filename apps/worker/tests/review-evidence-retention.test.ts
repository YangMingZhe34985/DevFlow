import { expect, it, vi } from "vitest";
import {
  retainReviewEvidence,
  RetainedReviewEvidenceSchema,
} from "../src/runs/review-evidence-retention.js";
import type { ReviewEvidence } from "../src/runs/review-evidence.js";
import { hash } from "../src/localization/contracts.js";

const content = "export const counterexample = 2;\n";
const source = {
  path: "helper.ts",
  content,
  fileSha256: hash(content),
  startLine: 1,
  endLine: 2,
  partial: false,
};
const finding = {
  findingId: "host-1",
  severity: "ERROR" as const,
  message: "Observe the helper",
  disposition: "OPEN" as const,
};
function fixture() {
  const current: ReviewEvidence = {
    workspaceRevision: 2,
    policy: {},
    sources: [],
    unavailable: [],
    toolExecutions: 0,
    toolLatencyMs: 0,
  };
  const previous = RetainedReviewEvidenceSchema.parse({
    version: 1,
    workspaceRevision: 1,
    baselineRevision: "base",
    sources: [source],
  });
  return {
    previous,
    current,
    findings: [finding],
    baselineRevision: "base",
    cache: [],
    signal: new AbortController().signal,
    verifyCurrent: vi.fn(async (_path: string) => source.fileSha256),
  };
}
it("retains an unchanged helper/counterexample after a denied write or unrelated Repair", async () => {
  const input = fixture();
  input.previous = RetainedReviewEvidenceSchema.parse({
    ...input.previous,
    repairResponse: {
      outcome: "ALREADY_SATISFIED",
      summary: "Current helper already meets expectation",
      findingIds: ["host-1"],
    },
  });
  const cacheVerified = vi.fn();
  await retainReviewEvidence({
    ...input,
    cacheVerified,
    cache: [{ key: "CURRENT:1:helper.ts", content, sha256: source.fileSha256 }],
  });
  expect(input.verifyCurrent).toHaveBeenCalledExactlyOnceWith("helper.ts");
  expect(input.current.sources).toEqual([source]);
  expect(input.findings[0]?.disposition).toBe("OPEN");
  expect(
    RetainedReviewEvidenceSchema.parse(JSON.parse(JSON.stringify(input.previous))).repairResponse
      ?.findingIds,
  ).toEqual(["host-1"]);
  expect(cacheVerified).toHaveBeenCalledWith({
    key: "CURRENT:2:helper.ts",
    content,
    sha256: source.fileSha256,
  });
});
it("uses the newly observed full SHA without duplicating physical reads, retaining missing ranges", async () => {
  const input = fixture();
  input.current.sources.push({ ...source, content: "", startLine: 2, endLine: 2, partial: true });
  await retainReviewEvidence(input);
  expect(input.verifyCurrent).not.toHaveBeenCalled();
  expect(input.current.sources).toHaveLength(2);
});
it("invalidates only changed evidence and keeps unchanged helper evidence", async () => {
  const input = fixture();
  input.previous.sources.push({ ...source, path: "changed.ts" });
  input.verifyCurrent.mockImplementation(async (path) =>
    path === "helper.ts" ? source.fileSha256 : hash("changed"),
  );
  await retainReviewEvidence(input);
  expect(input.current.sources).toEqual([source]);
  expect(input.current.unavailable).toContain(
    "CURRENT:changed.ts: RETAINED_SOURCE_STALE_OR_UNVERIFIED",
  );
});
it("does not reuse unverified evidence when shared read/time quota is exhausted", async () => {
  const input = fixture();
  input.verifyCurrent.mockRejectedValue(Error("RETAINED_EVIDENCE_BUDGET_INSUFFICIENT"));
  await retainReviewEvidence(input);
  expect(input.current.sources).toEqual([]);
  expect(input.current.unavailable.join()).toContain("BUDGET_INSUFFICIENT");
  expect(input.findings[0]?.disposition).toBe("OPEN");
});
it("retains immutable baseline only for the same base and verified complete cache", async () => {
  const input = fixture();
  input.previous.sources[0] = { ...source, view: "BASELINE" };
  await retainReviewEvidence({
    ...input,
    cache: [{ key: "BASELINE:base:helper.ts", content, sha256: hash(content) }],
  });
  expect(input.current.sources[0]?.view).toBe("BASELINE");
  input.current.sources = [];
  await retainReviewEvidence({
    ...input,
    baselineRevision: "other",
    cache: [{ key: "BASELINE:base:helper.ts", content, sha256: hash(content) }],
  });
  expect(input.current.sources).toEqual([]);
});
it("rejects altered cached quotes and does not reconstruct missing evidence", async () => {
  const input = fixture();
  await retainReviewEvidence({
    ...input,
    cache: [{ key: "CURRENT:1:helper.ts", content: "fake", sha256: hash(content) }],
  });
  expect(input.current.sources).toEqual([]);
});
it("preserves cancellation and does not read evidence for closed findings", async () => {
  const input = fixture();
  await retainReviewEvidence({ ...input, findings: [{ ...finding, disposition: "DEFERRED" }] });
  expect(input.verifyCurrent).not.toHaveBeenCalled();
  await expect(
    retainReviewEvidence({ ...input, signal: AbortSignal.abort(Error("cancel")) }),
  ).rejects.toThrow("cancel");
});
