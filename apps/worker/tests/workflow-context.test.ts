import { describe, expect, it, vi } from "vitest";

import { FakeGitHubProvider } from "@devflow/github";
import type { CommandResult } from "@devflow/sandbox";

import {
  buildGitHubRepositoryComplexityProfile,
  buildRepositoryComplexityProfile,
  buildPlanContext,
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

  it("bounds Plan context by UTF-8 bytes for multibyte task and feedback", () => {
    const context = buildPlanContext({
      title: "任务标题 🛠️".repeat(20_000),
      description: "需求描述 🧪".repeat(30_000),
      feedback: { reason: "审批反馈 🔍".repeat(20_000) },
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

    const context = buildPlanContext({
      title: "Fix login form",
      description: "Repair login validation",
      repositoryProfile: profile,
      hardLimit: 100,
    });
    expect(context).toContain('"relevantFileCount": 2');
    expect(context).toContain("cross-module dependencies");
    expect(context).toContain("100 steps");
  });

  it("profiles a GitHub repository for PLAN from the Task's pinned commit SHA", async () => {
    const baseCommitSha = "b".repeat(40);
    const provider = new FakeGitHubProvider({
      repositoryTree: {
        entries: [
          { path: "apps/web/next.config.ts", kind: "FILE", sizeBytes: 100 },
          { path: "apps/web/src/login-form.tsx", kind: "FILE", sizeBytes: 2_000 },
          { path: "apps/web/tests/login-form.test.tsx", kind: "FILE", sizeBytes: 3_000 },
          { path: "packages/database/prisma/schema.prisma", kind: "FILE", sizeBytes: 1_000 },
        ],
        truncated: true,
      },
    });

    const profile = await buildGitHubRepositoryComplexityProfile({
      provider,
      sourceUri: "https://github.com/devflow/fixture.git",
      baseCommitSha,
      task: { title: "Fix login form", description: "Repair login validation" },
    });

    expect(provider.repositoryTreeCalls).toEqual([
      { repository: { owner: "devflow", name: "fixture" }, baseCommitSha },
    ]);
    expect(profile).toMatchObject({
      availability: "TRUNCATED",
      fileCount: 4,
      totalBytes: 6_100,
      relevantFileCount: 2,
      testAvailability: "AVAILABLE",
      moduleCount: 2,
    });
    expect(profile.languageIndicators).toContain("TypeScript/React");
    expect(profile.frameworkIndicators).toEqual(expect.arrayContaining(["Next.js", "Prisma"]));
    const planContext = buildPlanContext({
      title: "Fix login form",
      description: "Repair login validation",
      repositoryProfile: profile,
    });
    expect(planContext).toContain('"availability": "TRUNCATED"');
    expect(planContext).toContain('"fileCount": 4');
  });

  it("degrades GitHub profile failures without leaking provider details into PLAN", async () => {
    const secret = "github_pat_platform_only_secret_1234567890";
    const readRepositoryTree = vi.fn(async () => {
      throw new Error(`upstream echoed ${secret}`);
    });

    const profile = await buildGitHubRepositoryComplexityProfile({
      provider: { readRepositoryTree },
      sourceUri: "https://github.com/devflow/fixture.git",
      baseCommitSha: "c".repeat(40),
      task: { title: "Fix login", description: "Repair login validation" },
    });

    expect(readRepositoryTree).toHaveBeenCalledOnce();
    expect(profile).toEqual({
      availability: "UNAVAILABLE",
      languageIndicators: [],
      frameworkIndicators: [],
      manifestFiles: [],
      testAvailability: "UNKNOWN",
      testIndicators: [],
    });
    expect(
      buildPlanContext({ title: "Fix login", description: "Repair", repositoryProfile: profile }),
    ).not.toContain(secret);
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
