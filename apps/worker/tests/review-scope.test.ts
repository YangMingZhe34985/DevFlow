import { describe, expect, it } from "vitest";
import { assessReview, type ReviewEvidence } from "../src/runs/review-evidence.js";

const behavior = {
  scenario: "convert(60)",
  expected: "1",
  actual: "3600",
  requirementBasis: "PUBLIC_API" as const,
  requirement: "Convert seconds to minutes",
};
const evidence: ReviewEvidence = {
  task: { title: "Fix small inputs", description: "convert(0.5) should succeed" },
  baselineRevision: "b".repeat(40),
  workspaceRevision: 2,
  policy: {},
  unavailable: [],
  toolExecutions: 0,
  toolLatencyMs: 0,
  sources: [
    {
      path: "source.ts",
      content: "return seconds * 60;",
      fileSha256: "a".repeat(64),
      startLine: 1,
      partial: false,
    },
    {
      path: "source.ts",
      content: "return seconds * 60;",
      fileSha256: "b".repeat(64),
      startLine: 1,
      partial: false,
      view: "BASELINE",
    },
  ],
};
const issue = {
  severity: "high" as const,
  kind: "DEFECT" as const,
  message: "Wrong units",
  behavior,
  evidence: { path: "source.ts", quote: "seconds * 60" },
};
describe("Review task scope adjudication", () => {
  it("defers an evidenced unrelated preexisting defect and retains it when omitted", () => {
    const result = assessReview(
      {
        verdict: "FAIL",
        summary: "An extra boundary fails",
        issues: [
          {
            ...issue,
            scopeAssessment: {
              category: "PREEXISTING_UNRELATED",
              explanation:
                "This existing large-input failure is outside the reported small-input issue",
              baselineEvidence: issue.evidence,
            },
          },
        ],
      },
      evidence,
    );
    expect(result).toMatchObject({
      approved: true,
      decision: "PASS",
      findings: [
        { kind: "DEFECT", disposition: "DEFERRED", blocking: false, blockingReason: "NONE" },
      ],
    });
    expect(
      assessReview(
        { verdict: "PASS", summary: "Task repaired", issues: [] },
        { ...evidence, findingHistory: result.findings },
      ).findings,
    ).toEqual(result.findings);
  });
  it("does not defer the reported Issue merely because it is preexisting", () => {
    const result = assessReview(
      {
        verdict: "FAIL",
        summary: "Small input still fails",
        issues: [
          {
            ...issue,
            scopeAssessment: {
              category: "ISSUE_UNRESOLVED",
              explanation: "The reported example remains broken",
              taskQuote: "convert(0.5) should succeed",
            },
          },
        ],
      },
      evidence,
    );
    expect(result).toMatchObject({
      approved: false,
      decision: "FAIL",
      findings: [{ disposition: "CONFIRMED", blockingReason: "ISSUE_UNRESOLVED" }],
    });
  });
  it("requires baseline provenance for regression and deferral, and task quote provenance", () => {
    for (const category of ["PATCH_REGRESSION", "PREEXISTING_UNRELATED"] as const) {
      const output = {
        verdict: "FAIL" as const,
        summary: "Compare",
        issues: [
          {
            ...issue,
            scopeAssessment: {
              category,
              explanation: "The current/base comparison establishes this",
              baselineEvidence: { path: "source.ts", quote: "invented" },
            },
          },
        ],
      };
      expect(assessReview(output, evidence).decision).toBe("NEEDS_EVIDENCE");
      expect(
        assessReview(
          {
            ...output,
            issues: [
              {
                ...output.issues[0]!,
                scopeAssessment: {
                  ...output.issues[0]!.scopeAssessment,
                  baselineEvidence: issue.evidence,
                },
              },
            ],
          },
          evidence,
        ).decision,
      ).toBe(category === "PATCH_REGRESSION" ? "FAIL" : "PASS");
    }
    expect(
      assessReview(
        {
          verdict: "FAIL",
          summary: "Invented requirement",
          issues: [
            {
              ...issue,
              scopeAssessment: {
                category: "ISSUE_UNRESOLVED",
                explanation: "Claim",
                taskQuote: "all unrelated functionality must be fixed",
              },
            },
          ],
        },
        evidence,
      ).decision,
    ).toBe("NEEDS_EVIDENCE");
  });
  it("keeps legacy public-API claims unresolved until task scope is established", () => {
    const old = assessReview({ verdict: "FAIL", summary: "Old report", issues: [issue] }, evidence);
    expect(old).toMatchObject({
      decision: "NEEDS_EVIDENCE",
      findings: [{ blocking: true, blockingReason: "SCOPE_UNDETERMINED" }],
    });
    expect(
      assessReview(
        { verdict: "PASS", summary: "Omitted", issues: [] },
        { ...evidence, findingHistory: old.findings },
      ).approved,
    ).toBe(false);
  });
  it("does not use missing implementation slices, protected-test suggestions or forged quotes as defects", () => {
    expect(
      assessReview(
        {
          verdict: "PASS",
          summary: "Suggestion",
          issues: [{ ...issue, kind: "SUGGESTION", message: "Add protected test" }],
        },
        evidence,
      ).approved,
    ).toBe(true);
    expect(
      assessReview(
        {
          verdict: "FAIL",
          summary: "Placeholder never finalized",
          issues: [
            {
              ...issue,
              evidence: { path: "source.ts", quote: "missing finalization" },
              scopeAssessment: {
                category: "ISSUE_UNRESOLVED",
                explanation: "Only a partial window was observed",
              },
            },
          ],
        },
        evidence,
      ).decision,
    ).toBe("NEEDS_EVIDENCE");
  });
});
