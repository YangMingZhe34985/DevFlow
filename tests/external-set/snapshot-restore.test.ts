import { describe, it, expect } from "vitest";
import { imageRestoreView } from "../../scripts/v4/external-set/snapshot-restore.js";
import type { LocalRepositorySnapshot } from "@devflow/sandbox";

const snapshot: LocalRepositorySnapshot = {
  version: 1,
  sourceHead: "a".repeat(40),
  totalBytes: 4,
  files: [
    {
      path: "a.py",
      kind: "FILE",
      mode: 420,
      sizeBytes: 1,
      sha256: "b".repeat(64),
      contentBase64: "YQ==",
    },
    {
      path: "link",
      kind: "SYMLINK",
      mode: 511,
      sizeBytes: 3,
      sha256: "c".repeat(64),
      target: "a.py",
    },
  ],
};
const identity = {
  imageId: "immutable",
  auditImageId: "immutable",
  sourceBaseCommit: snapshot.sourceHead,
  strongAuditPassed: true,
};
describe("audited image snapshot restoration", () => {
  it("keeps the full frozen input unchanged and restores regular files only", () => {
    const original = JSON.stringify(snapshot);
    const projected = imageRestoreView(snapshot, identity);
    expect(projected.files).toEqual([snapshot.files[0]]);
    expect(projected.totalBytes).toBe(1);
    expect(JSON.stringify(snapshot)).toBe(original);
  });
  it.each([
    { ...identity, strongAuditPassed: false },
    { ...identity, auditImageId: "stale" },
    { ...identity, sourceBaseCommit: "old" },
  ])("rejects unproven link reuse", (id) => {
    expect(() => imageRestoreView(snapshot, id)).toThrow();
  });
});
