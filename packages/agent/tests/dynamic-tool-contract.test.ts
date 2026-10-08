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
  DefaultAgentRuntime,
  FakeLanguageModel,
  InMemoryAgentStateStore,
  fakeModelResponse,
  type AgentRunRequest,
  type FakeModelStep,
  type RunContext,
} from "../src/index.js";

const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const sourcePath = "src/current.ts";
const toolCall = (name: string, input: unknown) =>
  fakeModelResponse({ toolCalls: [{ id: randomUUID(), name, input }] });
const finish = () =>
  toolCall("finishPhase", { summary: "Hand candidate to validation", outcome: "CHANGED" });

function fixture(steps: FakeModelStep[], allowedPaths = [sourcePath]) {
  let source = "export const value = 1;\n";
  const readInputs: unknown[] = [];
  const events: NewAgentEvent[] = [];
  const store = new InMemoryAgentStateStore();
  const registry = new ToolRegistry();
  const git: GitService = {
    status: async () => ({ clean: true, files: [] }),
    diff: async () => ({ patch: "", filesChanged: 0, truncated: false }),
    head: async () => "BASE",
  };
  registerCoreTools(registry, git);
  const executor = new DefaultToolExecutor(registry, new ExplicitToolPolicy(["READ", "WRITE"]));
  const sandbox: SandboxSession = {
    id: "dynamic-contract",
    workspacePath: "/workspace",
    exec: async () => {
      throw new Error("unused");
    },
    listFiles: async () => ({ entries: [], truncated: false }),
    readFile: async (input) => {
      readInputs.push(input);
      return {
        path: input.path,
        content: source,
        encoding: "utf8",
        truncated: false,
        fileSha256: sha(source),
        startLine: 1,
        endLine: 1,
      };
    },
    writeFile: async (input) => {
      source = input.content;
      return { path: input.path, sha256: sha(source), sizeBytes: Buffer.byteLength(source) };
    },
    applyPatch: async () => {
      throw new Error("unused");
    },
    dispose: async () => {},
  };
  const context: RunContext = {
    runId: randomUUID(),
    stateStore: store,
    task: {
      taskId: randomUUID(),
      repositoryId: randomUUID(),
      title: "Fix behavior",
      description: "Keep the public contract",
    },
    signal: new AbortController().signal,
    tools: [
      ...registry.list().filter((tool) => ["readFile", "replaceText"].includes(tool.name)),
      { name: "finishPhase", description: "Submit candidate", inputSchema: PhaseCompletionSchema },
    ],
    closingReadPaths: () => allowedPaths,
    authorizeTool: (call) =>
      typeof (call.input as { path?: unknown }).path === "string" &&
      !allowedPaths.includes((call.input as { path: string }).path)
        ? "APPROVAL_SCOPE: outside approved source"
        : undefined,
    emit: async (event) => {
      events.push(event);
    },
    executeTool: async (stepId, call) => {
      expect((await store.load(context.runId))?.executionRecovery?.evidenceRefreshUsed).toBe(true);
      return executor.execute(call, {
        runId: context.runId,
        stepId,
        sandbox,
        signal: context.signal,
        emit: context.emit,
      });
    },
  };
  const request: AgentRunRequest = {
    repairMode: true,
    maxSteps: 6,
    timeoutMs: 10000,
    maxRetries: 0,
    executionRecovery: { pending: false, used: false, explorationClosed: true },
    modelSettings: { maxOutputTokens: 512 },
    executionBudget: {
      stage: "CODING",
      maxModelCalls: 6,
      maxToolCalls: 15,
      maxTotalTokens: 100000,
    },
  };
  const model = new FakeLanguageModel(steps);
  return {
    context,
    request,
    model,
    store,
    events,
    readInputs,
    registry,
    source: () => source,
    run: () => new DefaultAgentRuntime(model).run(request, context),
  };
}

it.each([undefined, 1, 16384])(
  "advertises and enforces the same closing refresh bound (%s)",
  async (maxBytes) => {
    const f = fixture([
      async (request) => {
        const read = request.tools.find((tool) => tool.name === "readFile")!;
        const schema = z.toJSONSchema(read.inputSchema) as {
          properties: { maxBytes: { maximum: number; default: number } };
        };
        expect(schema.properties.maxBytes).toMatchObject({ maximum: 16384, default: 16384 });
        expect(read.inputSchema.safeParse({ path: sourcePath, maxBytes: 16385 }).success).toBe(
          false,
        );
        return toolCall("readFile", {
          path: sourcePath,
          ...(maxBytes === undefined ? {} : { maxBytes }),
        });
      },
      toolCall("replaceText", {
        path: sourcePath,
        expectedSha256: sha("export const value = 1;\n"),
        oldText: "value = 1",
        newText: "value = 2",
      }),
      finish(),
    ]);
    const result = await f.run();
    expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
    expect(f.source()).toContain("value = 2");
    expect(f.readInputs[0]).toMatchObject({ maxBytes: maxBytes ?? 16384 });
    expect(f.registry.get("readFile")!.inputSchema.parse({ path: sourcePath })).toMatchObject({
      maxBytes: 200000,
    });
    expect((await f.store.load(f.context.runId))?.executionRecovery).toMatchObject({
      evidenceRefreshUsed: true,
      authorizationHandoffUsed: false,
    });
  },
);

it.each([0, 16385, 200000, 1.5, "16384"])(
  "classifies invalid closing maxBytes %s without consuming refresh or forcing submission",
  async (maxBytes) => {
    const f = fixture([
      toolCall("readFile", { path: sourcePath, maxBytes }),
      async (request) => {
        const saved = await f.store.load(f.context.runId);
        expect(saved?.executionRecovery).toMatchObject({
          evidenceRefreshUsed: false,
          authorizationHandoffUsed: false,
          used: true,
        });
        expect(JSON.stringify(request.messages)).toContain("INVALID_ARGUMENT");
        expect(JSON.stringify(request.messages)).not.toContain("HOST_AUTHORIZATION_HANDOFF");
        expect(request.tools.map((tool) => tool.name)).toEqual(["readFile", "finishPhase"]);
        const schema = request.tools[0]!.inputSchema;
        expect(schema.safeParse({ path: sourcePath, maxBytes: 16385 }).success).toBe(false);
        return toolCall("readFile", { path: sourcePath, maxBytes: 16384 });
      },
      toolCall("replaceText", {
        path: sourcePath,
        expectedSha256: sha("export const value = 1;\n"),
        oldText: "value = 1",
        newText: "value = 2",
      }),
      finish(),
    ]);
    const result = await f.run();
    expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
    expect(
      f.readInputs.filter((input) => (input as { maxBytes: number }).maxBytes === 16384),
    ).toHaveLength(1);
    expect(f.source()).toContain("value = 2");
    expect((await f.store.load(f.context.runId))?.executionRecovery).toMatchObject({
      evidenceRefreshUsed: true,
      authorizationHandoffUsed: false,
      used: true,
    });
  },
);

it("preserves the original path during parameter correction without granting a second refresh", async () => {
  const f = fixture(
    [
      toolCall("readFile", { path: sourcePath, maxBytes: 200000 }),
      toolCall("readFile", { path: "src/other.ts", maxBytes: 16384 }),
      async (request) => {
        expect(JSON.stringify(request.messages)).toContain("PROTOCOL_CORRECTION_SCOPE");
        expect(JSON.stringify(request.messages)).not.toContain("HOST_AUTHORIZATION_HANDOFF");
        return finish();
      },
    ],
    [sourcePath, "src/other.ts"],
  );
  expect((await f.run()).status).toBe("SUCCEEDED");
  expect(f.readInputs).toHaveLength(0);
  expect((await f.store.load(f.context.runId))?.executionRecovery?.evidenceRefreshUsed).toBe(false);
});

it("classifies an exhausted refresh as exploration while keeping approved edits available", async () => {
  const f = fixture([
    toolCall("readFile", { path: sourcePath, maxBytes: 16384 }),
    toolCall("readFile", { path: sourcePath, maxBytes: 16384 }),
    async (request) => {
      expect(JSON.stringify(request.messages)).toContain("EXPLORATION_LIMIT");
      expect(JSON.stringify(request.messages)).not.toContain("HOST_AUTHORIZATION_HANDOFF");
      expect(request.tools.map((tool) => tool.name)).toContain("replaceText");
      expect(request.tools.map((tool) => tool.name)).not.toContain("readFile");
      return toolCall("replaceText", {
        path: sourcePath,
        expectedSha256: sha("export const value = 1;\n"),
        oldText: "value = 1",
        newText: "value = 2",
      });
    },
    finish(),
  ]);
  expect((await f.run()).status).toBe("SUCCEEDED");
  expect(
    f.readInputs.filter((input) => (input as { maxBytes: number }).maxBytes === 16384),
  ).toHaveLength(1);
  expect((await f.store.load(f.context.runId))?.executionRecovery?.used).toBe(false);
});

it("does not enlarge a smaller registered read cap or discard source-range refinements", async () => {
  const f = fixture([
    async (request) => {
      const read = request.tools.find((tool) => tool.name === "readFile")!;
      const schema = z.toJSONSchema(read.inputSchema) as {
        properties: { maxBytes: { maximum: number; default: number } };
      };
      expect(schema.properties.maxBytes).toMatchObject({ maximum: 128, default: 64 });
      expect(read.inputSchema.safeParse({ path: sourcePath, maxBytes: 129 }).success).toBe(false);
      expect(read.inputSchema.safeParse({ path: sourcePath, startLine: 1 }).success).toBe(false);
      return toolCall("readFile", { path: sourcePath, startLine: 1, endLine: 1 });
    },
    finish(),
  ]);
  f.context.tools = f.context.tools.map((tool) =>
    tool.name === "readFile"
      ? {
          ...tool,
          inputSchema: z
            .object({
              path: z.string(),
              maxBytes: z.number().int().positive().max(128).default(64),
              startLine: z.number().int().positive().optional(),
              endLine: z.number().int().positive().optional(),
            })
            .refine((input) => (input.startLine === undefined) === (input.endLine === undefined), {
              path: ["endLine"],
              message: "Both range bounds are required",
            }),
        }
      : tool,
  );
  expect((await f.run()).status).toBe("SUCCEEDED");
  expect(f.readInputs[0]).toMatchObject({ maxBytes: 64, startLine: 1, endLine: 1 });
});

it("restores the consumed refresh without advertising or admitting another read", async () => {
  const f = fixture([
    async (request) => {
      expect(request.tools.map((tool) => tool.name)).not.toContain("readFile");
      return toolCall("readFile", { path: sourcePath, maxBytes: 16384 });
    },
    async (request) => {
      expect(JSON.stringify(request.messages)).toContain("EXPLORATION_LIMIT");
      expect(request.tools.map((tool) => tool.name)).toContain("replaceText");
      return finish();
    },
  ]);
  f.request.executionRecovery = {
    pending: false,
    used: false,
    explorationClosed: true,
    evidenceRefreshUsed: true,
  };
  expect((await f.run()).status).toBe("SUCCEEDED");
  expect(f.readInputs).toHaveLength(0);
  expect((await f.store.load(f.context.runId))?.executionRecovery).toMatchObject({
    evidenceRefreshUsed: true,
    used: false,
    authorizationHandoffUsed: false,
  });
});

it("still rejects an unauthorized path and provides only the existing bounded scope handoff", async () => {
  const f = fixture([
    toolCall("readFile", { path: "src/unapproved.ts", maxBytes: 16384 }),
    async (request) => {
      expect(JSON.stringify(request.messages)).toContain("AUTHORIZATION_DENIED");
      expect(request.tools.map((tool) => tool.name)).toEqual(["finishPhase"]);
      return toolCall("finishPhase", { summary: "Need a new approval", outcome: "SCOPE_CONFLICT" });
    },
  ]);
  expect((await f.run()).status).toBe("SUCCEEDED");
  expect(f.readInputs).toHaveLength(0);
  expect((await f.store.load(f.context.runId))?.executionRecovery).toMatchObject({
    evidenceRefreshUsed: false,
    used: false,
    authorizationHandoffUsed: true,
  });
});
