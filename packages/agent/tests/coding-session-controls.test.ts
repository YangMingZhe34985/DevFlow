import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { PhaseCompletionSchema, type AgentPlan } from "@devflow/shared";
import {
  AgentStateSerializer,
  DefaultAgentRuntime,
  FakeLanguageModel,
  InMemoryAgentStateStore,
  continueCodingSession,
  createInitialAgentState,
  fakeModelResponse,
  projectCodingSessionHistory,
  type AgentState,
  type HostCodingContinuation,
  type ModelMessage,
} from "../src/index.js";

const oldPlan: AgentPlan = {
  summary: "Approved producer repair",
  steps: [{ id: "producer", title: "Producer", description: "Preserve skipped results" }],
};
const newPlan: AgentPlan = {
  summary: "Approved producer and consumer repair",
  steps: [{ id: "consumer", title: "Consumer", description: "Preserve skipped state on restore" }],
};
const approval: HostCodingContinuation = {
  id: "approval:new-plan",
  kind: "APPROVAL",
  feedback: "A new persisted PLAN approval authorizes the verified consumer scope.",
  observedSourceChanged: false,
};
const oldControls = [
  "HOST_AUTHORIZATION_HANDOFF: only finishPhase; no reads or edits.",
  "HOST_SUBMISSION_RESERVE: only finishPhase is now available.",
  "HOST_TIME_RESERVE: exploration is closed.",
  "HOST_CONVERGENCE: repeated observations require handoff.",
  "One shared bounded correction decision: correct the failed parameters only.",
  "One bounded edit correction is available. Use the previous source.",
  "Convergence warning: the previous calls produced no new evidence.",
];

function completedState(): AgentState {
  const state = createInitialAgentState(randomUUID(), [
    { role: "SYSTEM", content: "Coding policy: approved writes only." },
    { role: "USER", content: "Task: preserve skipped results and restoration behavior." },
    {
      role: "USER",
      content: `Approved plan (follow this plan):\n${JSON.stringify(oldPlan)}`,
    },
    { role: "USER", content: "Repository/stage evidence:\nCURRENT_SOURCE" },
    { role: "USER", content: "Stable Coding task state: unresolved restoration failure." },
    ...oldControls.map((content) => ({ role: "USER" as const, content })),
  ]);
  state.plan = oldPlan;
  state.phase = "COMPLETED";
  state.stepCount = 3;
  state.phaseDeadlineAt = Date.now() + 10_000;
  state.metrics = {
    ...state.metrics,
    modelCalls: 3,
    modelRequestsDispatched: 3,
    toolCalls: 7,
    toolExecutions: 5,
    tokenUsage: { inputTokens: 600, outputTokens: 200, totalTokens: 800 },
  };
  state.hostToolState = { consumedReads: 4, restoredCheckpointSha256: "a".repeat(64) };
  state.executionRecovery = {
    pending: false,
    used: true,
    evidenceRefreshUsed: true,
    handoffPending: true,
    authorizationHandoffUsed: true,
    submissionOnly: true,
    explorationClosed: true,
  };
  state.executionConvergence = {
    noProgressStreak: 1,
    diffFingerprints: ["previous-candidate"],
    evidence: { ranges: [], facts: ["unresolved restoration failure"] },
  };
  state.finalResult = {
    runId: state.runId,
    status: "SUCCEEDED",
    metrics: { ...state.metrics, steps: state.stepCount, durationMs: 0 },
  };
  return state;
}

it("expires prior segment control prompts after host continuation without erasing evidence or history", () => {
  const original = completedState();
  const next = continueCodingSession(original, approval, { approvedPlan: newPlan }).state;
  const currentControl: ModelMessage = {
    role: "USER",
    content: "HOST_TIME_RESERVE: current request's exploration is now closed.",
  };
  const projected = projectCodingSessionHistory([...next.messages, currentControl]);
  const text = JSON.stringify(projected);
  for (const control of oldControls) expect(text).not.toContain(control);
  expect(text).toContain("Historical host control decision is superseded");
  expect(text).toContain("previousRecordSha256");
  expect(text).toContain("CURRENT_SOURCE"); // Approval did not change this source identity.
  expect(text).toContain("unresolved restoration failure");
  expect(text).toContain("Preserve skipped state on restore");
  expect(projected.at(-1)).toEqual(currentControl);
  expect(JSON.stringify(next.messages)).toContain(oldControls[0]);
  expect(next.metrics).toEqual(original.metrics);
  expect(next.hostToolState).toEqual(original.hostToolState);
  expect(next.executionConvergence).toEqual(original.executionConvergence);
  expect(next.phaseDeadlineAt).toBe(original.phaseDeadlineAt);
  expect(next.executionRecovery).toMatchObject({
    used: true,
    evidenceRefreshUsed: true,
    authorizationHandoffUsed: false,
    submissionOnly: false,
  });
});

it.each(["PUBLIC_VALIDATION", "INDEPENDENT_REVIEW", "APPROVAL"] as const)(
  "does not renew authorization or correction credit on a same-approval %s continuation",
  (kind) => {
    const original = completedState();
    const continuation: HostCodingContinuation = { ...approval, id: `${kind}:same-scope`, kind };
    const next = continueCodingSession(original, continuation, { approvedPlan: oldPlan }).state;
    expect(next.executionRecovery).toMatchObject({
      authorizationHandoffUsed: true,
      used: true,
      evidenceRefreshUsed: true,
    });
    const serializer = new AgentStateSerializer();
    const restored = serializer.deserialize(serializer.serialize(next));
    expect(continueCodingSession(restored, continuation, { approvedPlan: oldPlan })).toEqual({
      state: restored,
      accepted: false,
    });
    expect(restored.stepCount).toBe(3);
    expect(restored.metrics.tokenUsage.totalTokens).toBe(800);
    expect(restored.hostToolState?.consumedReads).toBe(4);
  },
);

it("retains historical tool denial and current control records when stale source is invalidated", () => {
  const oldError: ModelMessage = {
    role: "TOOL",
    toolCallId: "old-read",
    toolName: "readFile",
    isError: true,
    content: {
      code: "PERMISSION_DENIED",
      message: "READ_BYTE_LIMIT: maxBytes=200000 exceeds effective limit 16384.",
    },
  };
  const initial = completedState();
  initial.messages = [
    ...initial.messages,
    {
      role: "ASSISTANT",
      content: "",
      toolCalls: [{ id: "old-read", name: "readFile", input: { maxBytes: 200000 } }],
    },
    oldError,
  ];
  const next = continueCodingSession(
    initial,
    { ...approval, observedSourceChanged: true },
    { approvedPlan: newPlan, additionalContext: "VERIFIED_CURRENT_CONSUMER" },
  ).state;
  const projected = projectCodingSessionHistory(next.messages);
  expect(projected.find((message) => message.role === "TOOL")).toEqual(oldError);
  expect(JSON.stringify(projected)).toContain("VERIFIED_CURRENT_CONSUMER");
  expect(JSON.stringify(projected)).not.toContain("CURRENT_SOURCE");
  expect(JSON.stringify(initial.messages)).toContain("CURRENT_SOURCE");
});

it("resumes a newly approved session with reads and edits available and stops immediately on submission", async () => {
  const original = completedState();
  original.executionConvergence!.noProgressStreak = 0;
  const store = new InMemoryAgentStateStore();
  await store.save(original);
  const model = new FakeLanguageModel([
    async (request) => {
      const text = JSON.stringify(request.messages);
      for (const control of oldControls) expect(text).not.toContain(control);
      expect(text).toContain("Preserve skipped state on restore");
      expect(request.tools.map((tool) => tool.name)).toContain("writeFile");
      return fakeModelResponse({
        toolCalls: [
          { id: "current-read", name: "readFile", input: { path: "src/consumer.ts" } },
          {
            id: "current-edit",
            name: "writeFile",
            input: { path: "src/consumer.ts", content: "RESTORED_CANDIDATE" },
          },
          {
            id: "current-submit",
            name: "finishPhase",
            input: { outcome: "CHANGED", summary: "Submit the approved restoration candidate" },
          },
        ],
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      });
    },
  ]);
  const runtime = new DefaultAgentRuntime(model);
  const executed: string[] = [];
  const context = {
    runId: original.runId,
    stateStore: store,
    signal: new AbortController().signal,
    task: {
      taskId: randomUUID(),
      repositoryId: randomUUID(),
      title: "Preserve restored status",
      description: "Restore skipped state from the approved consumer scope.",
    },
    tools: ["readFile", "writeFile", "finishPhase"].map((name) => ({
      name,
      description: name,
      inputSchema: name === "finishPhase" ? PhaseCompletionSchema : z.unknown(),
    })),
    emit: async () => {},
    executeTool: async (_step: string, call: { name: string }) => {
      executed.push(call.name);
      return { ok: true as const, output: { content: "CURRENT_CONSUMER" }, durationMs: 1 };
    },
  };
  const request = {
    codingSession: true,
    repairMode: true,
    deduplicateContext: true,
    contextStage: "EXECUTE" as const,
    approvedPlan: newPlan,
    hostContinuation: approval,
    maxSteps: 10,
    timeoutMs: 10_000,
    maxRetries: 0,
  };
  const result = await runtime.run(request, context);
  expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
  expect(executed).toEqual(["readFile", "writeFile"]);
  expect(result.metrics.steps).toBe(4);
  expect(result.metrics.tokenUsage.totalTokens).toBe(830);
  const saved = (await store.load(original.runId))!;
  expect(saved.executionRecovery).toMatchObject({ used: true, evidenceRefreshUsed: true });
  expect(saved.hostToolState).toEqual(original.hostToolState);
  expect(await runtime.run(request, context)).toEqual(result);
  expect(model.requests).toHaveLength(1);
  expect(executed).toHaveLength(2);
});
