import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { PhaseCompletionSchema, AgentPlanSchema, type MutationResult } from "@devflow/shared";
import {
  DefaultAgentRuntime,
  FakeLanguageModel,
  fakeModelResponse,
  InMemoryAgentStateStore,
  PostPatchController,
  contentHash,
  continueCodingSession,
  projectCodingSessionHistory,
  prepareStageContext,
  type AgentRunRequest,
  type FakeModelStep,
  type RunContext,
} from "../src/index.js";

const decision = (content: string, outcome = "CHANGED") =>
  fakeModelResponse({
    toolCalls: [
      { id: randomUUID(), name: "writeFile", input: { path: "src/a.ts", content } },
      {
        id: randomUUID(),
        name: "finishPhase",
        input: { summary: "Submit candidate to host validation", outcome },
      },
    ],
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  });
const completed = () =>
  fakeModelResponse({
    toolCalls: [
      {
        id: randomUUID(),
        name: "finishPhase",
        input: {
          summary: "The current implementation satisfies the finding",
          outcome: "ALREADY_SATISFIED",
        },
      },
    ],
  });

function fixture(steps: FakeModelStep[], overrides: Partial<AgentRunRequest> = {}) {
  const stateStore = new InMemoryAgentStateStore();
  const model = new FakeLanguageModel(steps);
  const runtime = new DefaultAgentRuntime(model);
  let content = "BASE_SOURCE",
    controller = new PostPatchController(["src/a.ts"]);
  const context: RunContext = {
    runId: randomUUID(),
    stateStore,
    signal: new AbortController().signal,
    task: {
      taskId: randomUUID(),
      repositoryId: randomUUID(),
      title: "Keep both behaviors",
      description: "Fix validation and preserve restoration",
    },
    tools: ["readFile", "writeFile", "gitDiff", "finishPhase"].map((name) => ({
      name,
      description: name,
      inputSchema: name === "finishPhase" ? PhaseCompletionSchema : z.unknown(),
    })),
    validateFinishPhase: () => undefined,
    authorizeTool: (call) =>
      call.name === "writeFile" && (call.input as { path: string }).path !== "src/a.ts"
        ? "Outside approved scope"
        : undefined,
    emit: async () => {},
    executeTool: async (_step, call) => {
      if (call.name === "writeFile") {
        const next = (call.input as { content: string }).content;
        const changed = next !== content;
        const mutation: MutationResult = {
          status: changed ? "APPLIED" : "NO_OP",
          executionSucceeded: true,
          mutationAttempted: true,
          mutationApplied: changed,
          workspaceChanged: changed,
          observationComplete: true,
          reason: changed ? "CONTENT_CHANGED" : "CONTENT_IDENTICAL",
          beforeRevision: controller.revision,
          afterRevision: controller.revision + (changed ? 1 : 0),
          changedFiles: changed ? ["src/a.ts"] : [],
          currentHashes: { "src/a.ts": contentHash(next) },
        };
        content = next;
        controller.observeMutation(mutation, ["src/a.ts"]);
        return { ok: true, output: {}, durationMs: 1, mutation };
      }
      if (call.name === "gitDiff")
        controller.observeDiff(
          content === "BASE_SOURCE" ? "" : `diff:${content}`,
          content === "BASE_SOURCE" ? [] : ["src/a.ts"],
          true,
        );
      return {
        ok: true,
        output: { path: "src/a.ts", fileSha256: contentHash(content), content, truncated: false },
        durationMs: 1,
      };
    },
  };
  const request: AgentRunRequest = {
    codingSession: true,
    repairMode: true,
    contextStage: "EXECUTE",
    deduplicateContext: true,
    maxSteps: 10,
    timeoutMs: 10000,
    maxRetries: 0,
    emitRunLifecycle: false,
    approvedPlan: {
      summary: "Correct validation and restoration",
      steps: [
        {
          id: "edit",
          title: "Both behaviors",
          description: "Keep restoration behavior visible until complete",
        },
      ],
    },
    stableTaskContext: "Validation and restoration are both required",
    additionalContext: "BASE_SOURCE",
    modelSettings: { maxOutputTokens: 512 },
    executionBudget: {
      stage: "CODING",
      maxModelCalls: 10,
      maxToolCalls: 30,
      maxTotalTokens: 100000,
    },
    ...overrides,
  };
  return {
    model,
    context,
    request,
    stateStore,
    content: () => content,
    run: (extra: Partial<AgentRunRequest> = {}) => {
      controller = new PostPatchController(["src/a.ts"]);
      return runtime.run({ ...request, ...extra, postPatch: controller }, context);
    },
  };
}
const feedback = {
  id: "public-test-1",
  kind: "PUBLIC_VALIDATION" as const,
  feedback: "TS2304: restoration still calls removed helper",
  sourceIdentity: "candidate-one/profile-one",
  observedSourceChanged: true,
};

it("continues edit, host Test, revise, retest in one saved session and retains requirements", async () => {
  const f = fixture([
    fakeModelResponse({
      toolCalls: [{ id: "initial-read", name: "readFile", input: { path: "src/a.ts" } }],
    }),
    decision("PARTIAL_CANDIDATE"),
    async (request) => {
      const serialized = JSON.stringify(request.messages);
      expect(serialized).toContain("TS2304");
      expect(serialized).toContain("Keep restoration behavior visible");
      expect(serialized).toContain("CURRENT_PARTIAL_SOURCE");
      expect(serialized).not.toContain("BASE_SOURCE");
      expect(request.messages.some((m) => m.role === "TOOL" && m.toolName === "writeFile")).toBe(
        true,
      );
      expect(request.tools.map((t) => t.name)).toContain("writeFile");
      return decision("COMPLETE_CANDIDATE");
    },
  ]);
  const first = await f.run();
  expect(first.executeCompletion?.outcome).toBe("PATCH_READY");
  expect(f.content()).toBe("PARTIAL_CANDIDATE"); // Public validation fails this candidate.
  const initial = await f.stateStore.load(f.context.runId);
  const second = await f.run({
    hostContinuation: feedback,
    additionalContext: "CURRENT_PARTIAL_SOURCE",
  });
  expect(f.content()).toBe("COMPLETE_CANDIDATE"); // Host retest can now succeed.
  expect(second.executeCompletion?.outcome).toBe("PATCH_READY");
  expect(second.metrics.steps).toBe(3);
  expect(second.metrics.modelRequestsDispatched).toBe(3);
  expect(second.metrics.tokenUsage.totalTokens).toBe(240);
  const saved = (await f.stateStore.load(f.context.runId))!;
  expect(saved.startedAt).toBe(initial?.startedAt);
  expect(saved.phaseDeadlineAt).toBe(initial?.phaseDeadlineAt);
  expect(saved.codingContinuations).toHaveLength(1);
  expect(JSON.stringify(saved.messages)).toContain("BASE_SOURCE");
  expect(await f.run()).toEqual(second);
  expect(
    await f.run({ hostContinuation: feedback, additionalContext: "CURRENT_PARTIAL_SOURCE" }),
  ).toEqual(second);
  expect(f.model.requests).toHaveLength(3);
});

it("does not regrant correction/progress budgets when host feedback reopens transient gates", async () => {
  const f = fixture([
    decision("partial"),
    async (request) => {
      const state = (await f.stateStore.load(f.context.runId))!;
      expect(state.executionRecovery).toMatchObject({
        used: true,
        evidenceRefreshUsed: true,
        submissionOnly: false,
        explorationClosed: false,
      });
      expect(state.executionConvergence).toMatchObject({
        noProgressStreak: 1,
        diffFingerprints: ["previous-candidate"],
      });
      expect(request.tools.map((t) => t.name)).toContain("writeFile");
      return decision("complete");
    },
  ]);
  await f.run();
  const state = (await f.stateStore.load(f.context.runId))!;
  state.executionRecovery = {
    pending: false,
    used: true,
    evidenceRefreshUsed: true,
    submissionOnly: true,
    explorationClosed: true,
  };
  state.executionConvergence = {
    noProgressStreak: 1,
    diffFingerprints: ["previous-candidate"],
    evidence: { ranges: [], facts: [] },
  };
  await f.stateStore.save(state);
  expect((await f.run({ hostContinuation: feedback })).status).toBe("SUCCEEDED");
  expect((await f.stateStore.load(f.context.runId))?.executionRecovery?.used).toBe(true);
});

it("refuses changed/repeated feedback identities and cannot reopen an absent session", async () => {
  const f = fixture([decision("partial"), decision("complete")]);
  await expect(f.run({ hostContinuation: feedback })).rejects.toThrow("saved session");
  await f.run();
  await f.run({ hostContinuation: feedback });
  await expect(
    f.run({ hostContinuation: { ...feedback, feedback: "different failure" } }),
  ).rejects.toThrow("reused");
  await expect(
    f.run({ hostContinuation: { ...feedback, id: "duplicate-other-id" } }),
  ).rejects.toThrow("duplicate feedback");
  expect(f.model.requests).toHaveLength(2);
});

it("a persisted in-flight continuation resumes once without duplicating feedback or extending the deadline", async () => {
  const f = fixture([decision("partial"), decision("complete")]);
  await f.run();
  const original = (await f.stateStore.load(f.context.runId))!;
  const reservation = continueCodingSession(original, feedback, f.request);
  await f.stateStore.save(reservation.state);
  expect((await f.run({ hostContinuation: feedback, timeoutMs: 20000 })).status).toBe("SUCCEEDED");
  const final = (await f.stateStore.load(f.context.runId))!;
  expect(final.phaseDeadlineAt).toBe(original.phaseDeadlineAt);
  expect(final.codingContinuations).toHaveLength(1);
  expect(
    final.messages.filter(
      (m) => m.role === "USER" && m.content.startsWith("Host Coding Loop feedback"),
    ),
  ).toHaveLength(1);
});

it("preserves cumulative steps/tokens and does not dispatch after a saved deadline", async () => {
  const steps = fixture([decision("partial")], { maxSteps: 1 });
  await steps.run();
  const result = await steps.run({ hostContinuation: feedback });
  expect(result.error?.code).toBe("MAX_STEPS_EXCEEDED");
  expect(result.metrics.modelRequestsDispatched).toBe(1);
  expect(result.metrics.tokenUsage.totalTokens).toBe(120);
  const timed = fixture([decision("partial")]);
  await timed.run();
  const checkpoint = (await timed.stateStore.load(timed.context.runId))!;
  checkpoint.phaseDeadlineAt = Date.now() - 1;
  await timed.stateStore.save(checkpoint);
  const expired = await timed.run({ hostContinuation: feedback, timeoutMs: 100000 });
  expect(expired.error?.details).toMatchObject({ requestIssued: false });
  expect(timed.model.requests).toHaveLength(1);
});

it("evidence-only replies can finish without inventing edits, but host evidence checks still reject them", async () => {
  const valid = fixture([completed()]);
  const result = await valid.run();
  expect(result.status).toBe("SUCCEEDED");
  expect(result.phaseCompletion?.outcome).toBe("ALREADY_SATISFIED");
  expect(valid.content()).toBe("BASE_SOURCE");
  const invalid = fixture([completed()], { maxSteps: 1 });
  invalid.context.validateFinishPhase = () => "Stale source evidence";
  expect((await invalid.run()).status).toBe("FAILED");
});

it("host feedback does not authorize a newly requested write path", async () => {
  const f = fixture(
    [
      decision("partial"),
      fakeModelResponse({
        toolCalls: [
          { id: "escape", name: "writeFile", input: { path: "outside.ts", content: "unsafe" } },
        ],
      }),
    ],
    { maxSteps: 2 },
  );
  await f.run();
  await f.run({ hostContinuation: feedback });
  expect(f.content()).toBe("partial");
  const saved = (await f.stateStore.load(f.context.runId))!;
  expect(saved.messages.find((m) => m.role === "TOOL" && m.toolCallId === "escape")).toMatchObject({
    isError: true,
  });
});

it("only a new approved Plan replaces the prior plan view and does not erase old evidence/history", async () => {
  const revised = {
    summary: "Approved broader repair",
    steps: [{ id: "new", title: "Consumer", description: "Repair the verified consumer" }],
  };
  const f = fixture([
    decision("partial"),
    async (request) => {
      const text = JSON.stringify(request.messages);
      expect(text).toContain("Earlier approval is superseded");
      expect(text).toContain("Repair the verified consumer");
      expect(text).not.toContain("Keep restoration behavior visible until complete");
      return decision("complete");
    },
  ]);
  await f.run();
  await expect(f.run({ hostContinuation: feedback, approvedPlan: revised })).rejects.toThrow(
    "APPROVAL",
  );
  const approved = {
    ...feedback,
    id: "plan-approval-2",
    kind: "APPROVAL" as const,
    feedback: "User approved verified expanded scope",
  };
  expect((await f.run({ hostContinuation: approved, approvedPlan: revised })).status).toBe(
    "SUCCEEDED",
  );
  const stored = (await f.stateStore.load(f.context.runId))!;
  expect(stored.plan).toEqual(revised);
  expect(JSON.stringify(stored.messages)).toContain(
    "Keep restoration behavior visible until complete",
  );
  expect(stored.metrics.modelRequestsDispatched).toBe(2);
});

it("accepts the same proposal after persisted schema normalization changes object-key order", async () => {
  const plan = {
    approvalScope: {
      files: [{ operation: "MODIFY" as const, path: "src/a.ts" }],
      workspaceRevision: 0,
      baseCommitSha: "a".repeat(40),
      mode: "READY" as const,
      version: "plan-approval-scope-v1" as const,
    },
    proposalVersion: "plan-proposal-v1" as const,
    warnings: [],
    steps: [{ description: "Repair current behavior", title: "Current edit", id: "first" }],
    summary: "Current approved proposal",
  };
  expect(JSON.stringify(AgentPlanSchema.parse(plan))).not.toBe(JSON.stringify(plan));
  const f = fixture([decision("partial"), decision("complete")], { approvedPlan: plan });
  await f.run();
  const second = await f.run({ hostContinuation: feedback });
  expect(second.status).toBe("SUCCEEDED");
  expect(
    await f.run({ hostContinuation: feedback, approvedPlan: AgentPlanSchema.parse(plan) }),
  ).toEqual(second);
  expect(f.model.requests).toHaveLength(2);
});

it("reports zero dispatch when resource admission rejects the first request", async () => {
  const f = fixture([decision("must-not-run")], {
    convergenceReserve: { downstreamSteps: 1, downstreamTokens: 1000 },
    executionBudget: { stage: "CODING", maxModelCalls: 10, maxToolCalls: 30, maxTotalTokens: 1000 },
  });
  const result = await f.run();
  expect(result.error?.code).toBe("EXECUTION_BUDGET_EXCEEDED");
  expect(result.metrics.modelCalls).toBe(1);
  expect(result.metrics.modelRequestsDispatched).toBe(0);
  expect(f.model.requests).toHaveLength(0);
});

it("host validation opens bounded diagnostic reads outside the old edit scope, without authorizing writes", async () => {
  const f = fixture([
    decision("partial"),
    async (request) => {
      expect(request.tools.map((tool) => tool.name)).toContain("queryRelations");
      return fakeModelResponse({
        toolCalls: [{ id: "test-read", name: "readFile", input: { path: "tests/regression.ts" } }],
      });
    },
    async (request) => {
      expect(
        request.messages.find(
          (message) => message.role === "TOOL" && message.toolCallId === "test-read",
        ),
      ).toMatchObject({ isError: false });
      return decision("complete");
    },
  ]);
  f.context.tools = [
    ...f.context.tools,
    {
      name: "queryRelations",
      description: "Read graph",
      inputSchema: z.unknown(),
      readOnly: true,
      mutatesWorkspace: false,
    },
  ];
  await f.run();
  expect((await f.run({ hostContinuation: feedback })).status).toBe("SUCCEEDED");
  const controller = new PostPatchController(["src/a.ts"]);
  controller.firstMutationEndedAt = Date.now();
  controller.diagnosticReadOnly = true;
  expect(controller.authorize("readFile", ["tests/regression.ts"])).toBeUndefined();
  expect(controller.authorize("writeFile", ["tests/regression.ts"])).toContain(
    "only planned targets",
  );
});

it("does not report an explicitly unfinished valid candidate as an invalid patch", async () => {
  const partial = decision("partial");
  partial.toolCalls[1]!.input = {
    summary: "Validation fixed but restoration remains",
    outcome: "CHANGED",
    unfinishedWork: ["restore drafts"],
  };
  const f = fixture([partial]);
  const result = await f.run();
  expect(result.executeCompletion).toMatchObject({
    outcome: "NEEDS_MORE_WORK",
    termination: "MODEL_SUBMITTED",
    unfinishedWork: ["restore drafts"],
  });
  expect((await f.stateStore.load(f.context.runId))?.postPatch?.unfinishedWork).toEqual([
    "restore drafts",
  ]);
});

it("admits requests against the larger current time branch without counting the original reserve twice", async () => {
  const f = fixture([decision("must-not-run")], {
    timeoutMs: 1000,
    timeReserve: { downstreamMs: 100, requestMs: 100 },
    continuationReserve: () => ({ timeMs: 1000, tokens: 0, steps: 0 }),
  });
  const result = await f.run();
  expect(result.error?.code).toBe("EXECUTION_BUDGET_EXCEEDED");
  expect(result.error?.details).toMatchObject({
    requestIssued: false,
    downstreamTimeMs: 1000,
    additionalDownstreamMs: 1000,
  });
  expect(f.model.requests).toHaveLength(0);
});

it("releases downstream time only within the original absolute coding deadline", async () => {
  let downstreamMs = 3000;
  const f = fixture([decision("partial"), decision("complete")], {
    timeoutMs: 5000,
    timeReserve: { downstreamMs: 1000, requestMs: 100 },
    continuationReserve: () => ({ timeMs: downstreamMs, tokens: 0, steps: 0 }),
  });
  await f.run();
  const before = (await f.stateStore.load(f.context.runId))!;
  expect(before.phaseDeadlineAt! - Date.parse(before.startedAt)).toBeGreaterThan(4900);
  downstreamMs = 1000;
  expect((await f.run({ hostContinuation: feedback, timeoutMs: 10000 })).status).toBe("SUCCEEDED");
  expect((await f.stateStore.load(f.context.runId))?.phaseDeadlineAt).toBe(before.phaseDeadlineAt);
});

it("reserves a possible correction but not an extra completion request when coding can edit and finish together", async () => {
  const f = fixture([decision("complete")], {
    convergenceReserve: { downstreamSteps: 1, downstreamTokens: 1000 },
    additionalContext: "CURRENT_SOURCE ".repeat(160),
    executionBudget: { stage: "CODING", maxModelCalls: 10, maxToolCalls: 30, maxTotalTokens: 7500 },
  });
  const result = await f.run();
  expect(result.status).toBe("SUCCEEDED");
  expect(f.model.requests).toHaveLength(1);
  expect(result.metrics.modelRequestsDispatched).toBe(1);
});

it("projects duplicate pinned feedback by reference while keeping every diagnostic and counterexample", () => {
  const diagnostics =
    "Finding finding-123: actual restored status is wrong. COUNTEREVIDENCE: event factory is correct.\n".repeat(
      170,
    );
  const feedbackRecord = { ...feedback, feedback: diagnostics };
  const history = [
    { role: "USER" as const, content: "Task: preserve skipped state through restore" },
    {
      role: "USER" as const,
      content:
        "Host Coding Loop feedback (same session; no new resources or permissions):\n" +
        JSON.stringify(feedbackRecord),
    },
    {
      role: "USER" as const,
      content:
        "Stable Coding task state (requirements persist; source citations must be refreshed):\n" +
        diagnostics +
        "\nAdditional unresolved finding-456.",
    },
  ];
  expect(() => prepareStageContext({ stage: "EXECUTE", history, maxBytes: 25000 })).toThrow(
    "pinned context",
  );
  const projected = projectCodingSessionHistory(history);
  const result = prepareStageContext({ stage: "EXECUTE", history: projected, maxBytes: 25000 });
  expect(result.viewBytes).toBeLessThan(25000);
  const serialized = JSON.stringify(result.view);
  expect(serialized).toContain("feedbackRef");
  expect(serialized).toContain("finding-123");
  expect(serialized).toContain("finding-456");
  expect(serialized).toContain("COUNTEREVIDENCE: event factory is correct");
  expect(history[1]!.content).toContain(diagnostics.slice(0, 60));
  const nonidentical = history.map((message, index) =>
    index === 2
      ? {
          ...message,
          content: message.content.replaceAll(
            "actual restored status is wrong",
            "a different failure",
          ),
        }
      : message,
  );
  expect(projectCodingSessionHistory(nonidentical)[1]).toEqual(nonidentical[1]);
});
