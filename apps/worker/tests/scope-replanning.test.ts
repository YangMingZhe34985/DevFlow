import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DevflowError } from "@devflow/shared";
import type { SandboxSession } from "@devflow/sandbox";
import {
  captureReplanCandidate,
  restoreReplanCandidate,
  ScopeReplanStateSchema,
  verifiedReplanPaths,
} from "../src/runs/scope-replanning.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture(current: Record<string, string>, baseline: Record<string, string>) {
  const writeFile = vi.fn(async (input) => {
    current[input.path] = input.content;
    return { path: input.path, sha256: sha(input.content), sizeBytes: input.content.length };
  });
  const readFile = vi.fn(async (input) => {
    if (!(input.path in current)) throw new DevflowError({ code: "NOT_FOUND", message: "missing" });
    return {
      path: input.path,
      content: current[input.path],
      fileSha256: sha(current[input.path]!),
      truncated: false,
    };
  });
  const exec = vi.fn(async (input) => {
    let stdout = "a".repeat(40),
      stderr = "",
      exitCode = 0;
    if (input.args[0] === "status") stdout = "## main\0";
    if (input.args[0] === "show") {
      const path = input.args[1].slice(41);
      if (path in baseline) stdout = baseline[path]!;
      else {
        exitCode = 128;
        stdout = "";
        stderr = `fatal: path '${path}' does not exist in HEAD`;
      }
    }
    if (input.program === "node") delete current[input.args.at(-1)];
    return { stdout, stderr, exitCode, durationMs: 0, timedOut: false, outputTruncated: false };
  });
  return {
    sandbox: { readFile, writeFile, exec } as unknown as SandboxSession,
    writeFile,
    current,
  };
}
describe("scope replanning authority and recoverable candidate", () => {
  it("requires a new implementation path independently confirmed by public diagnostics", () => {
    const log = "src/wrapper.py:12: in run\nsrc/registry.py:115: in lookup_execution";
    expect(
      verifiedReplanPaths(
        ["src/registry.py", "src/invented.py"],
        log,
        ["src/wrapper.py"],
        () => true,
      ),
    ).toEqual(["src/registry.py"]);
    expect(
      verifiedReplanPaths(
        ["tests/test_registry.py"],
        "tests/test_registry.py:4: error",
        [],
        () => false,
      ),
    ).toEqual([]);
  });
  it("round trips modified, new and deleted files with exact CRLF bytes", async () => {
    const baseline = { "old.ts": "old\r\n", "deleted.ts": "remove\n" };
    const before = fixture({ "old.ts": "new\r\n", "new.ts": "created\n" }, baseline);
    const candidate = await captureReplanCandidate({
      sandbox: before.sandbox,
      paths: ["old.ts", "new.ts", "deleted.ts"],
      baseCommitSha: "a".repeat(40),
      signal: AbortSignal.timeout(10_000),
      beforeRead: () => {},
    });
    const state = ScopeReplanStateSchema.parse({
      version: 1,
      used: 1,
      status: "WAITING_APPROVAL",
      previousApprovalId: "old-approval",
      baseCommitSha: "a".repeat(40),
      repairAttempts: 1,
      reviewAttempts: 0,
      reason: "scope",
      diagnostic: "failure",
      candidatePaths: ["registry.ts"],
      ...candidate,
    });
    const after = fixture({ ...baseline }, baseline);
    await restoreReplanCandidate({
      state,
      sandbox: after.sandbox,
      oldApprovedPaths: ["old.ts", "new.ts", "deleted.ts"],
      signal: AbortSignal.timeout(10_000),
      beforeRead: () => {},
    });
    expect(after.current).toEqual(before.current);
    expect(ScopeReplanStateSchema.parse(JSON.parse(JSON.stringify(state))).used).toBe(1);
    expect(state.repairAttempts).toBe(1);
  });
  it("validates all scope and source identities before any restore write", async () => {
    const state = ScopeReplanStateSchema.parse({
      version: 1,
      used: 1,
      status: "WAITING_APPROVAL",
      previousApprovalId: "old",
      baseCommitSha: "a".repeat(40),
      repairAttempts: 1,
      reviewAttempts: 0,
      reason: "scope",
      diagnostic: "fail",
      candidatePaths: ["b.ts"],
      files: [
        { path: "a.ts", baselineSha256: sha("old"), currentSha256: sha("new"), content: "new" },
      ],
      patchSha256: "0".repeat(64),
    });
    const f = fixture({ "a.ts": "old" }, { "a.ts": "old" });
    await expect(
      restoreReplanCandidate({
        state,
        sandbox: f.sandbox,
        oldApprovedPaths: ["a.ts"],
        signal: AbortSignal.timeout(10_000),
        beforeRead: () => {},
      }),
    ).rejects.toThrow("IDENTITY_MISMATCH");
    expect(f.writeFile).not.toHaveBeenCalled();
  });
});
