import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  DefaultAgentRuntime,
  FakeLanguageModel,
  fakeModelResponse,
  type RunContext,
  AgentStateSerializer,
  type AgentState,
} from "../src/index.js";
import { PhaseCompletionSchema } from "@devflow/shared";
const finish = () =>
  fakeModelResponse({
    toolCalls: [
      {
        id: randomUUID(),
        name: "finishPhase",
        input: { summary: "Current code handles finding-one", outcome: "ALREADY_SATISFIED" },
      },
    ],
  });
function fixture() {
  let executed = 0;
  const context: RunContext = {
    runId: randomUUID(),
    task: {
      taskId: randomUUID(),
      repositoryId: randomUUID(),
      title: "Fix public issue",
      description: "Preserve existing API",
    },
    signal: new AbortController().signal,
    tools: ["replaceText", "applyPatch", "readFile", "finishPhase"].map((name) => ({
      name,
      description: name,
      inputSchema: name === "finishPhase" ? PhaseCompletionSchema : z.object({}).passthrough(),
      readOnly: name === "readFile" || name === "finishPhase",
      parallelSafe: false,
      mutatesWorkspace: name === "replaceText" || name === "applyPatch",
    })),
    emit: async () => {},
    executeTool: async () => {
      executed++;
      return { ok: true, durationMs: 0, output: { applied: true, sha256: "b".repeat(64) } };
    },
  };
  return { context, executed: () => executed };
}
const request = {
  repairMode: true,
  stableTaskContext:
    "finding-one: type unknown must satisfy Primitive. Failing TS2322 at schemas.ts:2357 remains unresolved until Test.",
  additionalContext: "OLD_SOURCE_SHA: obsolete quoted code",
  invalidateAdditionalContextOnMutation: true,
  maxSteps: 3,
  timeoutMs: 2000,
  maxRetries: 0,
  modelSettings: { maxOutputTokens: 512 },
  executionBudget: { stage: "REPAIR", maxModelCalls: 3, maxToolCalls: 10, maxTotalTokens: 10000 },
};
it("retains stable diagnostics/finding IDs after a mutation, removes old code", async () => {
  const f = fixture(),
    model = new FakeLanguageModel([
      fakeModelResponse({ toolCalls: [{ id: randomUUID(), name: "replaceText", input: {} }] }),
      async (r) => {
        expect(JSON.stringify(r.messages)).toContain("finding-one");
        expect(JSON.stringify(r.messages)).toContain("TS2322");
        expect(JSON.stringify(r.messages)).not.toContain("OLD_SOURCE_SHA");
        return finish();
      },
    ]);
  expect((await new DefaultAgentRuntime(model).run(request, f.context)).status).toBe("SUCCEEDED");
});
it("discards partial LENGTH tools and uses one fresh compact exact-edit decision", async () => {
  const f = fixture(),
    model = new FakeLanguageModel([
      fakeModelResponse({
        finishReason: "LENGTH",
        text: "partial-invalid-continuation",
        toolCalls: [{ id: randomUUID(), name: "replaceText", input: { oldText: "partial" } }],
      }),
      async (r) => {
        expect(r.tools.map((t) => t.name)).toEqual(["replaceText", "finishPhase"]);
        const text = JSON.stringify(r.messages);
        expect(text).toContain("CURRENT_SHA");
        expect(text).toContain("finding-one");
        expect(text).not.toContain("partial-invalid-continuation");
        return finish();
      },
    ]);
  const result = await new DefaultAgentRuntime(model).run(
    {
      ...request,
      repairRecoveryContext: {
        maxToolExecutions: 1,
        collect: async () => ({ text: "CURRENT_SHA source", toolExecutions: 1, toolLatencyMs: 0 }),
      },
    },
    f.context,
  );
  expect(result.status).toBe("SUCCEEDED");
  expect(f.executed()).toBe(0);
  expect(result.metrics.toolExecutions).toBe(1);
});
it("does not continue a second truncation or execute either partial edit", async () => {
  const f = fixture(),
    response = fakeModelResponse({
      finishReason: "LENGTH",
      toolCalls: [{ id: randomUUID(), name: "replaceText", input: {} }],
    });
  const model = new FakeLanguageModel([response, response, finish()]);
  const result = await new DefaultAgentRuntime(model).run(request, f.context);
  expect(result.error?.code).toBe("LLM_FAILED");
  expect(f.executed()).toBe(0);
  expect(model.requests).toHaveLength(2);
});
it("shares the correction credit with malformed edits", async () => {
  const f = fixture();
  f.context.executeTool = async () => ({
    ok: false,
    durationMs: 0,
    error: {
      code: "TOOL_FAILED",
      message: "bad format",
      retryable: false,
      details: { patchFailure: { kind: "FORMAT_INVALID", needsRead: false } },
    },
  });
  const model = new FakeLanguageModel([
    fakeModelResponse({ toolCalls: [{ id: randomUUID(), name: "applyPatch", input: {} }] }),
    fakeModelResponse({ finishReason: "LENGTH", toolCalls: [] }),
    finish(),
  ]);
  expect((await new DefaultAgentRuntime(model).run(request, f.context)).error?.code).toBe(
    "LLM_FAILED",
  );
  expect(model.requests).toHaveLength(2);
});
it("permits soft-boundary recovery but never sends an unaffordable correction", async () => {
  const f = fixture(),
    model = new FakeLanguageModel([
      fakeModelResponse({ finishReason: "LENGTH", toolCalls: [] }),
      finish(),
    ]);
  const lease = {
    initialLimit: 1,
    hardLimit: 3,
    onLimitReached: (s: { editCorrectionPending?: boolean }) =>
      s.editCorrectionPending
        ? { action: "EXTEND" as const, additionalSteps: 1 }
        : { action: "STOP" as const, reason: "NO_PROGRESS" as const },
  };
  const soft = await new DefaultAgentRuntime(model).run(
    { ...request, adaptiveStepBudget: lease },
    f.context,
  );
  expect(soft.status, JSON.stringify(soft.error)).toBe("SUCCEEDED");
  const blockedModel = new FakeLanguageModel([
    fakeModelResponse({ finishReason: "LENGTH", toolCalls: [] }),
    finish(),
  ]);
  const result = await new DefaultAgentRuntime(blockedModel).run(
    {
      ...request,
      adaptiveStepBudget: lease,
      executionBudget: { ...request.executionBudget, maxTotalTokens: 250 },
    },
    fixture().context,
  );
  expect(blockedModel.requests).toHaveLength(1);
  expect(result.error?.details).toMatchObject({ requestIssued: false });
});
it("restores consumed credit without resetting it, and rejects empty Repair completion", async () => {
  const serializer = new AgentStateSerializer();
  let saved: AgentState | undefined;
  const f = fixture();
  f.context.stateStore = {
    load: async () => saved,
    save: async (state) => {
      saved = serializer.deserialize(serializer.serialize(state));
    },
  };
  const model = new FakeLanguageModel([
    fakeModelResponse({ finishReason: "LENGTH", toolCalls: [] }),
    finish(),
  ]);
  const restored = await new DefaultAgentRuntime(model).run(request, f.context);
  expect(restored.status, JSON.stringify(restored.error)).toBe("SUCCEEDED");
  expect(saved?.executionRecovery?.used).toBe(true);
  expect(saved?.executionRecovery?.correctionReason).toBe("OUTPUT_LENGTH");
  if (saved) {
    delete saved.finalResult;
    saved.phase = "THINKING";
  }
  const next = new FakeLanguageModel([
    fakeModelResponse({ finishReason: "LENGTH", toolCalls: [] }),
    finish(),
  ]);
  expect((await new DefaultAgentRuntime(next).run(request, f.context)).error?.code).toBe(
    "LLM_FAILED",
  );
  expect(next.requests).toHaveLength(1);
  const empty = await new DefaultAgentRuntime(
    new FakeLanguageModel([fakeModelResponse({ text: "", toolCalls: [] })]),
  ).run(request, fixture().context);
  expect(empty.error?.code).toBe("AGENT_STALLED");
});

it("corrects a protocol error once at a closed exploration boundary and persists the shared credit", async () => {
  const f = fixture();
  let saved: AgentState | undefined;
  f.context.stateStore = {
    load: async () => undefined,
    save: async (state) => {
      saved = structuredClone(state);
    },
  };
  let reads = 0;
  f.context.executeTool = async () =>
    ++reads === 1
      ? {
          ok: false,
          durationMs: 0,
          error: {
            code: "VALIDATION_ERROR",
            message: "readFile.startLine must be positive",
            retryable: false,
          },
        }
      : {
          ok: true,
          durationMs: 0,
          output: {
            path: "a.py",
            fileSha256: "a".repeat(64),
            startLine: 1,
            endLine: 1,
            content: "import unused",
          },
        };
  const model = new FakeLanguageModel([
    fakeModelResponse({
      toolCalls: [{ id: randomUUID(), name: "readFile", input: { path: "a.py", startLine: -1 } }],
    }),
    async (r) => {
      expect(r.tools.map((t) => t.name)).toEqual(["readFile", "finishPhase"]);
      expect(saved?.executionRecovery).toMatchObject({
        used: true,
        correctionReason: "PROTOCOL_INVALID",
        correctionTool: "readFile",
      });
      return fakeModelResponse({
        toolCalls: [{ id: randomUUID(), name: "readFile", input: { path: "a.py", startLine: 1 } }],
      });
    },
    finish(),
  ]);
  const result = await new DefaultAgentRuntime(model).run(request, f.context);
  expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
  expect(reads).toBe(2);
});
it("does not count a repeated parameter failure as progress or renew correction after restore", async () => {
  const f = fixture();
  f.context.executeTool = async () => ({
    ok: false,
    durationMs: 0,
    error: { code: "VALIDATION_ERROR", message: "readFile.startLine invalid", retryable: false },
  });
  const response = fakeModelResponse({
    toolCalls: [{ id: randomUUID(), name: "readFile", input: { path: "a.py", startLine: -1 } }],
  });
  const model = new FakeLanguageModel([response, response, finish()]);
  const result = await new DefaultAgentRuntime(model).run(request, f.context);
  expect(result.error?.message).toContain("PROTOCOL_CORRECTION_EXHAUSTED");
  expect(model.requests).toHaveLength(2);
  const restored = new FakeLanguageModel([response, finish()]);
  const second = await new DefaultAgentRuntime(restored).run(
    {
      ...request,
      executionRecovery: {
        pending: false,
        used: true,
        explorationClosed: false,
        correctionReason: "PROTOCOL_INVALID",
        correctionTool: "readFile",
      },
    },
    f.context,
  );
  expect(second.error?.message).toContain("PROTOCOL_CORRECTION_EXHAUSTED");
  expect(restored.requests).toHaveLength(1);
});
it("allows one finishPhase field correction without bypassing evidence validation", async () => {
  const f = fixture();
  f.context.validateFinishPhase = (input) =>
    (input as { findingIds?: string[] }).findingIds?.length
      ? "finishPhase.findingId: unknown host ID"
      : undefined;
  const model = new FakeLanguageModel([
    fakeModelResponse({
      toolCalls: [
        {
          id: randomUUID(),
          name: "finishPhase",
          input: { summary: "blocked", outcome: "SCOPE_CONFLICT", findingIds: ["invented"] },
        },
      ],
    }),
    async (r) => {
      expect(r.tools.map((t) => t.name)).toEqual(["finishPhase"]);
      return finish();
    },
  ]);
  expect((await new DefaultAgentRuntime(model).run(request, f.context)).status).toBe("SUCCEEDED");
});

it.each(["EDIT_CORRECTION_REQUIRED: exploration is closed", "APPROVAL_SCOPE: denied"])(
  "does not spend protocol correction on host rejection: %s",
  async (reason) => {
    const f = fixture();
    let saved: AgentState | undefined;
    f.context.authorizeTool = () => reason;
    f.context.stateStore = {
      load: async () => undefined,
      save: async (s) => {
        saved = structuredClone(s);
      },
    };
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: randomUUID(), name: "readFile", input: { path: "new.py" } }],
      }),
      async (r) => {
        expect(JSON.stringify(r.messages)).toContain("HOST_AUTHORIZATION");
        expect(r.tools.map((t) => t.name)).toEqual(["finishPhase"]);
        expect(saved?.executionRecovery?.used ?? false).toBe(false);
        expect(saved?.executionRecovery?.pending ?? false).toBe(false);
        return finish();
      },
    ]);
    expect((await new DefaultAgentRuntime(model).run(request, f.context)).status).toBe("SUCCEEDED");
    expect(f.executed()).toBe(0);
  },
);

it("keeps a restored authorization handoff read-free and cannot renew it after repeated denial", async () => {
  const f = fixture(),
    model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: randomUUID(), name: "readFile", input: { path: "x.py" } }],
      }),
      fakeModelResponse({
        toolCalls: [{ id: randomUUID(), name: "readFile", input: { path: "y.py" } }],
      }),
    ]);
  const result = await new DefaultAgentRuntime(model).run(
    {
      ...request,
      executionRecovery: {
        pending: false,
        used: false,
        explorationClosed: true,
        authorizationHandoffUsed: true,
      },
    },
    f.context,
  );
  expect(result.status).toBe("FAILED");
  expect(result.error?.code).toBe("AGENT_STALLED");
  expect(model.requests).toHaveLength(1);
  expect(f.executed()).toBe(0);
});
