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
