import { describe, expect, it } from "vitest";

import type { CommandResult } from "@devflow/sandbox";

import {
  buildRepositoryComplexityProfile,
  buildReviewContext,
  testResultFingerprint,
} from "../src/runs/workflow-context.js";

const STRUCTURED_CONTEXT_MAX_BYTES = 176 * 1_024;

describe("workflow context bounds and fingerprints", () => {
  it("ignores nondeterministic command duration in the test fingerprint", () => {
    const first = commandResult({ durationMs: 12 });
    const later = commandResult({ durationMs: 98_765 });

    expect(testResultFingerprint(first)).toBe(testResultFingerprint(later));
    expect(testResultFingerprint(commandResult({ stdout: "different output" }))).not.toBe(
      testResultFingerprint(first),
    );
  });

  it("bounds Review context by UTF-8 bytes for multibyte evidence", () => {
    const context = buildReviewContext({
      title: "修复审查 🔍".repeat(10_000),
      description: "描述测试与变更 🧪".repeat(10_000),
      plan: { steps: ["计划步骤 🛠️".repeat(20_000)] },
      test: commandResult({
        stdout: "测试输出通过 ✅".repeat(20_000),
        stderr: "诊断信息 ⚠️".repeat(20_000),
      }),
      diff: "变更内容 🐛".repeat(40_000),
    });

    expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(STRUCTURED_CONTEXT_MAX_BYTES);
    expect(context).toContain("...[truncated]");
  });

  it("profiles repository signals used by the existing PLAN call", () => {
    const profile = buildRepositoryComplexityProfile(
      [
        { path: "apps/web/next.config.ts", kind: "FILE", sizeBytes: 100 },
        { path: "apps/web/src/login-form.tsx", kind: "FILE", sizeBytes: 2_000 },
        { path: "apps/web/tests/login-form.test.tsx", kind: "FILE", sizeBytes: 3_000 },
        { path: "packages/database/prisma/schema.prisma", kind: "FILE", sizeBytes: 1_000 },
        { path: "node_modules/ignored.js", kind: "FILE", sizeBytes: 9_999 },
      ],
      {
        task: { title: "Fix login form", description: "Repair login validation" },
      },
    );

    expect(profile).toMatchObject({
      availability: "COMPLETE",
      fileCount: 4,
      totalBytes: 6_100,
      relevantFileCount: 2,
      testAvailability: "AVAILABLE",
      moduleCount: 2,
    });
    expect(profile.languageIndicators).toContain("TypeScript/React");
    expect(profile.frameworkIndicators).toEqual(expect.arrayContaining(["Next.js", "Prisma"]));
  });
});

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 1,
    stdout: "same stdout",
    stderr: "same stderr",
    durationMs: 10,
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  };
}
