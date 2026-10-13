import { expect, it } from "vitest";
import { DevflowError } from "@devflow/shared";
import { projectTeamRequest } from "../src/team/context.js";
import { teamDigest, type TeamDecisionView } from "../src/team/engine.js";

function view(): TeamDecisionView {
  const evidence = (id: string, content: string) => ({
    id,
    runId: "run",
    repositoryId: "repo",
    sourceIdentity: "base",
    kind: "SOURCE_OBSERVATION" as const,
    path: id,
    fileSha256: "a".repeat(64),
    startLine: 1,
    endLine: 1,
    content,
    contentSha256: teamDigest(content),
    sourceOperationId: "read",
    supports: [],
    valid: true,
  });
  return {
    runId: "run",
    sourceIdentity: "base",
    agentId: "agent",
    role: "INVESTIGATOR",
    task: { title: "Task", description: "Preserve behavior" },
    assignments: [],
    board: [],
    inbox: [],
    history: [],
    evidence: [
      evidence("background", "unrelated".repeat(4000)),
      evidence("counterexample", "assert(value === expected)"),
    ],
    limits: { concurrency: 2, maxInvestigators: 4, maxTasks: 12, maxMessages: 64 },
    counterevidence: [
      {
        id: "challenge",
        sequence: 1,
        from: "peer",
        to: "agent",
        taskId: "assignment",
        type: "CHALLENGE",
        body: "This contradicts your hypothesis",
        evidenceIds: ["counterexample"],
        idempotencyKey: "key",
        sourceIdentity: "base",
      },
    ],
  };
}
it("keeps complete counterevidence after inbox consumption and records actual omissions", async () => {
  const projected = await projectTeamRequest(
    view(),
    {
      generate: async () => {
        throw new Error("must not dispatch");
      },
    },
    AbortSignal.timeout(1000),
    { bytes: 8000, tokens: 8000, outputTokens: 1000 },
  );
  expect(projected.shown.map((e) => e.id)).toEqual(["counterexample"]);
  expect(projected.omitted).toContain("background");
  expect(JSON.stringify(projected.request.messages)).toContain("assert(value === expected)");
});
it("keeps field correction feedback visible after trimming history and distinguishes message IDs from task IDs", async () => {
  const input = view();
  input.messageValidationFeedback = {
    originOperationId: "send-1",
    sourceIdentity: "base",
    issue: {
      field: "replyTo",
      expected: "messageId",
      actual: "task-id",
      reason: "TASK_ID_IN_MESSAGE_FIELD",
      availableReplies: [],
      guidance: "Omit replyTo to start a new message.",
    },
  };
  input.history = [
    {
      input: {},
      output: {
        summary: "old output".repeat(500),
        actions: [{ type: "STOP", reason: "STALLED", missing: [] }],
      },
    },
  ];
  const projected = await projectTeamRequest(
    input,
    {
      generate: async () => {
        throw new Error("must not dispatch");
      },
    },
    AbortSignal.timeout(1000),
    { bytes: 8000, tokens: 8000, outputTokens: 1000 },
  );
  const user = JSON.parse(
    projected.request.messages.find((m) => m.role === "USER")!.content as string,
  );
  expect(user.messageValidationFeedback).toEqual(input.messageValidationFeedback);
  expect(user.history).toEqual([]);
  expect(projected.request.messages[0]!.content).toContain("never a task ID");
});
it("blocks when mandatory evidence cannot fit and does not treat configuration errors as capacity", async () => {
  const model = {
    generate: async () => {
      throw new Error("must not dispatch");
    },
  };
  await expect(
    projectTeamRequest(view(), model, AbortSignal.timeout(1000), {
      bytes: 10,
      tokens: 10,
      outputTokens: 1,
    }),
  ).rejects.toMatchObject({ code: "INSUFFICIENT_EVIDENCE", details: { requestIssued: false } });
  await expect(
    projectTeamRequest(
      view(),
      {
        ...model,
        prepareRequest: async () => {
          throw new DevflowError({
            code: "VALIDATION_ERROR",
            message: "bad model setting",
            details: { requestIssued: false },
          });
        },
      },
      AbortSignal.timeout(1000),
      { bytes: 8000, tokens: 8000, outputTokens: 1000 },
    ),
  ).rejects.toThrow("bad model setting");
});

it("keeps exact evidence correction IDs and blocked task reasons in the dispatched view", async () => {
  const input = view();
  input.board = [
    {
      id: "task",
      agentId: "peer",
      goal: "Investigate consumer",
      status: "BLOCKED",
      current: true,
      agentStatus: "BLOCKED",
      reason: "BUDGET_STOP: request not issued",
    },
  ];
  input.messageValidationFeedback = {
    originOperationId: "result-1",
    sourceIdentity: "base",
    issue: {
      field: "evidenceIds",
      expected: "currentVisibleEvidenceIds",
      actual: "guessed-sha",
      reason: "EVIDENCE_ID_UNKNOWN_OR_STALE",
      availableReplies: [],
      invalidEvidenceIds: ["guessed-sha"],
      availableEvidence: [
        { id: "counterexample", path: "consumer.ts", fileSha256: "a".repeat(64) },
      ],
      guidance: "Use exact evidence IDs; missing evidence remains a gap.",
    },
  };
  input.history = [
    {
      input: {},
      output: {
        summary: "old explanation".repeat(1000),
        actions: [{ type: "STOP", reason: "STALLED", missing: [] }],
      },
    },
  ];
  const projected = await projectTeamRequest(
    input,
    {
      generate: async () => {
        throw Error("not issued");
      },
    },
    AbortSignal.timeout(1000),
    { bytes: 10000, tokens: 8000, outputTokens: 1000 },
  );
  const payload = JSON.parse(
    projected.request.messages.find((m) => m.role === "USER")!.content as string,
  );
  expect(payload.messageValidationFeedback).toEqual(input.messageValidationFeedback);
  expect(payload.board).toEqual(input.board);
  expect(payload.history).toEqual([]);
  expect(projected.request.messages[0]!.content).toContain("SEND never revives BLOCKED/CANCELLED");
});

it("projects overlapping evidence through a visible owner and preserves each legal ID and source SHA", async () => {
  const input = view();
  input.counterevidence = [];
  const lines = Array.from({ length: 70 }, (_, i) => `value_${i} = "source observation ${i}"`);
  const base = input.evidence[0]!;
  input.evidence = [
    {
      ...base,
      id: "full",
      path: "logic.py",
      startLine: 1,
      endLine: 70,
      content: lines.join("\n"),
      contentSha256: teamDigest(lines.join("\n")),
    },
    {
      ...base,
      id: "part",
      path: "logic.py",
      startLine: 10,
      endLine: 60,
      content: lines.slice(9, 60).join("\n"),
      contentSha256: teamDigest(lines.slice(9, 60).join("\n")),
    },
  ];
  const result = await projectTeamRequest(
    input,
    {
      generate: async () => {
        throw Error("not issued");
      },
    },
    AbortSignal.timeout(1000),
    { bytes: 14000, tokens: 12000, outputTokens: 1000 },
  );
  const payload = JSON.parse(
    result.request.messages.find((m) => m.role === "USER")!.content as string,
  );
  expect(payload.evidence.find((e: { id: string }) => e.id === "part").contentRef).toMatchObject({
    evidenceId: "full",
    fileSha256: base.fileSha256,
    trailingLineBreak: "",
  });
  expect(payload.evidence.find((e: { id: string }) => e.id === "full").content).toBe(
    lines.join("\n"),
  );
  expect(result.shown.map((e) => e.id).sort()).toEqual(["full", "part"]);
  expect(input.evidence[1]!.content).toBe(lines.slice(9, 60).join("\n"));
  expect(result.audit.evidenceBodyBytesBeforeReferences).toBeGreaterThan(
    result.audit.evidenceBodyBytesAfterReferences,
  );
  expect(result.audit.retainedEvidence).toBe(2);
  expect(result.audit.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
});

it("fails before dispatch if a mandatory reference only exists in a stale source view", async () => {
  const input = view();
  input.evidence.find((e) => e.id === "counterexample")!.sourceIdentity = "old";
  await expect(
    projectTeamRequest(
      input,
      {
        generate: async () => {
          throw Error("not issued");
        },
      },
      AbortSignal.timeout(1000),
      { bytes: 96000, tokens: 32000, outputTokens: 8192 },
    ),
  ).rejects.toMatchObject({
    details: { requestIssued: false, missingRequiredEvidenceIds: ["counterexample"] },
  });
});
