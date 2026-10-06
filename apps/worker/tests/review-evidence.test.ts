import { describe, expect, it, vi } from "vitest";
import { readFileContent, type SandboxSession } from "@devflow/sandbox";
import { collectReviewEvidence, assessReview, REVIEW_PROMPT } from "../src/runs/review-evidence.js";
import { buildReviewContext } from "../src/runs/workflow-context.js";

describe("current source supports independent Review", () => {
  it("pins current SHA-backed Repair counterevidence while dropping unrelated whole source rows", () => {
    const context = buildReviewContext({
      title: "Fix",
      description: "Public requirement",
      plan: {},
      diff: "diff",
      test: {
        exitCode: 0,
        stdout: "pass",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        outputTruncated: false,
      },
      sourceEvidence: {
        policy: {},
        repairResponse: {
          outcome: "CONTRADICTED",
          evidenceStatus: "CURRENT_SOURCE_LINKED",
          evidence: [{ path: "refutation.ts", quote: "return true", fileSha256: "a".repeat(64) }],
        },
        sources: [
          { path: "refutation.ts", content: "return true", fileSha256: "a".repeat(64) },
          { path: "irrelevant.ts", content: "x".repeat(70 * 1024) },
          { path: "latest.ts", content: "new relevant implementation" },
        ],
      },
    });
    const evidence = JSON.parse(
      context
        .split("Current source and host protection policy:\n")[1]!
        .split("\n\nTest evidence")[0]!,
    );
    expect(evidence.sources.map((s: { path: string }) => s.path)).toEqual([
      "refutation.ts",
      "latest.ts",
    ]);
  });
  it("requires reconciliation of passing probes and rejects stale probe provenance", () => {
    const behavior = {
      scenario: "Public reproduction",
      expected: "true",
      actual: "false",
      requirementBasis: "ISSUE" as const,
      requirement: "Return true",
    };
    const source = {
      path: "a.ts",
      content: "return true",
      fileSha256: "a".repeat(64),
      startLine: 1,
      partial: false,
    };
    const history = {
      findingId: "host-one",
      severity: "ERROR" as const,
      kind: "DEFECT" as const,
      message: "Fails reproduction",
    };
    const probe = {
      probeId: "probe-one",
      findingId: "host-one",
      view: "CURRENT" as const,
      revision: "2",
      status: "COMPLETED" as const,
      exitCode: 0,
      behaviorOutcome: "EXPECTATION_MET" as const,
      assertions: [{ ok: true, expected: "true", actual: "true" }],
      stdout: "assertion passed",
      stderr: "",
      durationMs: 1,
      outputTruncated: false,
      scriptSha256: "b".repeat(64),
      dependencyIdentity: "sha256:" + "c".repeat(64),
      sourceHashes: { "a.ts": "a".repeat(64) },
      cacheKey: "d".repeat(64),
      expectedObservation: "true",
      taskBasis: "Issue",
    };
    const evidence = {
      workspaceRevision: 2,
      policy: {},
      sources: [source],
      unavailable: [],
      toolExecutions: 0,
      toolLatencyMs: 0,
      findingHistory: [history],
      probes: [probe],
    };
    const issue = {
      findingId: "host-one",
      severity: "high" as const,
      kind: "DEFECT" as const,
      message: "Reproduction fails",
      behavior,
      evidence: { path: "a.ts", quote: "return true" },
    };
    expect(
      assessReview(
        {
          verdict: "FAIL",
          summary: "bad",
          issues: [
            {
              ...issue,
              probeAssessment: {
                probeId: "probe-one",
                conclusion: "CONFIRMED",
                explanation: "claim despite passing assertion",
              },
            },
          ],
        },
        evidence,
      ).decision,
    ).toBe("NEEDS_EVIDENCE");
    const withdrawn = {
      ...issue,
      disposition: "CONTRADICTED" as const,
      behavior: { ...behavior, actual: "true; assertion passed" },
      probeAssessment: {
        probeId: "probe-one",
        conclusion: "CONTRADICTED" as const,
        explanation: "Counterexample satisfies expected public behavior",
      },
    };
    expect(
      assessReview({ verdict: "PASS", summary: "withdrawn", issues: [withdrawn] }, evidence)
        .approved,
    ).toBe(true);
    expect(
      assessReview(
        { verdict: "PASS", summary: "stale", issues: [withdrawn] },
        { ...evidence, probes: [{ ...probe, revision: "1" }] },
      ).approved,
    ).toBe(false);
    expect(
      assessReview({ verdict: "PASS", summary: "omitted", issues: [] }, evidence).decision,
    ).toBe("NEEDS_EVIDENCE");
  });
  it("reads a complete small conversion file including helpers after the changed hunk", async () => {
    const content =
      "// prefix\n".repeat(150) +
      "export function process() {}\n" +
      "// between\n".repeat(200) +
      "function extractDefs(seen) { if (seen.cycle) makeRef(seen); }\n" +
      "function finalize() { return JSON.stringify(result); }\n";
    const readFile = vi.fn(async (input) => readFileContent(Buffer.from(content), input));
    const evidence = await collectReviewEvidence({
      sandbox: { readFile } as unknown as SandboxSession,
      diff: "diff --git a/source.ts b/source.ts\n+++ b/source.ts\n@@ -158 +158 @@",
      plan: { summary: "Fix", steps: [] },
      workspaceRevision: 2,
      policy: {},
      signal: new AbortController().signal,
    });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(evidence.sources[0]).toMatchObject({
      partial: false,
      content: expect.stringContaining("if (seen.cycle)"),
    });
    expect(evidence.sources[0]?.content).toContain("function finalize");
  });
  it("requires linked behavior for a defect, permits suggestions, and reuses host IDs across revisions", () => {
    const behavior = {
      scenario: "convert(60)",
      expected: "1",
      actual: "3600 from multiplication",
      requirementBasis: "ISSUE" as const,
      requirement: "Convert seconds to minutes",
    };
    const evidence = {
      workspaceRevision: 7,
      policy: {},
      sources: [
        {
          path: "source.ts",
          content: "return seconds * 60;",
          fileSha256: "a".repeat(64),
          startLine: 1,
          partial: false,
        },
      ],
      unavailable: [],
      toolExecutions: 1,
      toolLatencyMs: 0,
    };
    const issue = {
      severity: "high" as const,
      kind: "DEFECT" as const,
      message: "Wrong units",
      behavior,
      evidence: { path: "source.ts", quote: "seconds * 60" },
    };
    const first = assessReview({ verdict: "FAIL", summary: "Defect", issues: [issue] }, evidence);
    expect(first.decision).toBe("FAIL");
    const second = assessReview(
      {
        verdict: "FAIL",
        summary: "Same defect",
        issues: [{ ...issue, findingId: first.findings[0]!.findingId!, message: "Rephrased" }],
      },
      { ...evidence, workspaceRevision: 8, findingHistory: first.findings },
    );
    expect(second.findings[0]?.findingId).toBe(first.findings[0]?.findingId);
    const unsupported = assessReview(
      { verdict: "FAIL", summary: "Unknown", issues: [{ ...issue, behavior: undefined }] },
      evidence,
    );
    expect(unsupported.decision).toBe("NEEDS_EVIDENCE");
    expect(
      assessReview(
        { verdict: "PASS", summary: "Fine", issues: [{ ...issue, kind: "SUGGESTION" }] },
        evidence,
      ).approved,
    ).toBe(true);
    expect(
      assessReview(
        {
          verdict: "FAIL",
          summary: "Forged",
          issues: [{ ...issue, evidence: { path: "source.ts", quote: "not present" } }],
        },
        evidence,
      ).decision,
    ).toBe("NEEDS_EVIDENCE");
  });
  it("prunes oversized source rows as valid JSON while retaining Repair answers and newest evidence", () => {
    const context = buildReviewContext({
      title: "Fix",
      description: "Supported behavior",
      plan: {},
      diff: "patch",
      test: {
        exitCode: 0,
        stdout: "pass",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        outputTruncated: false,
      },
      sourceEvidence: {
        workspaceRevision: 5,
        policy: { protectTests: true, protectedPaths: ["private-oracle.ts"] },
        repairResponse: {
          summary: "Current branch contradicts finding",
          findingIds: ["finding-one"],
          outcome: "CONTRADICTED",
        },
        supplement: { used: true },
        sources: [
          { path: "old.ts", content: "x".repeat(70 * 1024) },
          { path: "current.ts", content: "return currentBehavior;" },
        ],
      },
    });
    const section = context
      .split("Current source and host protection policy:\n")[1]!
      .split("\n\nTest evidence")[0]!;
    const parsed = JSON.parse(section);
    expect(parsed.sources).toEqual([{ path: "current.ts", content: "return currentBehavior;" }]);
    expect(parsed.repairResponse.findingIds).toEqual(["finding-one"]);
    expect(parsed.omittedSourceRanges).toBe(1);
    expect(context).not.toContain("private-oracle.ts");
  });
  it("keeps missing evidence blocking, assigns finding IDs and preserves legacy approved", () => {
    const result = assessReview({
      verdict: "NEEDS_EVIDENCE",
      summary: "Need public behavior",
      evidenceRequests: [{ symbol: "convert", question: "Which units are supported?" }],
      issues: [{ severity: "medium", kind: "EVIDENCE_GAP", message: "API contract not observed" }],
    });
    expect(result).toMatchObject({
      approved: false,
      decision: "NEEDS_EVIDENCE",
      decisionReason: "MISSING_EVIDENCE",
    });
    expect(result.findings[0]?.findingId).toMatch(/^finding-[a-f0-9]{16}$/u);
    expect(
      assessReview({
        verdict: "PASS",
        summary: "Fine",
        issues: [],
        evidenceRequests: result.evidenceRequests,
      }).approved,
    ).toBe(false);
    expect(assessReview({ verdict: "PASS", summary: "Fine", issues: [] })).toMatchObject({
      approved: true,
      decision: "PASS",
    });
  });
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
