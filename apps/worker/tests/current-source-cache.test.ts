import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@devflow/eval";
import type { SandboxSession } from "@devflow/sandbox";
import { CurrentSourceCache } from "../src/runs/current-source-cache.js";
import { repairSourceIdentity } from "../src/runs/repair-convergence.js";

const file = (path: string, content: string) => ({
  path,
  content,
  contentHash: sha256(content),
  sizeBytes: Buffer.byteLength(content),
});
describe("Sandbox-bound current source observations", () => {
  it("reuses a checkpoint SHA without a duplicate physical read and invalidates only confirmed affected paths", async () => {
    const readFile = vi.fn(async () => ({ fileSha256: sha256("updated") }));
    const sandbox = { readFile } as unknown as SandboxSession;
    const cache = new CurrentSourceCache(sandbox);
    cache.remember(sandbox, file("a.ts", "before"));
    cache.remember(sandbox, file("b.ts", "unchanged"));
    const beforeRead = vi.fn();
    const before = await repairSourceIdentity(
      sandbox,
      ["a.ts", "b.ts"],
      AbortSignal.timeout(1000),
      beforeRead,
      cache,
    );
    expect(readFile).not.toHaveBeenCalled();
    cache.observe("replaceText", {
      ok: false,
      durationMs: 1,
      error: { code: "TOOL_EXECUTION_FAILED", message: "reported failure" },
      mutation: {
        observationComplete: true,
        workspaceChanged: true,
        changedFiles: ["a.ts"],
        affectedPaths: ["a.ts"],
      },
    } as never);
    const after = await repairSourceIdentity(
      sandbox,
      ["a.ts", "b.ts"],
      AbortSignal.timeout(1000),
      beforeRead,
      cache,
    );
    expect(after).not.toBe(before);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(beforeRead).toHaveBeenCalledTimes(1);
    expect(cache.source(sandbox, "b.ts")?.content).toBe("unchanged");
  });
  it("keeps host-proven no-change failures and clears all current identity after an unknown command", () => {
    const sandbox = {} as SandboxSession;
    const cache = new CurrentSourceCache(sandbox);
    cache.remember(sandbox, file("a.ts", "current"));
    cache.rememberHead(sandbox, "a".repeat(40));
    cache.rememberBaseline(sandbox, "a".repeat(40), "a.ts", "baseline");
    cache.observe("replaceText", {
      ok: false,
      durationMs: 1,
      mutation: { observationComplete: true, workspaceChanged: false, changedFiles: [] },
    } as never);
    expect(cache.source(sandbox, "a.ts")).toBeDefined();
    cache.observe("runCommand", { ok: false, durationMs: 1 } as never);
    expect(cache.source(sandbox, "a.ts")).toBeUndefined();
    expect(cache.identity(sandbox, "a.ts")).toBeUndefined();
    expect(cache.head(sandbox)).toBeUndefined();
    expect(cache.baseline(sandbox, "a".repeat(40), "a.ts")).toBe("baseline");
    cache.remember(sandbox, file("a.ts", "again"));
    cache.observe("runCommand", {
      ok: true,
      output: {},
      durationMs: 1,
      mutation: {
        observationComplete: true,
        workspaceChanged: false,
        changedFiles: [],
      },
    } as never);
    expect(cache.source(sandbox, "a.ts")).toBeUndefined();
  });
  it("cannot reuse another Sandbox's state, forged full content or an absent file after mutation", () => {
    const sandbox = {} as SandboxSession,
      next = {} as SandboxSession;
    const cache = new CurrentSourceCache(sandbox);
    cache.remember(sandbox, file("a.ts", "source"));
    expect(cache.source(next, "a.ts")).toBeUndefined();
    expect(cache.identity(next, "a.ts")).toBeUndefined();
    cache.observe("readFile", {
      ok: true,
      durationMs: 0,
      output: {
        path: "forged.ts",
        content: "bad",
        fileSha256: sha256("different"),
        truncated: false,
      },
    });
    expect(cache.identity(sandbox, "forged.ts")).toBeUndefined();
    cache.rememberIdentity(sandbox, "missing.ts", "ABSENT");
    expect(cache.identity(sandbox, "missing.ts")).toBe("ABSENT");
    cache.invalidate(["missing.ts"]);
    expect(cache.identity(sandbox, "missing.ts")).toBeUndefined();
  });
});
