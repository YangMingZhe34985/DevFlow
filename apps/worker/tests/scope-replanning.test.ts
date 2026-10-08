import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DevflowError } from "@devflow/shared";
import type { SandboxSession } from "@devflow/sandbox";
import { ContinuationTools } from "../src/runs/continuation-tools.js";
import { repairSourceIdentity } from "../src/runs/repair-convergence.js";
import { CurrentSourceCache } from "../src/runs/current-source-cache.js";
import {
  captureReplanCandidate,
  projectCandidateChange,
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
    if (input.args[0] === "status")
      stdout = [...new Set([...Object.keys(current), ...Object.keys(baseline)])]
        .filter((p) => current[p] !== baseline[p])
        .map((p) => `${p in current ? (p in baseline ? " M" : "??") : " D"} ${p}\0`)
        .join("");
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
  it("captures once and reuses verified candidate identities without weakening restoration checks", async () => {
    const baseline = { "old.ts": "old\r\n", "deleted.ts": "remove\n" };
    const current = fixture({ "old.ts": "new\r\n", "added.ts": "created\n" }, baseline);
    const sourceCache = new CurrentSourceCache(current.sandbox);
    sourceCache.rememberHead(current.sandbox, "a".repeat(40));
    const beforeRead = vi.fn();
    const candidate = await captureReplanCandidate({
      sandbox: current.sandbox,
      paths: ["old.ts", "added.ts", "deleted.ts"],
      baseCommitSha: "a".repeat(40),
      signal: AbortSignal.timeout(1000),
      beforeRead,
      sourceCache,
    });
    expect(beforeRead).toHaveBeenCalledTimes(7); // status + 3 baseline/current pairs; HEAD already verified.
    const identityRead = vi.fn();
    await repairSourceIdentity(
      current.sandbox,
      ["old.ts", "added.ts", "deleted.ts"],
      AbortSignal.timeout(1000),
      identityRead,
      sourceCache,
    );
    expect(identityRead).not.toHaveBeenCalled();
    const repeatedRead = vi.fn();
    expect(
      await captureReplanCandidate({
        sandbox: current.sandbox,
        paths: ["old.ts", "added.ts", "deleted.ts"],
        baseCommitSha: "a".repeat(40),
        signal: AbortSignal.timeout(1000),
        beforeRead: repeatedRead,
        sourceCache,
      }),
    ).toEqual(candidate);
    expect(repeatedRead).toHaveBeenCalledTimes(1); // status remains necessary even with cached source.
    const restored = fixture({ ...baseline }, baseline);
    const restoredCache = new CurrentSourceCache(restored.sandbox);
    const restoreRead = vi.fn();
    await restoreReplanCandidate({
      sandbox: restored.sandbox,
      oldApprovedPaths: ["old.ts", "added.ts", "deleted.ts"],
      signal: AbortSignal.timeout(1000),
      beforeRead: restoreRead,
      sourceCache: restoredCache,
      state: ScopeReplanStateSchema.parse({
        version: 1,
        used: 1,
        status: "WAITING_APPROVAL",
        previousApprovalId: "approved",
        baseCommitSha: "a".repeat(40),
        repairAttempts: 1,
        reviewAttempts: 0,
        reason: "scope",
        diagnostic: "public failure",
        candidatePaths: [],
        ...candidate,
      }),
    });
    expect(restoreRead).toHaveBeenCalledTimes(11); // HEAD/status + baseline/read/write verification for all three records.
    const restoredIdentityRead = vi.fn();
    await repairSourceIdentity(
      restored.sandbox,
      ["old.ts", "added.ts", "deleted.ts"],
      AbortSignal.timeout(1000),
      restoredIdentityRead,
      restoredCache,
    );
    expect(restoredIdentityRead).not.toHaveBeenCalled();
    expect(restored.current).toEqual(current.current);
  });
  it("projects actual changed lines from already-read checkpoint sources without inventing a full-file diff", async () => {
    const head =
      Array.from({ length: 90 }, (_, i) => `const unchanged${i} = ${i};`).join("\n") + "\n";
    const tail = "\n" + Array.from({ length: 90 }, (_, i) => `const tail${i} = ${i};`).join("\n");
    const before = head + "return false;" + tail,
      after = head + "return true;" + tail;
    const projection = projectCandidateChange(before, after);
    expect(projection).toMatchObject({ startLine: 88, baselineEndLine: 94, currentEndLine: 94 });
    expect(projection.before).toContain("return false;");
    expect(projection.after).toContain("return true;");
    expect(projection.before).not.toContain("unchanged0");
    const current = fixture({ "state.ts": after }, { "state.ts": before });
    let io = 0;
    const checkpoint = await captureReplanCandidate({
      sandbox: current.sandbox,
      paths: ["state.ts"],
      baseCommitSha: "a".repeat(40),
      signal: new AbortController().signal,
      beforeRead: () => {
        io++;
      },
    });
    expect(io).toBe(4);
    expect(checkpoint.changeEvidence?.[0]).toEqual({
      path: "state.ts",
      baselineSha256: sha(before),
      currentSha256: sha(after),
      ...projection,
    });
    expect(projectCandidateChange("", "new\r\n").after).toBe("new\r\n");
    expect(projectCandidateChange("old\r\n", "").before).toBe("old\r\n");
  });
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
  it("reserves the real remaining checkpoint and identity IO after approved candidate restoration", async () => {
    const baseline = { "old.ts": "old\n", "deleted.ts": "remove\n", "untouched.ts": "same\n" };
    const current = fixture(
      { "old.ts": "new\n", "added.ts": "add\n", "untouched.ts": "same\n" },
      baseline,
    );
    const approved = ["old.ts", "deleted.ts", "added.ts", "untouched.ts"];
    const continuation = new ContinuationTools(approved);
    // The previous checkpoint already contains old.ts; continued coding adds/deletes two paths.
    continuation.changed.add("added.ts");
    continuation.changed.add("deleted.ts");
    const reserve = continuation.afterReplan(2, ["old.ts"]);
    let checkpointReads = 0;
    await captureReplanCandidate({
      sandbox: current.sandbox,
      paths: approved,
      baseCommitSha: "a".repeat(40),
      signal: AbortSignal.timeout(10_000),
      beforeRead: () => {
        checkpointReads++;
      },
    });
    let identityReads = 0;
    await repairSourceIdentity(current.sandbox, approved, AbortSignal.timeout(10_000), () => {
      identityReads++;
    });
    expect(checkpointReads).toBe(reserve.operations.checkpoint);
    expect(identityReads).toBe(reserve.operations.sourceIdentity);
    expect(reserve.total - checkpointReads - identityReads).toBe(2); // Review IO is internal execution, not logical tool calls.
    expect(reserve.operations).not.toHaveProperty("checkpointRestore");
    expect(reserve.operations).not.toHaveProperty("repairContext");
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
