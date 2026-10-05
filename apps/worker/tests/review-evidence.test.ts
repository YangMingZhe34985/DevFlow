import { describe, expect, it, vi } from "vitest";
import { readFileContent, type SandboxSession } from "@devflow/sandbox";
import { collectReviewEvidence, assessReview, REVIEW_PROMPT } from "../src/runs/review-evidence.js";
import { buildReviewContext } from "../src/runs/workflow-context.js";

describe("current source supports independent Review", () => {
  it("includes unchanged behavior near the hunk, revision, full SHA and protected-test policy", async () => {
    const content =
      "// prefix\n".repeat(150) +
      "const minutes = hours * 60 + seconds / 60;\n" +
      "payload.value[keyResult.value as PropertyKey] = result.value;\n";
    const readFile = vi.fn(async (input) => readFileContent(Buffer.from(content), input));
    const evidence = await collectReviewEvidence({
      sandbox: { readFile } as unknown as SandboxSession,
      diff: "diff --git a/source.ts b/source.ts\n+++ b/source.ts\n@@ -150 +150 @@\n-old\n+new",
      plan: { summary: "Fix", steps: [{ id: "1", title: "Fix", description: "Fix" }] },
      workspaceRevision: 2,
      policy: { protectTests: true, protectedPaths: ["private-oracle-secret.ts"] },
      signal: new AbortController().signal,
    });
    const context = buildReviewContext({
      title: "Fix",
      description: "Keep behavior",
      plan: {},
      diff: "patch",
      sourceEvidence: evidence,
      test: {
        exitCode: 0,
        stdout: "regressions passed",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        outputTruncated: false,
      },
    });
    expect(context).toContain("seconds / 60");
    expect(context).toContain("keyResult.value as PropertyKey");
    expect(context).toContain('"workspaceRevision":2');
    expect(context).toContain('"protectTests":true');
    expect(context).not.toContain("private-oracle-secret");
    expect(evidence.sources[0]?.fileSha256).toMatch(/^[a-f0-9]{64}$/u);
    const legitimate = assessReview(
      {
        verdict: "FAIL",
        summary: "Wrong conversion",
        issues: [
          {
            severity: "high",
            message: "A minute input is treated as hours",
            evidence: { path: "source.ts", quote: "hours * 60" },
          },
        ],
      },
      evidence,
    );
    expect(legitimate.approved).toBe(false);
    expect(legitimate.findings[0]?.evidenceStatus).toBe("SOURCE_LINKED");
    const invented = assessReview(
      {
        verdict: "PASS",
        summary: "Conflicting verdict",
        issues: [
          {
            severity: "high",
            message: "Claim missing seconds",
            evidence: { path: "source.ts", quote: "return hours;" },
          },
        ],
      },
      evidence,
    );
    expect(invented.approved).toBe(false);
    expect(invented.findings[0]?.evidenceStatus).toBe("UNVERIFIED");
    expect(REVIEW_PROMPT).toContain(
      "absence of a newly edited protected test alone is not a code defect",
    );
  });
  it("never reads hidden evaluation paths and stays within its host read budget", async () => {
    const readFile = vi.fn(async (input) => readFileContent(Buffer.from("x\n".repeat(800)), input));
    const diff =
      Array.from(
        { length: 10 },
        (_, i) => `diff --git a/a${i}.ts b/a${i}.ts\n+++ b/a${i}.ts\n@@ -200 +200 @@`,
      ).join("\n") +
      "\ndiff --git a/hidden-acceptance/test.ts b/hidden-acceptance/test.ts\n+++ b/hidden-acceptance/test.ts\n@@ -1 +1 @@";
    const evidence = await collectReviewEvidence({
      sandbox: { readFile } as unknown as SandboxSession,
      diff,
      plan: { summary: "Fix", steps: [] },
      workspaceRevision: 1,
      policy: {},
      signal: new AbortController().signal,
    });
    expect(evidence.toolExecutions).toBeLessThanOrEqual(6);
    expect(readFile.mock.calls.some(([input]) => input.path.includes("hidden"))).toBe(false);
    expect(
      evidence.sources.reduce((n, s) => n + Buffer.byteLength(s.content), 0),
    ).toBeLessThanOrEqual(48 * 1024);
  });
});
