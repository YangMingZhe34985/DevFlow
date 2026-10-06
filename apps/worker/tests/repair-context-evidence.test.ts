import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "@devflow/sandbox";
import type { SandboxGitService } from "@devflow/git";
import { buildRepairContext, readRepairEvidence } from "../src/runs/workflow-context.js";
import { hash } from "../src/localization/contracts.js";
import { prepareStageContext } from "@devflow/agent";
import { createTools } from "../src/runs/approval-workflow-run-executor.js";

describe("bounded Repair input with recoverable public evidence", () => {
  it("prioritizes diagnostic line 2357 over the first hunk, and keeps tasks separate from old SHA", async () => {
    const git = {
      status: async () => ({ files: [{ path: "packages/zod/src/v4/core/schemas.ts" }] }),
      diff: async () => ({
        patch:
          "diff --git a/packages/zod/src/v4/core/schemas.ts b/packages/zod/src/v4/core/schemas.ts\n+++ b/packages/zod/src/v4/core/schemas.ts\n@@ -12 +12 @@\n-old\n+new",
        filesChanged: 1,
        truncated: false,
      }),
    } as unknown as SandboxGitService;
    const readFile = vi.fn(async (input) => ({
      path: input.path,
      content: "const primitive: Primitive = value;",
      startLine: input.startLine,
      endLine: input.startLine,
      fileSha256: "a".repeat(64),
      truncated: true,
    }));
    const extra =
      "Findings:\n" +
      JSON.stringify([
        {
          findingId: "finding-one",
          message: "Preserve Primitive type",
          behavior: { requirement: "API" },
          evidence: { quote: "old", fileSha256: "a".repeat(64) },
        },
      ]);
    const context = await buildRepairContext(
      git,
      { readFile } as unknown as SandboxSession,
      {
        exitCode: 1,
        stdout:
          "src/v4/core/schemas.ts(2357,9): error TS2322: Type unknown is not assignable to Primitive.",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        outputTruncated: false,
      },
      new AbortController().signal,
      extra,
    );
    expect(readFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "packages/zod/src/v4/core/schemas.ts", startLine: 2349 }),
      expect.any(AbortSignal),
    );
    expect(context.stableTaskContext).toContain("finding-one");
    expect(context.stableTaskContext).toContain("TS2322");
    expect(context.stableTaskContext).not.toContain("a".repeat(64));
  });
  it("rejects unknown or changed SHA, unknown sections and out-of-range recovery, and caps returned bytes", () => {
    const evidence = {
      version: "repair-evidence-v1" as const,
      sections: { stdout: "line\n".repeat(5000) },
    };
    const input = {
      sha256: hash(JSON.stringify(evidence)),
      section: "stdout",
      startLine: 1,
      endLine: 300,
    };
    expect(readRepairEvidence(input, evidence)).toMatchObject({
      historical: true,
      artifactSha256: input.sha256,
    });
    expect(Buffer.byteLength(readRepairEvidence(input, evidence).content)).toBeLessThanOrEqual(
      8192,
    );
    expect(() => readRepairEvidence(input, undefined)).toThrow("unavailable");
    expect(() => readRepairEvidence({ ...input, sha256: "0".repeat(64) }, evidence)).toThrow(
      "hash",
    );
    expect(() => readRepairEvidence({ ...input, section: "private" }, evidence)).toThrow("Unknown");
    expect(() => readRepairEvidence({ ...input, endLine: 301 }, evidence)).toThrow();
  });
  it("reads the changed hunk, keeps the exact failing assertion and immutable full evidence", async () => {
    const patch =
      "diff --git a/core.ts b/core.ts\n--- a/core.ts\n+++ b/core.ts\n@@ -3502,1 +3502,1 @@\n-old\n+new\n" +
      " padding\n".repeat(15000);
    const stdout =
      " ✓ passing.test.ts (10 tests) 1ms\n".repeat(6000) +
      "FAIL defaults/prefaults\nExpected: default: hello\nReceived: missing default\nTests 1 failed | 3718 passed";
    const git = {
      status: vi.fn(async () => ({ files: [{ path: "core.ts" }] })),
      diff: vi.fn(async () => ({
        patch,
        filesChanged: 1,
        additions: 1,
        deletions: 1,
        truncated: false,
      })),
    } as unknown as SandboxGitService;
    const readFile = vi.fn(async (input) => ({
      path: input.path,
      content: "return innerDefault;\n",
      startLine: input.startLine,
      endLine: input.startLine,
      fileSha256: "a".repeat(64),
      truncated: true,
    }));
    const context = await buildRepairContext(
      git,
      { readFile } as unknown as SandboxSession,
      { exitCode: 1, stdout, stderr: "", durationMs: 1, outputTruncated: false, timedOut: false },
      new AbortController().signal,
      "Preserve approval; review found a regression.",
    );
    expect(readFile).toHaveBeenCalledWith(
      expect.objectContaining({ startLine: 3494, endLine: 3573 }),
      expect.any(AbortSignal),
    );
    expect(Buffer.byteLength(context.text)).toBeLessThan(24 * 1024);
    expect(context.text).toContain("Expected: default: hello");
    expect(context.text).toContain("3718 passed");
    expect(context.text).toContain("return innerDefault;");
    expect(context.currentSources[0]).toMatchObject({
      contentHash: "a".repeat(64),
      complete: false,
    });
    expect(context.evidence.sections.stdout).toBe(stdout);
    expect(context.evidence.sections.diff).toBe(patch);
    expect(context.evidenceSha256).toBe(hash(JSON.stringify(context.evidence)));
    const view = prepareStageContext({
      stage: "REPAIR",
      history: [
        { role: "SYSTEM", content: "Approved: core.ts" },
        { role: "USER", content: context.text },
      ],
      authoritative: { revision: 1, approved: ["core.ts"] },
    });
    expect(view.viewBytes).toBeLessThan(96000);
    expect(JSON.stringify(view.view)).toContain("regression");
  });
  it("registers evidence recovery only as READ and respects explicit disabled benchmark tools", () => {
    const recover = vi.fn();
    const allowed = createTools({} as SandboxGitService, undefined, undefined, recover);
    expect(allowed.tools.find((t) => t.name === "readEvidenceArtifact")).toMatchObject({
      readOnly: true,
      mutatesWorkspace: false,
    });
    const disabled = createTools(
      {} as SandboxGitService,
      { enabled: ["readFile"] } as never,
      undefined,
      recover,
    );
    expect(disabled.tools.some((t) => t.name === "readEvidenceArtifact")).toBe(false);
  });
});
