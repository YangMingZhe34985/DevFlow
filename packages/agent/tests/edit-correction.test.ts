import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  DefaultAgentRuntime,
  FakeLanguageModel,
  fakeModelResponse,
  type RunContext,
} from "../src/index.js";

const response = (name: string) =>
  fakeModelResponse({
    toolCalls: [
      { id: randomUUID(), name, input: name === "finishPhase" ? { summary: "Done" } : {} },
    ],
  });
function fixture() {
  let calls = 0;
  const context: RunContext = {
    runId: randomUUID(),
    task: {
      taskId: randomUUID(),
      repositoryId: randomUUID(),
      title: "Fix",
      description: "Repair source",
    },
    signal: new AbortController().signal,
    tools: ["applyPatch", "replaceText", "readFile", "finishPhase"].map((name) => ({
      name,
      description: name,
      inputSchema: z.object({}).passthrough(),
      readOnly: name === "readFile" || name === "finishPhase",
      parallelSafe: false,
      mutatesWorkspace: name === "applyPatch" || name === "replaceText",
    })),
    emit: async () => {},
    executeTool: async (_, request) => {
      calls++;
      return request.name === "applyPatch"
        ? {
            ok: false,
            durationMs: 0,
            error: {
              code: "TOOL_FAILED",
              message: "corrupt patch",
              retryable: false,
              details: { patchFailure: { kind: "FORMAT_INVALID", needsRead: false } },
            },
          }
        : { ok: true, durationMs: 0, output: { applied: true } };
    },
  };
  return { context, calls: () => calls };
}
const lease = {
  initialLimit: 1,
  hardLimit: 3,
  onLimitReached: (s: { editCorrectionPending?: boolean }) =>
    s.editCorrectionPending
      ? { action: "EXTEND" as const, additionalSteps: 2 }
      : { action: "STOP" as const, reason: "NO_PROGRESS" as const },
};
it("reserves downstream time without turning the request estimate into a hidden model deadline", async () => {
  const f = fixture();
  const model = new FakeLanguageModel([
    async (_request, { signal }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      signal.throwIfAborted();
      return response("finishPhase");
    },
  ]);
  const result = await new DefaultAgentRuntime(model).run(
    {
      maxSteps: 2,
      maxRetries: 0,
      timeoutMs: 1000,
      timeReserve: { downstreamMs: 500, requestMs: 1 },
    },
    f.context,
  );
  expect(result.status).toBe("SUCCEEDED");
  expect(model.requests).toHaveLength(1);
});
it("offers one correction across the soft boundary and finishes after a successful edit", async () => {
  const f = fixture();
  const model = new FakeLanguageModel([
    response("applyPatch"),
    async (r) => {
      expect(r.tools.map((t) => t.name)).not.toContain("readFile");
      return fakeModelResponse({
        toolCalls: [...response("replaceText").toolCalls, ...response("finishPhase").toolCalls],
      });
    },
  ]);
  const result = await new DefaultAgentRuntime(model).run(
    { maxSteps: 3, timeoutMs: 1000, maxRetries: 0, adaptiveStepBudget: lease },
    f.context,
  );
  expect(result.status).toBe("SUCCEEDED");
  expect(f.calls()).toBe(2);
});

it("closes exploration before consuming downstream time, including a legacy request path", async () => {
  const f = fixture();
  const model = new FakeLanguageModel([
    async (r) => {
      expect(r.tools.map((t) => t.name)).not.toContain("readFile");
      expect(JSON.stringify(r.messages)).toContain("HOST_TIME_RESERVE");
      return response("finishPhase");
    },
  ]);
  const result = await new DefaultAgentRuntime(model).run(
    {
      maxSteps: 3,
      timeoutMs: 1000,
      maxRetries: 0,
      timeReserve: { downstreamMs: 750, requestMs: 100 },
    },
    f.context,
  );
  expect(result.status).toBe("SUCCEEDED");
});

it("does not issue a model request when the remaining phase time cannot retain Review", async () => {
  const f = fixture(),
    model = new FakeLanguageModel([]);
  const result = await new DefaultAgentRuntime(model).run(
    {
      maxSteps: 3,
      timeoutMs: 1000,
      maxRetries: 0,
      timeReserve: { downstreamMs: 980, requestMs: 100 },
    },
    f.context,
  );
  expect(result.error).toMatchObject({
    code: "EXECUTION_BUDGET_EXCEEDED",
    details: { requestIssued: false },
  });
  expect(f.calls()).toBe(0);
});
it("does not give a second correction after another invalid patch", async () => {
  const f = fixture(),
    model = new FakeLanguageModel([
      response("applyPatch"),
      response("applyPatch"),
      response("applyPatch"),
    ]);
  const result = await new DefaultAgentRuntime(model).run(
    {
      maxSteps: 4,
      timeoutMs: 1000,
      maxRetries: 0,
      adaptiveStepBudget: {
        ...lease,
        onLimitReached: (s) =>
          s.editCorrectionPending
            ? { action: "EXTEND", additionalSteps: 1 }
            : { action: "STOP", reason: "NO_PROGRESS" },
      },
    },
    f.context,
  );
  expect(result.error?.code).toBe("AGENT_STALLED");
  expect(model.requests).toHaveLength(2);
});
it("blocks an unaffordable correction before sending a provider request", async () => {
  const f = fixture(),
    model = new FakeLanguageModel([response("applyPatch"), response("replaceText")]);
  const result = await new DefaultAgentRuntime(model).run(
    {
      maxSteps: 3,
      timeoutMs: 1000,
      maxRetries: 0,
      adaptiveStepBudget: lease,
      modelSettings: { maxOutputTokens: 8192 },
      executionBudget: {
        stage: "EXECUTE",
        maxModelCalls: 3,
        maxToolCalls: 5,
        maxTotalTokens: 1000,
      },
    },
    f.context,
  );
  expect(model.requests).toHaveLength(1);
  expect(result.error?.details).toMatchObject({ requestIssued: false });
});
it("closes exploration before consuming the correction and downstream token reserve", async () => {
  const f = fixture();
  const model = new FakeLanguageModel([
    async (r) => {
      expect(r.tools.map((t) => t.name)).not.toContain("readFile");
      expect(JSON.stringify(r.messages)).toContain("HOST_CONVERGENCE");
      return response("finishPhase");
    },
  ]);
  const result = await new DefaultAgentRuntime(model).run(
    {
      maxSteps: 8,
      timeoutMs: 1000,
      maxRetries: 0,
      modelSettings: { maxOutputTokens: 512 },
      convergenceReserve: { downstreamSteps: 1, downstreamTokens: 500 },
      executionBudget: {
        stage: "EXECUTE",
        maxModelCalls: 8,
        maxToolCalls: 10,
        maxTotalTokens: 2500,
      },
    },
    f.context,
  );
  expect(result.status).toBe("SUCCEEDED");
});
it("permits only one bounded host-approved evidence refresh when exploration closes", async () => {
  const f = fixture();
  f.context.closingReadPaths = () => ["a.ts"];
  f.context.executeTool = async (_, call) => ({
    ok: true,
    durationMs: 0,
    output:
      call.name === "readFile"
        ? {
            path: "a.ts",
            content: "const current = 1;",
            fileSha256: "a".repeat(64),
            startLine: 1,
            endLine: 1,
          }
        : {},
  });
  const model = new FakeLanguageModel([
    async (request) => {
      expect(request.tools.map((t) => t.name)).toContain("readFile");
      return fakeModelResponse({
        toolCalls: [
          { id: randomUUID(), name: "readFile", input: { path: "a.ts", maxBytes: 1000 } },
        ],
      });
    },
    async (request) => {
      expect(request.tools.map((t) => t.name)).not.toContain("readFile");
      return response("finishPhase");
    },
  ]);
  const result = await new DefaultAgentRuntime(model).run(
    {
      maxSteps: 2,
      timeoutMs: 1000,
      maxRetries: 0,
      modelSettings: { maxOutputTokens: 512 },
      convergenceReserve: { downstreamSteps: 1, downstreamTokens: 500 },
      executionBudget: {
        stage: "REPAIR",
        maxModelCalls: 2,
        maxToolCalls: 4,
        maxTotalTokens: 20_000,
      },
    },
    f.context,
  );
  expect(result.status).toBe("SUCCEEDED");
  expect(model.requests).toHaveLength(2);
});
it("does not issue a closing refresh decision if the required subsequent finish and Review cannot fit", async () => {
  const f = fixture();
  f.context.closingReadPaths = () => ["a.ts"];
  const model = new FakeLanguageModel([response("readFile")]);
  const result = await new DefaultAgentRuntime(model).run(
    {
      maxSteps: 2,
      timeoutMs: 1000,
      maxRetries: 0,
      modelSettings: { maxOutputTokens: 512 },
      convergenceReserve: { downstreamSteps: 1, downstreamTokens: 500 },
      executionBudget: { stage: "REPAIR", maxModelCalls: 2, maxToolCalls: 4, maxTotalTokens: 1000 },
    },
    f.context,
  );
  expect(model.requests).toHaveLength(0);
  expect(result.error?.details).toMatchObject({ requestIssued: false });
});
it("gives one closing decision instead of killing a repeated-evidence loop before handoff", async () => {
  const f = fixture();
  f.context.executeTool = async () => ({
    ok: true,
    durationMs: 0,
    output: {
      path: "a.ts",
      content: "existing",
      fileSha256: "a".repeat(64),
      startLine: 1,
      endLine: 1,
    },
  });
  const model = new FakeLanguageModel([
    response("readFile"),
    response("readFile"),
    response("readFile"),
    async (r) => {
      expect(r.tools.map((t) => t.name)).not.toContain("readFile");
      return response("finishPhase");
    },
  ]);
  const result = await new DefaultAgentRuntime(model).run(
    {
      maxSteps: 8,
      timeoutMs: 1000,
      maxRetries: 0,
      modelSettings: { maxOutputTokens: 512 },
      convergenceReserve: { downstreamSteps: 1, downstreamTokens: 500 },
      executionBudget: {
        stage: "EXECUTE",
        maxModelCalls: 8,
        maxToolCalls: 10,
        maxTotalTokens: 20000,
      },
    },
    f.context,
  );
  expect(result.status).toBe("SUCCEEDED");
  expect(model.requests).toHaveLength(4);
});
