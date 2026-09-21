import { randomUUID } from "node:crypto";

import { DevflowError, type NewAgentEvent } from "@devflow/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  DefaultAgentRuntime,
  FakeLanguageModel,
  InMemoryAgentStateStore,
  createInitialAgentState,
  fakeModelResponse,
  projectModelMessages,
  type AgentProgressSnapshot,
  type AgentStateStore,
  type ModelMessage,
  type RunContext,
} from "../src/index.js";

describe("DefaultAgentRuntime execution budgets", () => {
  it("blocks a provider retry before modelCalls would exceed the run budget", async () => {
    const model = new FakeLanguageModel([
      async () => {
        throw new DevflowError({
          code: "LLM_FAILED",
          message: "temporary provider failure",
          retryable: true,
        });
      },
      fakeModelResponse({ toolCalls: [], text: "must not be requested" }),
    ]);
    const { context } = createContext();

    const result = await new DefaultAgentRuntime(model).run(
      {
        maxSteps: 2,
        timeoutMs: 1_000,
        maxRetries: 2,
        executionBudget: {
          stage: "EXECUTE",
          maxModelCalls: 1,
          maxToolCalls: 10,
          maxTotalTokens: 1_000,
        },
      },
      context,
    );

    expect(model.requests).toHaveLength(1);
    expect(result).toMatchObject({
      status: "FAILED",
      error: {
        code: "EXECUTION_BUDGET_EXCEEDED",
        details: { stage: "EXECUTE", budgetType: "modelCalls", limit: 1, observed: 2 },
      },
      metrics: { steps: 1, modelCalls: 1, retries: 1 },
    });
  });

  it("blocks a tool batch before executing any tool when toolCalls would exceed budget", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [
          { id: "read-1", name: "readFile", input: { path: "src/a.ts" } },
          { id: "read-2", name: "readFile", input: { path: "src/b.ts" } },
        ],
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      }),
    ]);
    const { context } = createContext();
    const executeTool = vi.fn(context.executeTool);
    context.executeTool = executeTool;

    const result = await new DefaultAgentRuntime(model).run(
      {
        maxSteps: 2,
        timeoutMs: 1_000,
        maxRetries: 0,
        executionBudget: {
          stage: "EXECUTE",
          maxModelCalls: 5,
          maxToolCalls: 1,
          maxTotalTokens: 1_000,
        },
      },
      context,
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "FAILED",
      error: {
        code: "EXECUTION_BUDGET_EXCEEDED",
        details: { stage: "EXECUTE", budgetType: "toolCalls", limit: 1, observed: 2 },
      },
      metrics: {
        steps: 1,
        modelCalls: 1,
        toolCalls: 0,
        tokenUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      },
    });
  });

  it("retains response usage when totalTokens exceeds budget", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [],
        text: "completed but over budget",
        usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
        latencyMs: 4,
      }),
    ]);
    const { context } = createContext();

    const result = await new DefaultAgentRuntime(model).run(
      {
        maxSteps: 1,
        timeoutMs: 1_000,
        maxRetries: 0,
        executionBudget: {
          stage: "EXECUTE",
          maxModelCalls: 5,
          maxToolCalls: 5,
          maxTotalTokens: 8,
        },
      },
      context,
    );

    expect(model.requests).toHaveLength(1);
    expect(result).toMatchObject({
      status: "FAILED",
      error: {
        code: "EXECUTION_BUDGET_EXCEEDED",
        details: { stage: "EXECUTE", budgetType: "totalTokens", limit: 8, observed: 9 },
      },
      metrics: {
        steps: 1,
        modelCalls: 1,
        tokenUsage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
      },
    });
    expect(result.metrics.modelLatencyMs).toBeGreaterThanOrEqual(4);
  });
});

describe("DefaultAgentRuntime adaptive step leases", () => {
  it("extends inline while preserving model context and the read cache", async () => {
    const snapshots: AgentProgressSnapshot[] = [];
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: "read-1", name: "readFile", input: { path: "src/a.ts" } }],
      }),
      async (request) => {
        expect(request.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "TOOL",
              toolCallId: "read-1",
              content: { echoed: { path: "src/a.ts" } },
            }),
          ]),
        );
        return fakeModelResponse({
          toolCalls: [{ id: "read-2", name: "readFile", input: { path: "src/a.ts" } }],
        });
      },
      fakeModelResponse({ toolCalls: [], text: "completed inside the extended lease" }),
    ]);
    const { context } = createContext();
    const executeTool = vi.fn(context.executeTool);
    context.executeTool = executeTool;

    const result = await new DefaultAgentRuntime(model).run(
      {
        maxSteps: 5,
        timeoutMs: 1_000,
        maxRetries: 0,
        adaptiveStepBudget: {
          initialLimit: 1,
          hardLimit: 3,
          onLimitReached(snapshot) {
            snapshots.push({ ...snapshot });
            return { action: "EXTEND", additionalSteps: 2, reason: "useful cached context" };
          },
        },
      },
      context,
    );

    expect(result).toMatchObject({
      status: "SUCCEEDED",
      summary: "completed inside the extended lease",
      metrics: { steps: 3, modelCalls: 3, toolCalls: 2, cacheHits: 1 },
    });
    expect(executeTool).toHaveBeenCalledOnce();
    expect(snapshots).toEqual([
      expect.objectContaining({
        stepCount: 1,
        currentLimit: 1,
        hardLimit: 3,
        remainingHardSteps: 2,
        cacheEntries: 1,
        workspaceRevision: 0,
      }),
    ]);
  });

  it("keeps the legacy maxSteps failure when no adaptive controller is supplied", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: "read", name: "readFile", input: { path: "src/a.ts" } }],
      }),
    ]);
    const { context } = createContext();

    const result = await new DefaultAgentRuntime(model).run(
      { maxSteps: 1, timeoutMs: 1_000, maxRetries: 0 },
      context,
    );

    expect(result).toMatchObject({
      status: "FAILED",
      error: {
        code: "MAX_STEPS_EXCEEDED",
        message: "Agent exceeded the maximum of 1 model steps.",
      },
      metrics: { steps: 1 },
    });
  });

  it("clamps an oversized extension to both hardLimit and maxSteps", async () => {
    const controller = vi.fn(() => ({
      action: "EXTEND" as const,
      additionalSteps: 100,
    }));
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: "write-1", name: "writeFile", input: { path: "a", content: "1" } }],
      }),
      fakeModelResponse({
        toolCalls: [{ id: "write-2", name: "writeFile", input: { path: "a", content: "2" } }],
      }),
      fakeModelResponse({ toolCalls: [], text: "must not run" }),
    ]);
    const store = new InMemoryAgentStateStore();
    const { context } = createContext(store);

    const result = await new DefaultAgentRuntime(model).run(
      {
        maxSteps: 3,
        timeoutMs: 1_000,
        maxRetries: 0,
        adaptiveStepBudget: {
          initialLimit: 1,
          hardLimit: 2,
          onLimitReached: controller,
        },
      },
      context,
    );

    expect(controller).toHaveBeenCalledOnce();
    expect(model.requests).toHaveLength(2);
    expect(result).toMatchObject({
      status: "FAILED",
      error: {
        code: "MAX_STEPS_EXCEEDED",
        message: "Agent exceeded the maximum of 2 model steps.",
      },
      metrics: { steps: 2 },
    });
    expect(await store.load(context.runId)).toMatchObject({
      adaptiveStepBudget: { currentLimit: 2, hardLimit: 2, extensions: 1 },
    });
  });

  it("uses maxSteps as the ceiling when the controller hardLimit is larger", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: "write-1", name: "writeFile", input: { path: "a", content: "1" } }],
      }),
      fakeModelResponse({
        toolCalls: [{ id: "write-2", name: "writeFile", input: { path: "a", content: "2" } }],
      }),
    ]);
    const { context } = createContext();

    const result = await new DefaultAgentRuntime(model).run(
      {
        maxSteps: 2,
        timeoutMs: 1_000,
        maxRetries: 0,
        adaptiveStepBudget: {
          initialLimit: 1,
          hardLimit: 10,
          onLimitReached: () => ({ action: "EXTEND", additionalSteps: 100 }),
        },
      },
      context,
    );

    expect(model.requests).toHaveLength(2);
    expect(result).toMatchObject({
      status: "FAILED",
      error: {
        code: "MAX_STEPS_EXCEEDED",
        message: "Agent exceeded the maximum of 2 model steps.",
      },
    });
  });

  it("fails with NO_PROGRESS when the controller rejects a repeated cached read", async () => {
    const snapshots: AgentProgressSnapshot[] = [];
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: "read-1", name: "readFile", input: { path: "same.ts" } }],
      }),
      fakeModelResponse({
        toolCalls: [{ id: "read-2", name: "readFile", input: { path: "same.ts" } }],
      }),
    ]);
    const { context } = createContext();
    const executeTool = vi.fn(context.executeTool);
    context.executeTool = executeTool;

    const result = await new DefaultAgentRuntime(model).run(
      {
        maxSteps: 5,
        timeoutMs: 1_000,
        maxRetries: 0,
        adaptiveStepBudget: {
          initialLimit: 2,
          hardLimit: 4,
          onLimitReached(snapshot) {
            snapshots.push({ ...snapshot });
            return { action: "STOP", reason: "NO_PROGRESS" };
          },
        },
      },
      context,
    );

    expect(executeTool).toHaveBeenCalledOnce();
    expect(snapshots).toEqual([
      expect.objectContaining({
        stepCount: 2,
        noProgressStreak: 1,
        cacheEntries: 1,
        cacheHits: 1,
        duplicateToolCalls: 1,
        hasMutationEvidence: false,
      }),
    ]);
    expect(result).toMatchObject({
      status: "FAILED",
      error: {
        code: "NO_PROGRESS",
        message: expect.stringContaining("made no progress"),
        details: { stepCount: 2, noProgressStreak: 1 },
      },
    });
  });

  it("keeps a stable fingerprint when the same cached diff is repeated", async () => {
    const snapshots: AgentProgressSnapshot[] = [];
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: "diff-1", name: "gitDiff", input: {} }],
      }),
      fakeModelResponse({
        toolCalls: [{ id: "diff-2", name: "gitDiff", input: {} }],
      }),
    ]);
    const { context } = createContext();
    context.tools = [
      {
        name: "gitDiff",
        description: "Read the current diff.",
        inputSchema: z.object({}),
        readOnly: true,
        parallelSafe: true,
        mutatesWorkspace: false,
      },
    ];
    context.executeTool = async () => ({
      ok: true,
      output: { filesChanged: 1, patch: "+same change" },
      durationMs: 1,
    });

    const result = await new DefaultAgentRuntime(model).run(
      {
        maxSteps: 4,
        timeoutMs: 1_000,
        maxRetries: 0,
        adaptiveStepBudget: {
          initialLimit: 1,
          hardLimit: 3,
          onLimitReached(snapshot) {
            snapshots.push({ ...snapshot });
            return snapshots.length === 1
              ? { action: "EXTEND", additionalSteps: 1 }
              : { action: "STOP", reason: "NO_PROGRESS" };
          },
        },
      },
      context,
    );

    expect(result.error?.code).toBe("NO_PROGRESS");
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.progressFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(snapshots[1]?.progressFingerprint).toBe(snapshots[0]?.progressFingerprint);
  });

  it("maps a non-progress-independent soft stop to ESTIMATED_BUDGET_EXCEEDED", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: "read", name: "readFile", input: { path: "src/a.ts" } }],
      }),
    ]);
    const { context } = createContext();

    const result = await new DefaultAgentRuntime(model).run(
      {
        maxSteps: 4,
        timeoutMs: 1_000,
        maxRetries: 0,
        adaptiveStepBudget: {
          initialLimit: 1,
          hardLimit: 4,
          onLimitReached: () => ({
            action: "STOP",
            reason: "ESTIMATED_BUDGET_EXCEEDED",
          }),
        },
      },
      context,
    );

    expect(result).toMatchObject({
      status: "FAILED",
      error: {
        code: "ESTIMATED_BUDGET_EXCEEDED",
        message: expect.stringContaining("estimated step budget"),
      },
    });
  });

  it("resumes from a persisted adaptive lease before requesting another extension", async () => {
    const store = new InMemoryAgentStateStore();
    const { context } = createContext(store);
    const checkpoint = createInitialAgentState(context.runId, [
      { role: "SYSTEM", content: "system" },
      { role: "USER", content: "task" },
    ]);
    await store.save({
      ...checkpoint,
      phase: "THINKING",
      stepCount: 1,
      adaptiveStepBudget: { currentLimit: 2, hardLimit: 4, extensions: 1 },
    });
    const snapshots: AgentProgressSnapshot[] = [];
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [
          { id: "write", name: "writeFile", input: { path: "src/a.ts", content: "fixed" } },
        ],
      }),
      fakeModelResponse({ toolCalls: [], text: "resumed and completed" }),
    ]);

    const result = await new DefaultAgentRuntime(model).run(
      {
        maxSteps: 5,
        timeoutMs: 1_000,
        maxRetries: 0,
        adaptiveStepBudget: {
          initialLimit: 1,
          hardLimit: 4,
          onLimitReached(snapshot) {
            snapshots.push({ ...snapshot });
            return { action: "EXTEND", additionalSteps: 1 };
          },
        },
      },
      context,
    );

    expect(snapshots).toEqual([
      expect.objectContaining({
        stepCount: 2,
        currentLimit: 2,
        hardLimit: 4,
        extensions: 1,
        successfulMutations: 1,
      }),
    ]);
    expect(result).toMatchObject({ status: "SUCCEEDED", metrics: { steps: 3 } });
    expect(await store.load(context.runId)).toMatchObject({
      phase: "COMPLETED",
      adaptiveStepBudget: { currentLimit: 3, hardLimit: 4, extensions: 2 },
    });
  });
});

describe("stage-local context projection", () => {
  it("retains only the latest known version of a relevant file outside the last two groups", () => {
    const messages: ModelMessage[] = [
      { role: "SYSTEM", content: "system" },
      { role: "USER", content: "task" },
      assistantCall("old-read", "readFile"),
      toolResult("old-read", "readFile", { path: "src/a.ts", content: "OLD_VERSION" }),
      assistantCall("new-read", "readFile"),
      toolResult("new-read", "readFile", { path: "src/a.ts", content: "NEW_VERSION" }),
      assistantCall("search", "searchCode"),
      toolResult("search", "searchCode", { matches: [] }),
      assistantCall("status", "gitStatus"),
      toolResult("status", "gitStatus", { clean: true }),
    ];

    const serialized = JSON.stringify(projectModelMessages(messages));
    expect(serialized).toContain("NEW_VERSION");
    expect(serialized).not.toContain("OLD_VERSION");
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(192 * 1_024);
  });
});

function assistantCall(id: string, name: string): ModelMessage {
  return { role: "ASSISTANT", content: "", toolCalls: [{ id, name, input: {} }] };
}

function toolResult(id: string, name: string, content: unknown): ModelMessage {
  return { role: "TOOL", toolCallId: id, toolName: name, content, isError: false };
}

function createContext(stateStore?: AgentStateStore): {
  context: RunContext;
  events: NewAgentEvent[];
} {
  const events: NewAgentEvent[] = [];
  return {
    events,
    context: {
      runId: randomUUID(),
      task: {
        taskId: randomUUID(),
        repositoryId: randomUUID(),
        title: "Stay within the budget",
        description: "Exercise hard execution limits.",
      },
      signal: new AbortController().signal,
      tools: [],
      ...(stateStore === undefined ? {} : { stateStore }),
      async emit(event) {
        events.push(event);
      },
      async executeTool(_stepId, request) {
        return { ok: true, output: { echoed: request.input }, durationMs: 1 };
      },
    },
  };
}
