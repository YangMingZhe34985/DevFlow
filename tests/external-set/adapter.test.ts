import { describe, expect, it } from "vitest";
import {
  adaptPublic,
  protectedPath,
  type ExternalRecord,
} from "../../scripts/v4/external-set/adapter.js";
import { auditBoundary, mapOfficial } from "../../scripts/v4/external-set/scoring.js";

const record: ExternalRecord = {
  instance_id: "org__repo-1",
  repo: "org/repo",
  base_commit: "a".repeat(40),
  problem_statement: "Public issue",
  patch: "PRIVATE_GOLD",
  test_patch: "PRIVATE_TEST",
  eval_script: "PRIVATE_EVAL",
  FAIL_TO_PASS: ["hidden-new"],
  PASS_TO_PASS: ["hidden-old"],
};
const identity = {
  caseId: "X11",
  dataset: "dataset",
  revision: "b".repeat(40),
  imageId: "sha256:" + "c".repeat(64),
  snapshotSha256: "d".repeat(64),
};
const report = {
  resolved: true,
  patch_successfully_applied: true,
  tests_status: {
    FAIL_TO_PASS: { success: ["new"], failure: [] },
    PASS_TO_PASS: { success: ["old"], failure: [] },
  },
};
const expected = { f2p: ["new"], p2p: ["old"] };
const integrity = {
  nonemptyPatch: true,
  protectedChanges: [],
  network: "none",
  durationSeconds: 10,
};
describe("external material boundary", () => {
  it("maps only public issue and frozen identities, not hidden material or hints", () => {
    const output = JSON.stringify(
      adaptPublic({ ...record, hints_text: "PRIVATE_HINT" } as ExternalRecord, identity),
    );
    for (const value of [
      "PRIVATE_GOLD",
      "PRIVATE_TEST",
      "PRIVATE_EVAL",
      "PRIVATE_HINT",
      "hidden-new",
      "hidden-old",
    ])
      expect(output).not.toContain(value);
    expect(JSON.parse(output).task.description).toBe("Public issue");
  });
  it("refuses unfrozen identities", () =>
    expect(() => adaptPublic(record, { ...identity, imageId: "latest" })).toThrow());
  it("protects tests/config and unsafe paths without exposing private test names", () => {
    for (const p of [
      "tests/foo.py",
      "src/__tests__/x.ts",
      "buildScripts/tests.ant.xml",
      "package.json",
      "testing/test_example.py",
      "conftest.py",
      "requirements-test.txt",
      "vitest.config.ts",
      "../src/a.ts",
      ".git/config",
    ])
      expect(protectedPath(p)).toBeTruthy();
    expect(protectedPath("src/module.ts")).toBeUndefined();
  });
});
describe("official scoring", () => {
  it("maps P2P to baseline and F2P to core; reproduction stays unconfigured", () => {
    const result = mapOfficial(report, expected, integrity);
    expect(result.strictPatchPass).toBe(true);
    expect(result.baseline.status).toBe("PASS");
    expect(result.core.status).toBe("PASS");
    expect(result.reproduction.status).toBe("NOT_CONFIGURED");
  });
  it("does not trust resolved when observations are missing", () => {
    expect(mapOfficial({ ...report, tests_status: {} }, expected, integrity).strictPatchPass).toBe(
      false,
    );
  });
  it.each([
    { nonemptyPatch: false },
    { protectedChanges: ["tests/foo.py"] },
    { durationSeconds: 301 },
    { network: "bridge" },
  ])("rejects invalid candidate integrity %j", (change) => {
    expect(mapOfficial(report, expected, { ...integrity, ...change }).strictPatchPass).toBe(false);
  });
  it("does not let duplicate or contradictory successes hide a failure", () => {
    expect(
      mapOfficial(
        {
          ...report,
          tests_status: {
            ...report.tests_status,
            FAIL_TO_PASS: { success: ["new", "new"], failure: ["new"] },
          },
        },
        expected,
        integrity,
      ).strictPatchPass,
    ).toBe(false);
  });
});
describe("leak audit requirements", () => {
  const valid = {
    flattened: true,
    gitRoots: ["workspace"],
    distinctTrees: 1,
    privateMatches: 0,
    imageId: "immutable",
    auditedImageId: "immutable",
    network: "none",
    user: "10001",
  };
  it("accepts only the audited isolated single-base image", () =>
    expect(auditBoundary(valid)).toBe(true));
  it.each([
    { flattened: false },
    { distinctTrees: 2 },
    { privateMatches: 1 },
    { auditedImageId: "other" },
    { gitRoots: ["workspace", "testbed"] },
    { user: "0" },
  ])("rejects %j", (change) => expect(auditBoundary({ ...valid, ...change })).toBe(false));
});
