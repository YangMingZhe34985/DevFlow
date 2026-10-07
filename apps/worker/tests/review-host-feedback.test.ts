import { expect, it } from "vitest";
import { ReviewResultSchema } from "@devflow/shared";
import { assessReview, REVIEW_PROMPT, type ReviewEvidence } from "../src/runs/review-evidence.js";
import { newReviewCorrections, reviewSupplementRequests } from "../src/runs/review-supplement.js";
const evidence: ReviewEvidence = {
  task: {
    title: "Shared default",
    description: "Using a Map default must not leak mutations into later parses.",
  },
  planInterpretation: { summary: "Deep-copy every mutable default including nested arrays" },
  workspaceRevision: 2,
  policy: {},
  unavailable: [],
  toolExecutions: 0,
  toolLatencyMs: 0,
  sources: [
    {
      path: "a.ts",
      content: "return [...value];",
      fileSha256: "a".repeat(64),
      startLine: 1,
      partial: false,
    },
    {
      path: "a.ts",
      content: "return value;",
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
  message: "Nested defaults leak",
  evidence: { path: "a.ts", quote: "return [...value];" },
  behavior: {
    scenario: "default([[]]); mutate first[0]",
    expected: "Second parse unchanged",
    actual: "Both share the nested array",
    requirementBasis: "ISSUE" as const,
    requirement: "Independent nested default",
  },
  scopeAssessment: {
    category: "ISSUE_UNRESOLVED" as const,
    explanation: "Nested defaults must be independent",
    taskQuote: evidence.planInterpretation!.summary,
  },
};
it("returns exact Plan/Issue source feedback without reading code or approving the candidate", () => {
  const r = assessReview({ verdict: "FAIL", summary: "Review", issues: [issue] }, evidence);
  expect(r).toMatchObject({
    approved: false,
    decision: "NEEDS_EVIDENCE",
    hostFeedback: [
      {
        category: "TASK_SCOPE",
        code: "TASK_QUOTE_FROM_PLAN",
        field: "scopeAssessment.taskQuote",
        value: issue.scopeAssessment.taskQuote,
      },
    ],
  });
  expect(
    reviewSupplementRequests({
      ...r,
      evidenceRequests: [{ path: "a.ts", question: "Read again" }],
    }),
  ).toEqual([]);
  const rows = newReviewCorrections(r, new Set());
  expect(rows).toHaveLength(1);
  expect(newReviewCorrections(r, new Set(rows.map((row) => row.key)))).toHaveLength(0);
  expect(REVIEW_PROMPT).toContain("not permission to add acceptance requirements");
  expect(ReviewResultSchema.parse(r).hostFeedback).toEqual(r.hostFeedback);
});
it("accepts a corrected task-related static defect without waiving Repair or the old finding", () => {
  const old = assessReview({ verdict: "FAIL", summary: "Review", issues: [issue] }, evidence);
  const current = {
    ...issue,
    findingId: old.findings[0]!.findingId,
    scopeAssessment: {
      ...issue.scopeAssessment,
      taskQuote: evidence.task!.description,
      explanation:
        "The mutation independence promise is the original task; the nested case also violates it",
    },
  };
  expect(
    assessReview(
      { verdict: "FAIL", summary: "Confirmed", issues: [current] },
      { ...evidence, findingHistory: old.findings },
    ),
  ).toMatchObject({
    approved: false,
    decision: "FAIL",
    findings: [{ disposition: "CONFIRMED", blocking: true }],
  });
  expect(
    assessReview(
      { verdict: "PASS", summary: "Omitted", issues: [] },
      { ...evidence, findingHistory: old.findings },
    ).approved,
  ).toBe(false);
});
it("allows an evidenced alternative scope decision but never silently defers an unmatched quote", () => {
  const current = {
    ...issue,
    scopeAssessment: {
      category: "PREEXISTING_UNRELATED" as const,
      explanation:
        "This additional nested-array behavior existed before the Map fix and is not part of the reported Map task",
      baselineEvidence: { path: "a.ts", quote: "return value;" },
    },
  };
  expect(
    assessReview({ verdict: "FAIL", summary: "Extra behavior", issues: [current] }, evidence),
  ).toMatchObject({ approved: true, findings: [{ disposition: "DEFERRED", blocking: false }] });
  const invalid = {
    ...current,
    scopeAssessment: { ...current.scopeAssessment, taskQuote: "Invented user requirement" },
  };
  expect(
    assessReview({ verdict: "FAIL", summary: "Extra behavior", issues: [invalid] }, evidence),
  ).toMatchObject({ approved: false, hostFeedback: [{ code: "TASK_QUOTE_MISMATCH" }] });
});
it("distinguishes missing source from missing behavior and remains compatible with old reports", () => {
  expect(
    assessReview(
      {
        verdict: "FAIL",
        summary: "Source",
        issues: [
          {
            ...issue,
            evidence: { path: "absent.ts", quote: "absent" },
            scopeAssessment: undefined,
          },
        ],
      },
      evidence,
    ).hostFeedback?.[0]?.category,
  ).toBe("SOURCE");
  expect(
    assessReview(
      {
        verdict: "FAIL",
        summary: "Behavior",
        issues: [{ ...issue, behavior: undefined, scopeAssessment: undefined }],
      },
      evidence,
    ).hostFeedback?.[0]?.category,
  ).toBe("BEHAVIOR");
  expect(
    ReviewResultSchema.parse({ approved: false, summary: "Historical", findings: [] }).hostFeedback,
  ).toBeUndefined();
});

it.each(["\n", "\r\n", "  ", "\t"])(
  "matches task whitespace %j without waiving evidence or scope",
  (space) => {
    const description = "Preserve caller spelling" + space + "in successful history.";
    const current = {
      ...issue,
      kind: "EVIDENCE_GAP" as const,
      scopeAssessment: {
        ...issue.scopeAssessment,
        taskQuote: "Preserve caller spelling in successful history.",
      },
    };
    const result = assessReview(
      {
        verdict: "NEEDS_EVIDENCE",
        summary: "Need history source",
        issues: [current],
        evidenceRequests: [{ path: "history.py", question: "Show persistence" }],
      },
      { ...evidence, task: { title: "Alias execution", description } },
    );
    expect(result.approved).toBe(false);
    expect(result.hostFeedback?.some((f) => f.category === "TASK_SCOPE") ?? false).toBe(false);
    expect(reviewSupplementRequests(result)).toHaveLength(1);
  },
);
it("retains original offsets and does not accept paraphrases or normalize source citations", async () => {
  const { matchTaskQuote } = await import("../src/runs/task-quote.js");
  const text = "prefix. Preserve caller\r\n  spelling. suffix";
  const match = matchTaskQuote(text, "Preserve caller spelling.")!;
  expect(text.slice(match.start, match.end)).toBe("Preserve caller\r\n  spelling.");
  expect(matchTaskQuote(text, "Preserve canonical spelling.")).toBeUndefined();
  expect(matchTaskQuote(text, "   ")).toBeUndefined();
  const result = assessReview(
    {
      verdict: "FAIL",
      summary: "Code citation differs",
      issues: [
        {
          ...issue,
          scopeAssessment: undefined,
          evidence: { path: "a.ts", quote: "return  [...value];" },
        },
      ],
    },
    evidence,
  );
  expect(result.findings[0]?.evidenceStatus).not.toBe("SOURCE_LINKED");
});

it("routes acknowledged source gaps to supplement without demanding a hypothetical failure", () => {
  const gap = {
    ...issue,
    kind: "EVIDENCE_GAP" as const,
    behavior: undefined,
    scopeAssessment: undefined,
  };
  const result = assessReview(
    {
      verdict: "NEEDS_EVIDENCE",
      summary: "Normalization implementation unknown",
      issues: [gap],
      evidenceRequests: [
        { path: "identity.py", symbol: "canonical", question: "Show normalization" },
      ],
    },
    evidence,
  );
  expect(result).toMatchObject({
    approved: false,
    decision: "NEEDS_EVIDENCE",
    hostFeedback: [{ category: "SOURCE", code: "ESSENTIAL_SOURCE_EVIDENCE_MISSING" }],
  });
  expect(reviewSupplementRequests(result)[0]?.path).toBe("identity.py");
  expect(newReviewCorrections(result, new Set())).toEqual([]);
  expect(
    assessReview(
      { verdict: "PASS", summary: "Omitted gap", issues: [] },
      { ...evidence, findingHistory: result.findings },
    ).approved,
  ).toBe(false);
});
it("does not make an unknown gap scope a reference correction before source collection", () => {
  const gap = {
    ...issue,
    kind: "EVIDENCE_GAP" as const,
    scopeAssessment: { category: "UNDETERMINED" as const, explanation: "Missing caller source" },
  };
  const result = assessReview(
    {
      verdict: "NEEDS_EVIDENCE",
      summary: "Caller unknown",
      issues: [gap],
      evidenceRequests: [{ symbol: "caller", question: "Read caller" }],
    },
    evidence,
  );
  expect(reviewSupplementRequests(result)).toHaveLength(1);
  expect(result.hostFeedback?.[0]?.category).toBe("SOURCE");
  expect(result.approved).toBe(false);
});
it("keeps genuine defect and invalid task corrections strict alongside gaps", () => {
  const gap = {
    ...issue,
    kind: "EVIDENCE_GAP" as const,
    behavior: undefined,
    scopeAssessment: undefined,
  };
  const defect = { ...issue, behavior: undefined, scopeAssessment: undefined };
  const mixed = assessReview(
    {
      verdict: "NEEDS_EVIDENCE",
      summary: "Mixed",
      issues: [gap, defect],
      evidenceRequests: [{ path: "identity.py", question: "Read" }],
    },
    evidence,
  );
  expect(mixed.hostFeedback?.map((f) => f.category)).toEqual(["SOURCE", "BEHAVIOR"]);
  expect(mixed.approved).toBe(false);
  const forged = assessReview(
    {
      verdict: "NEEDS_EVIDENCE",
      summary: "Forged task",
      issues: [{ ...gap, scopeAssessment: issue.scopeAssessment }],
    },
    evidence,
  );
  expect(forged.hostFeedback?.[0]?.code).toBe("TASK_QUOTE_FROM_PLAN");
  const invalidSource = assessReview(
    {
      verdict: "NEEDS_EVIDENCE",
      summary: "Forged code",
      issues: [{ ...gap, evidence: { path: "a.ts", quote: "invented" } }],
    },
    evidence,
  );
  expect(invalidSource.findings[0]?.evidenceStatus).toBe("UNVERIFIED");
  expect(invalidSource.approved).toBe(false);
});

it("preserves legacy NEEDS_EVIDENCE gap classification when kind is omitted", () => {
  const result = assessReview(
    {
      verdict: "NEEDS_EVIDENCE",
      summary: "Missing callee",
      issues: [
        {
          severity: "medium",
          message: "Need callee implementation",
          evidence: { path: "a.ts", quote: "return [...value];" },
        },
      ],
      evidenceRequests: [{ path: "callee.ts", question: "Show implementation" }],
    },
    evidence,
  );
  expect(result.hostFeedback?.[0]?.category).toBe("SOURCE");
  expect(reviewSupplementRequests(result)).toHaveLength(1);
  expect(result.approved).toBe(false);
});
