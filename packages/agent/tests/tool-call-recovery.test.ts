import { createHash, randomUUID } from "node:crypto";
import type { GitService } from "@devflow/git";
import type { SandboxSession } from "@devflow/sandbox";
import { PhaseCompletionSchema, type NewAgentEvent } from "@devflow/shared";
import {
  DefaultToolExecutor,
  ExplicitToolPolicy,
  registerCoreTools,
  ToolRegistry,
} from "@devflow/tools";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  AgentStateSerializer,
  DefaultAgentRuntime,
  FakeLanguageModel,
  fakeModelResponse,
  PostPatchController,
  type AgentRunRequest,
  type AgentState,
  type FakeModelStep,
  type RunContext,
} from "../src/index.js";

const sourcePath = "src/consumer.ts";
const implementationPath = "src/implementation.ts";
const source = "export { resolveDependency } from './implementation.js';\n";
const implementation = "export function resolveDependency() { return 'current'; }\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const call = (name: string, input: unknown) =>
  fakeModelResponse({ toolCalls: [{ id: randomUUID(), name, input }] });
const read = () => call("readFile", { path: sourcePath });
const malformed = () =>
  call("queryRelations", {
    paths:
      '<arg key="paths">["src/consumer.ts"]</arg><arg key="symbols">["resolveDependency"]</arg>',
  });
const corrected = () =>
  call("queryRelations", { paths: [sourcePath], symbols: ["resolveDependency"] });
const finish = () =>
  call("finishPhase", {
    summary: "Retain current evidence and unresolved behavior for the host",
    outcome: "INSUFFICIENT_EVIDENCE",
  });

/** Exercise the actual executor's schema boundary, rather than manufacture validation errors. */
function fixture(steps: FakeModelStep[]) {
  const serializer = new AgentStateSerializer();
  let saved: AgentState | undefined;
  const checkpoints: AgentState[] = [];
  const events: NewAgentEvent[] = [];
  const queryInputs: unknown[] = [];
  let queryOutput: unknown = {
    implementationEvidence: [
      {
        path: implementationPath,
        content: implementation,
        fileSha256: sha(implementation),
        startLine: 1,
        endLine: 1,
      },
    ],
    relations: [],
  };
  const registry = new ToolRegistry();
  const git: GitService = {
    status: async () => ({ clean: true, files: [] }),
    diff: async () => ({ patch: "", filesChanged: 0, truncated: false }),
    head: async () => "BASE",
  };
  registerCoreTools(registry, git);
  // This is the same descriptor contract used for the Worker's graph tool.
  registry.register({
    name: "queryRelations",
    description: "Read current graph relations and SHA-linked implementation evidence",
    inputSchema: z.object({
      paths: z.array(z.string().min(1).max(1024)).min(1).max(4),
      symbols: z.array(z.string().min(1).max(256)).max(6).optional(),
    }),
    outputSchema: z.unknown(),
    permission: "READ",
    timeoutMs: 1000,
    readOnly: true,
    parallelSafe: false,
    mutatesWorkspace: false,
    execute: async (input) => {
      queryInputs.push(input);
      return queryOutput;
    },
  });
  const executor = new DefaultToolExecutor(registry, new ExplicitToolPolicy(["READ"]));
  const sandbox: SandboxSession = {
    id: "tool-recovery",
    workspacePath: "/workspace",
    exec: async () => {
      throw new Error("No command expected during protocol recovery");
    },
    listFiles: async () => ({ entries: [], truncated: false }),
    readFile: async (input) => ({
      path: input.path,
      content: source,
      encoding: "utf8",
      truncated: false,
      fileSha256: sha(source),
      startLine: 1,
      endLine: 1,
    }),
    writeFile: async () => {
      throw new Error("Protocol correction cannot grant write permission");
    },
    applyPatch: async () => {
      throw new Error("Protocol correction cannot grant write permission");
    },
    dispose: async () => {},
  };
  const stateStore = {
    load: async () => saved,
    save: async (state: AgentState) => {
      saved = serializer.deserialize(serializer.serialize(state));
      checkpoints.push(saved);
    },
  };
  const context: RunContext = {
    runId: randomUUID(),
    stateStore,
    task: {
      taskId: randomUUID(),
      repositoryId: randomUUID(),
      title: "Resolve public behavior",
      description: "Keep the current public API and inspect dependency implementation",
    },
    signal: new AbortController().signal,
    tools: [
      ...registry.list().filter((tool) => ["readFile", "queryRelations"].includes(tool.name)),
      {
        name: "finishPhase",
        description: "Submit current candidate",
        inputSchema: PhaseCompletionSchema,
      },
    ],
    emit: async (event) => {
      events.push(event);
    },
    executeTool: async (stepId, tool, signal) =>
      executor.execute(tool, {
        runId: context.runId,
        stepId,
        sandbox,
        signal: signal ?? context.signal,
        emit: context.emit,
      }),
  };
  const request: AgentRunRequest = {
    codingSession: true,
    maxSteps: 8,
    timeoutMs: 10000,
    maxRetries: 0,
    postPatch: new PostPatchController([sourcePath]),
    modelSettings: { maxOutputTokens: 512 },
    convergenceReserve: { downstreamSteps: 0, downstreamTokens: 0 },
    executionBudget: {
      stage: "CODING",
      maxModelCalls: 8,
      maxToolCalls: 20,
      maxTotalTokens: 100000,
    },
  };
  const model = new FakeLanguageModel(steps);
  return {
    context,
    request,
    model,
    checkpoints,
    queryInputs,
    events,
    saved: () => saved,
    restore: (state: AgentState) => {
      saved = serializer.deserialize(serializer.serialize(state));
      context.runId = saved.runId;
    },
    queryOutput: (value: unknown) => {
      queryOutput = value;
    },
    run: () => new DefaultAgentRuntime(model).run(request, context),
  };
}

it("corrects malformed graph parameters at streak two, without treating the failure as progress", async () => {
  const f = fixture([
    read(),
    read(),
    malformed(),
    async (request) => {
      expect(request.tools.map((tool) => tool.name).sort()).toEqual([
        "finishPhase",
        "queryRelations",
      ]);
      const state = f.saved()!;
      expect(state.executionConvergence?.noProgressStreak).toBe(2);
      expect(state.executionRecovery).toMatchObject({
        pending: true,
        used: true,
        correctionReason: "PROTOCOL_INVALID",
        correctionTool: "queryRelations",
      });
      const error = request.messages.findLast(
        (message) => message.role === "TOOL" && message.toolName === "queryRelations",
      );
      expect(error).toMatchObject({
        isError: true,
        content: {
          code: "VALIDATION_ERROR",
          details: {
            category: "INVALID_ARGUMENT",
            failureOrigin: "INPUT_VALIDATION",
            fieldErrors: { paths: expect.any(Array) },
            recovery: {
              kind: "CORRECT_TOOL_ARGUMENTS",
              fieldIssues: [
                expect.objectContaining({
                  path: ["paths"],
                  expectedType: "array",
                  receivedType: "string",
                }),
              ],
              argumentSchema: {
                properties: {
                  paths: { type: "array" },
                  symbols: { type: "array" },
                },
              },
            },
          },
        },
      });
      expect(JSON.stringify(request.messages)).toContain("One shared bounded correction decision");
      return corrected();
    },
    async (request) => {
      expect(f.saved()?.executionConvergence?.noProgressStreak).toBe(0);
      expect(request.tools.map((tool) => tool.name)).toContain("readFile");
      expect(JSON.stringify(request.messages)).toContain(implementation.trim());
      return finish();
    },
  ]);
  const result = await f.run();
  expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
  expect(f.model.requests).toHaveLength(5);
  expect(f.queryInputs).toEqual([{ paths: [sourcePath], symbols: ["resolveDependency"] }]);
  expect(
    f.checkpoints.some(
      (state) =>
        state.executionRecovery?.pending && state.executionConvergence?.noProgressStreak === 2,
    ),
  ).toBe(true);
  expect(result.metrics.toolCalls).toBe(5);
  expect(f.saved()?.metrics.duplicateToolCalls).toBe(1);
});

it("stops a repeated malformed call after the single shared correction decision", async () => {
  const f = fixture([malformed(), malformed(), corrected(), finish()]);
  const result = await f.run();
  expect(result.error?.code).toBe("AGENT_STALLED");
  expect(result.error?.message).toContain("PROTOCOL_CORRECTION_EXHAUSTED");
  expect(f.model.requests).toHaveLength(2);
  expect(f.queryInputs).toHaveLength(0);
  expect(f.saved()?.executionRecovery?.used).toBe(true);
});

it.each(["correct", "repeat"])(
  "counts rejected finishPhase fields as no progress and permits only one %s decision",
  async (action) => {
    const invalidFinish = () =>
      call("finishPhase", { summary: 123, outcome: "INSUFFICIENT_EVIDENCE" });
    const f = fixture([
      invalidFinish(),
      async (request) => {
        expect(request.tools.map((tool) => tool.name)).toEqual(["finishPhase"]);
        expect(f.saved()?.executionConvergence?.noProgressStreak).toBe(1);
        expect(f.saved()?.executionRecovery).toMatchObject({
          used: true,
          pending: true,
          correctionTool: "finishPhase",
          correctionReason: "PROTOCOL_INVALID",
        });
        expect(JSON.stringify(request.messages)).toContain("summary");
        return action === "correct" ? finish() : invalidFinish();
      },
      finish(),
    ]);
    // A malformed finish is a control-level schema failure, independent of patch readiness.
    delete f.request.postPatch;
    const result = await f.run();
    expect(f.model.requests).toHaveLength(2);
    expect(f.queryInputs).toHaveLength(0);
    expect(
      f.checkpoints.some(
        (state) =>
          state.executionRecovery?.pending && state.executionConvergence?.noProgressStreak === 1,
      ),
    ).toBe(true);
    if (action === "correct") {
      expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
      expect(f.saved()?.executionConvergence?.noProgressStreak).toBe(0);
      expect((await f.run()).status).toBe("SUCCEEDED");
      expect(f.model.requests).toHaveLength(2);
    } else {
      expect(result.error?.code).toBe("AGENT_STALLED");
      expect(result.error?.message).toContain("PROTOCOL_CORRECTION_EXHAUSTED");
    }
  },
);

it.each([
  { paths: [sourcePath], symbols: "resolveDependency" },
  { paths: [] },
  { paths: [sourcePath, sourcePath, sourcePath, sourcePath, sourcePath] },
])("retains strict graph parameter types and bounds during recovery (%j)", async (input) => {
  const f = fixture([call("queryRelations", input), corrected(), finish()]);
  const result = await f.run();
  expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
  expect(f.queryInputs).toEqual([{ paths: [sourcePath], symbols: ["resolveDependency"] }]);
  expect(f.saved()?.executionRecovery).toMatchObject({ used: true, pending: false });
});

it("shares graph correction credit with Repair LENGTH recovery instead of granting another decision", async () => {
  const f = fixture([
    malformed(),
    corrected(),
    fakeModelResponse({ finishReason: "LENGTH", text: "incomplete", toolCalls: [] }),
    finish(),
  ]);
  f.request.repairMode = true;
  const result = await f.run();
  expect(result.error?.code).toBe("LLM_FAILED");
  expect(result.error?.message).toContain("shared correction credit is exhausted");
  expect(f.model.requests).toHaveLength(3);
  expect(f.queryInputs).toHaveLength(1);
  expect(f.saved()?.executionRecovery?.used).toBe(true);
});

it("does not call a syntactically corrected but evidence-free query substantive progress", async () => {
  const f = fixture([malformed(), corrected(), finish()]);
  f.queryOutput({ implementationEvidence: [], relations: [], metrics: { navigationCalls: 1 } });
  const result = await f.run();
  expect(result.error?.code).toBe("AGENT_STALLED");
  expect(result.error?.details).toMatchObject({ noProgressStreak: 2 });
  expect(f.model.requests).toHaveLength(2);
  expect(f.queryInputs).toHaveLength(1);
});

it("stops ordinary repeated observations at two decisions without new evidence", async () => {
  const f = fixture([read(), read(), read(), corrected()]);
  const result = await f.run();
  expect(result.error?.code).toBe("AGENT_STALLED");
  expect(result.error?.details).toMatchObject({ noProgressStreak: 2 });
  expect(f.model.requests).toHaveLength(3);
  expect(f.queryInputs).toHaveLength(0);
  expect(f.saved()?.executionRecovery?.used).toBe(false);
});

it("keeps budget limits and does not dispatch an unaffordable correction", async () => {
  const f = fixture([malformed(), corrected(), finish()]);
  f.request.executionBudget!.maxModelCalls = 1;
  const result = await f.run();
  expect(result.error?.code).toBe("EXECUTION_BUDGET_EXCEEDED");
  expect(result.error?.details).toMatchObject({ requestIssued: false });
  expect(f.model.requests).toHaveLength(1);
  expect(f.queryInputs).toHaveLength(0);
});

it("does not turn a host permission refusal into parameter correction", async () => {
  const f = fixture([corrected(), finish()]);
  f.request.repairMode = true;
  f.context.authorizeTool = (call) =>
    call.name === "finishPhase" ? undefined : "APPROVAL_SCOPE: target requires a new PLAN approval";
  const result = await f.run();
  expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
  expect(f.model.requests[1]!.tools.map((tool) => tool.name)).toEqual(["finishPhase"]);
  expect(JSON.stringify(f.model.requests[1]!.messages)).toContain("AUTHORIZATION_DENIED");
  expect(f.queryInputs).toHaveLength(0);
  expect(f.saved()?.executionRecovery).toMatchObject({ used: false, pending: false });
});

it("resumes pending correction with unchanged counters and does not renew spent credit", async () => {
  const original = fixture([read(), read(), malformed(), corrected(), finish()]);
  expect((await original.run()).status).toBe("SUCCEEDED");
  const pending = original.checkpoints.find(
    (state) =>
      state.executionRecovery?.pending && state.executionConvergence?.noProgressStreak === 2,
  )!;
  expect(pending).toBeDefined();
  const restored = fixture([
    async (request) => {
      expect(request.tools.map((tool) => tool.name).sort()).toEqual([
        "finishPhase",
        "queryRelations",
      ]);
      expect(restored.saved()?.metrics.toolCalls).toBe(pending.metrics.toolCalls);
      expect(restored.saved()?.executionConvergence?.noProgressStreak).toBe(2);
      expect(restored.saved()?.executionRecovery?.used).toBe(true);
      return corrected();
    },
    malformed(),
    corrected(),
  ]);
  restored.restore(pending);
  const result = await restored.run();
  expect(result.error?.code).toBe("AGENT_STALLED");
  expect(result.error?.message).toContain("PROTOCOL_CORRECTION_EXHAUSTED");
  expect(restored.model.requests).toHaveLength(2);
  expect(restored.queryInputs).toHaveLength(1);
  expect(restored.saved()?.phaseDeadlineAt).toBe(pending.phaseDeadlineAt);
  expect(result.metrics.toolCalls).toBe(pending.metrics.toolCalls + 2);
});

it.each(["before-dispatch", "after-dispatch"])(
  "blocks an interrupted protocol correction %s without reopening tools or resetting usage",
  async (boundary) => {
    const original = fixture([read(), read(), malformed(), corrected(), finish()]);
    expect((await original.run()).status).toBe("SUCCEEDED");
    const dispatched = boundary === "before-dispatch" ? 3 : 4;
    const interrupted = original.checkpoints.find(
      (state) =>
        state.phase === "THINKING" &&
        state.executionRecovery?.pending &&
        state.executionRecovery.used &&
        state.executionRecovery.correctionReason === "PROTOCOL_INVALID" &&
        state.metrics.modelRequestsDispatched === dispatched,
    )!;
    expect(interrupted).toBeDefined();
    const restored = fixture([corrected(), finish()]);
    restored.restore(interrupted);
    const result = await restored.run();
    expect(result.error?.code).toBe("AGENT_STALLED");
    expect(result.error?.message).toContain("TOOL_PROTOCOL_CORRECTION_INTERRUPTED");
    expect(result.error?.details).toMatchObject({ requestIssued: false });
    expect(restored.model.requests).toHaveLength(0);
    expect(restored.queryInputs).toHaveLength(0);
    expect(result.metrics.toolCalls).toBe(interrupted.metrics.toolCalls);
    expect(result.metrics.modelCalls).toBe(interrupted.metrics.modelCalls);
    expect(result.metrics.modelRequestsDispatched).toBe(dispatched);
    expect(restored.saved()?.stepCount).toBe(interrupted.stepCount);
    expect(restored.saved()?.phaseDeadlineAt).toBe(interrupted.phaseDeadlineAt);
    expect(restored.saved()?.executionConvergence?.noProgressStreak).toBe(2);
    expect(restored.saved()?.executionRecovery).toMatchObject({ used: true, pending: true });
  },
);

it("does not permit multiple corrected tool executions in a single recovery decision", async () => {
  const f = fixture([
    malformed(),
    fakeModelResponse({
      toolCalls: [
        {
          id: randomUUID(),
          name: "queryRelations",
          input: { paths: [sourcePath], symbols: ["resolveDependency"] },
        },
        {
          id: randomUUID(),
          name: "queryRelations",
          input: { paths: [implementationPath], symbols: ["resolveDependency"] },
        },
      ],
    }),
    finish(),
  ]);
  const result = await f.run();
  expect(result.error?.code).toBe("AGENT_STALLED");
  expect(f.model.requests).toHaveLength(2);
  expect(f.queryInputs.length).toBeLessThanOrEqual(1);
});
