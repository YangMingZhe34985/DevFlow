import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ExecutionPacket, MutationResult } from "@devflow/shared";
import {
  PrePatchController,
  PREPATCH_DEFAULTS,
  DefaultAgentRuntime,
  FakeLanguageModel,
  fakeModelResponse,
  type ModelToolDescriptor,
} from "../src/index.js";

const packet = (): ExecutionPacket => ({
  version: "execution-packet-v1",
  goal: "Fix behavior",
  editTargets: [
    {
      path: "src/a.ts",
      symbol: "fix",
      operation: "MODIFY",
      rationale: "correct behavior",
    },
  ],
  inspectTargets: [{ path: "src/helper.ts", symbol: null, rationale: "direct helper" }],
  verificationHints: [],
  unresolvedQuestions: [],
  constraints: ["Preserve API"],
  baseCommitSha: "a",
  workspaceRevision: 0,
  evidenceRefs: [{ path: "src/a.ts", contentHash: "hash", workspaceRevision: 0 }],
  codeSlices: [
    {
      path: "src/a.ts",
      symbol: "fix",
      startLine: 1,
      endLine: 1,
      contentHash: "hash",
      workspaceRevision: 0,
      code: "function fix() { return 1; }",
      complete: true,
      truncated: false,
      fullFile: true,
      role: "EDIT",
    },
  ],
});
const make = (p = packet(), override: Partial<PrePatchController["limits"]> = {}) =>
  new PrePatchController(p, {
    ...PREPATCH_DEFAULTS,
    targetedReads: 4,
    searchQueries: 2,
    relocalizations: 1,
    ...override,
  });
const tool = (name: string): ModelToolDescriptor => ({
  name,
  description: "tool",
  inputSchema: z.object({ path: z.string().optional() }),
  readOnly: true,
  parallelSafe: true,
});

describe("approved inspect targets and bounded LENGTH recovery", () => {
  it("allows bounded public related reads without expanding approved writes", () => {
    const c = make(packet(), { allowPublicReads: true, targetedReads: 1 });
    expect(
      c.authorize({ name: "readFile", input: { path: "src/util.ts", maxBytes: 100 } }),
    ).toBeUndefined();
    expect(
      c.authorize({ name: "writeFile", input: { path: "src/util.ts", content: "edit" } }),
    ).toMatch(/OUTSIDE/);
    expect(
      c.authorize({ name: "readFile", input: { path: "src/util.ts", maxBytes: 100 } }),
    ).toMatch(/READ_BUDGET/);
  });
  it("reads every approved inspect target within the existing quota without granting edit authority", () => {
    const p = packet();
    p.inspectTargets.push({
      path: "src/a.test.ts",
      symbol: null,
      rationale: "approved regression",
    });
    const c = make(p, { targetedReads: 3 });
    for (const path of ["src/a.ts", "src/a.test.ts", "src/helper.ts"])
      expect(c.authorize({ name: "readFile", input: { path, maxBytes: 100 } })).toBeUndefined();
    expect(
      c.authorize({
        name: "readFile",
        input: { path: "src/a.ts", maxBytes: 100 },
      }),
    ).toMatch(/READ_BUDGET/);
    expect(c.authorize({ name: "writeFile", input: { path: "src/helper.ts" } })).toMatch(/OUTSIDE/);
    const fresh = make(p);
    expect(
      fresh.authorize({
        name: "batchReadFiles",
        input: {
          paths: ["src/helper.ts", "src/a.test.ts"],
          maxBytesPerFile: 100,
        },
      }),
    ).toBeUndefined();
    expect(
      fresh.authorize({
        name: "readFile",
        input: { path: "src/unapproved.ts" },
      }),
    ).toMatch(/OUTSIDE/);
    expect(fresh.targetedReads).toBe(2);
    expect(
      fresh.authorize({
        name: "readFile",
        input: { path: "src/a.ts", maxBytes: 2 ** 21 },
      }),
    ).toMatch(/SOURCE_BUDGET/);
  });

  const length = () =>
    fakeModelResponse({
      toolCalls: [],
      finishReason: "LENGTH",
      reasoningTokens: 6000,
      usage: { inputTokens: 100, outputTokens: 6000, totalTokens: 6100 },
    });
  const read = () =>
    fakeModelResponse({
      toolCalls: [
        {
          id: randomUUID(),
          name: "readFile",
          input: { path: "src/a.ts", maxBytes: 100 },
        },
      ],
    });
  const patch = () =>
    fakeModelResponse({
      toolCalls: [
        {
          id: randomUUID(),
          name: "applyPatch",
          input: {
            patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
          },
        },
      ],
    });
  const run = async (
    responses: ReturnType<typeof fakeModelResponse>[],
    options: {
      maxTotalTokens?: number;
      maxModelCalls?: number;
      prePatch?: boolean;
    } = {},
  ) => {
    const c = make(packet(), { adaptiveReserve: true });
    const model = new FakeLanguageModel(responses);
    const events: { type: string; payload: unknown }[] = [];
    const executed: string[] = [];
    const result = await new DefaultAgentRuntime(model).run(
      {
        ...(options.prePatch === false ? {} : { prePatch: c }),
        maxSteps: 12,
        maxRetries: 0,
        timeoutMs: 2000,
        systemPrompt: "Safety",
        executionBudget: {
          stage: "EXECUTE",
          maxModelCalls: options.maxModelCalls ?? 12,
          maxToolCalls: 36,
          maxTotalTokens: options.maxTotalTokens ?? 50000,
        },
      },
      {
        runId: randomUUID(),
        task: {
          taskId: randomUUID(),
          repositoryId: randomUUID(),
          title: "bounded recovery",
          description: "test",
        },
        signal: new AbortController().signal,
        tools: [
          tool("readFile"),
          {
            ...tool("applyPatch"),
            inputSchema: z.object({ patch: z.string() }),
            readOnly: false,
            parallelSafe: false,
            mutatesWorkspace: true,
          },
        ],
        authorizeTool: (request) => c.authorize(request),
        emit: async (event) => {
          events.push(event);
        },
        executeTool: async (_step, request) => {
          executed.push(request.name);
          return request.name === "applyPatch"
            ? {
                ok: true,
                durationMs: 0,
                output: {},
                mutation: {
                  status: "APPLIED",
                  mutationApplied: true,
                  workspaceChanged: true,
                  executionSucceeded: true,
                  mutationAttempted: true,
                  reason: "applied",
                  beforeRevision: 0,
                  afterRevision: 1,
                  changedFiles: ["src/a.ts"],
                  currentHashes: {},
                },
              }
            : {
                ok: true,
                durationMs: 0,
                output: { path: "src/a.ts", content: "current" },
              };
        },
      },
    );
    return { c, model, events, executed, result };
  };

  it("uses the third decision for one correction, retaining original LENGTH usage and excluding truncated text", async () => {
    const response = { ...length(), text: "TRUNCATED_PRIVATE_OUTPUT" };
    const { c, model, events, executed, result } = await run([
      read(),
      response,
      patch(),
      fakeModelResponse({ toolCalls: [] }),
    ]);
    expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
    expect(c.metrics()).toMatchObject({
      modelDecisions: 3,
      correctionDecisions: 1,
      lengthRecoveries: 1,
      TokensToFirstPatch: 6100,
    });
    expect(result.metrics.tokenUsage.totalTokens).toBe(6100);
    expect(result.metrics.reasoningTokens).toBe(6000);
    expect(executed).toEqual(["readFile", "applyPatch"]);
    expect(JSON.stringify(model.requests[2]?.messages)).toContain("MODEL_OUTPUT_LENGTH");
    expect(JSON.stringify(model.requests[2]?.messages)).not.toContain("TRUNCATED_PRIVATE_OUTPUT");
    expect(model.requests[2]?.tools.map((t) => t.name)).toEqual(["applyPatch"]);
    expect(
      events
        .filter((e) => e.type === "LLM_RESPONSE")
        .map((e) => (e.payload as { finishReason: string }).finishReason),
    ).toEqual(["TOOL_CALLS", "LENGTH", "TOOL_CALLS", "STOP"]);
  });
  it("stops on a second LENGTH without adding decisions or retries", async () => {
    const { c, model, result } = await run([length(), length(), patch()]);
    expect(model.requests).toHaveLength(2);
    expect(result.error?.code).toBe("LLM_FAILED");
    expect(result.metrics.tokenUsage.totalTokens).toBe(12200);
    expect(c.metrics()).toMatchObject({
      modelDecisions: 2,
      correctionDecisions: 1,
      lengthRecoveries: 1,
    });
  });
  it("cannot recover LENGTH on the final decision", async () => {
    const { c, model, result } = await run([read(), read(), length(), patch()]);
    expect(model.requests).toHaveLength(3);
    expect(result.error?.code).toBe("LLM_FAILED");
    expect(c.metrics().lengthRecoveries).toBe(0);
  });
  it("never executes incomplete tool actions attached to LENGTH", async () => {
    const { model, executed, result } = await run([{ ...length(), toolCalls: patch().toolCalls }]);
    expect(model.requests).toHaveLength(1);
    expect(executed).toEqual([]);
    expect(result.error?.code).toBe("LLM_FAILED");
  });
  it("rechecks the downstream token reserve before recovery", async () => {
    const { c, model, result } = await run([length(), patch()], {
      maxTotalTokens: 18000,
    });
    expect(model.requests).toHaveLength(1);
    expect(result.error?.code).toBe("PRE_PATCH_TOKEN_RESERVE_BLOCKED");
    expect(result.metrics.tokenUsage.totalTokens).toBe(6100);
    expect(c.metrics()).toMatchObject({
      modelDecisions: 1,
      blockedRequests: 1,
      lengthRecoveries: 1,
    });
  });
  it("rechecks the Run model-call limit before recovery", async () => {
    const { model, result } = await run([length(), patch()], {
      maxModelCalls: 1,
    });
    expect(model.requests).toHaveLength(1);
    expect(result.status).toBe("FAILED");
    expect(result.metrics.tokenUsage.totalTokens).toBe(6100);
  });
  it("keeps non-LENGTH failures and runs without prepatch unchanged", async () => {
    const filtered = await run([
      fakeModelResponse({ toolCalls: [], finishReason: "CONTENT_FILTER" }),
    ]);
    expect(filtered.model.requests).toHaveLength(1);
    expect(filtered.c.metrics().lengthRecoveries).toBe(0);
    expect(filtered.result.error?.code).toBe("LLM_FAILED");
    const ordinary = await run([length(), patch()], { prePatch: false });
    expect(ordinary.model.requests).toHaveLength(1);
    expect(ordinary.result.error?.code).toBe("LLM_FAILED");
  });
});
it("projects typed patch diagnostics and reserves a correction without rereading unchanged source", async () => {
  const c = make();
  c.preflight("safe", [], 50000);
  await c.observe(
    { name: "applyPatch", input: { patch: "invalid" } },
    {
      ok: false,
      durationMs: 0,
      error: {
        code: "TOOL_FAILED",
        message: "format",
        retryable: false,
        details: {
          patchFailure: {
            kind: "FORMAT_INVALID",
            message: "Correct numbered hunk",
            needsRead: false,
            diagnostics: ["corrupt patch at line 3"],
          },
        },
      },
    },
  );
  c.endDecision();
  expect(c.available(tool("readFile"))).toBe(false);
  const next = c.preflight("safe", [tool("applyPatch")], 50000);
  expect(next.request.messages[2]?.content).toContain("corrupt patch at line 3");
  expect(c.authorize({ name: "readFile", input: { path: "src/a.ts" } })).toMatch(
    /CORRECTION_REQUIRED/,
  );
  expect(() => c.endDecision()).toThrow(/Repeated current evidence/);
  expect(c.metrics()).toMatchObject({
    modelDecisions: 2,
    correctionDecisions: 1,
  });
});
it("allows one stale-target refresh and then one correction within the three-decision limit", async () => {
  const c = make();
  c.preflight("safe", [], 50000);
  await c.observe(
    { name: "applyPatch", input: {} },
    {
      ok: false,
      durationMs: 0,
      error: {
        code: "CONFLICT",
        message: "STALE_EVIDENCE",
        retryable: false,
        details: { path: "src/a.ts" },
      },
    },
  );
  c.endDecision();
  expect(c.available(tool("readFile"))).toBe(true);
  c.preflight("safe", [], 50000);
  expect(c.authorize({ name: "readFile", input: { path: "src/helper.ts" } })).toMatch(
    /STALE_EDIT_TARGET/,
  );
  expect(c.authorize({ name: "readFile", input: { path: "src/a.ts" } })).toBeUndefined();
  await c.observe(
    { name: "readFile", input: { path: "src/a.ts" } },
    {
      ok: true,
      durationMs: 0,
      output: { path: "src/a.ts", content: "fresh", truncated: false },
    },
  );
  c.endDecision();
  expect(c.available(tool("readFile"))).toBe(false);
  c.preflight("safe", [], 50000);
  expect(c.metrics()).toMatchObject({
    modelDecisions: 3,
    correctionDecisions: 1,
    recovery: { needsRead: false },
  });
});
it("persists denied and cached outcomes for the whole batch before terminating a decision", async () => {
  const c = make(),
    decisions: Record<string, unknown>[] = [];
  const read = { name: "readFile", input: { path: "src/a.ts" } };
  const model = new FakeLanguageModel([
    fakeModelResponse({ toolCalls: [{ ...read, id: "initial" }] }),
    fakeModelResponse({
      toolCalls: [
        { id: "denied", name: "readFile", input: { path: "../outside" } },
        { ...read, id: "cached" },
      ],
    }),
    fakeModelResponse({ toolCalls: [{ ...read, id: "reserved-read-denied" }] }),
  ]);
  const result = await new DefaultAgentRuntime(model).run(
    {
      prePatch: c,
      maxSteps: 3,
      maxRetries: 0,
      timeoutMs: 2000,
      executionBudget: {
        stage: "EXECUTE",
        maxModelCalls: 12,
        maxToolCalls: 36,
        maxTotalTokens: 50000,
      },
    },
    {
      runId: randomUUID(),
      task: {
        taskId: randomUUID(),
        repositoryId: randomUUID(),
        title: "test",
        description: "test",
      },
      signal: new AbortController().signal,
      tools: [tool("readFile")],
      availableTools: () => [tool("readFile")].filter((t) => c.available(t)),
      authorizeTool: (request) => c.authorize(request),
      emit: async (event) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.toolDecision) decisions.push(payload.toolDecision as Record<string, unknown>);
      },
      executeTool: async () => ({
        ok: true,
        durationMs: 0,
        output: { path: "src/a.ts", content: "current" },
      }),
    },
  );
  expect(model.requests).toHaveLength(3);
  expect(result.error?.code).toBe("PRE_PATCH_EXPLORATION_STALLED");
  expect(decisions.map((x) => x.callId)).toEqual([
    "initial",
    "denied",
    "cached",
    "reserved-read-denied",
  ]);
  expect(decisions[1]).toMatchObject({
    ok: false,
    executed: false,
    input: { path: "../outside" },
  });
  expect(decisions[2]).toMatchObject({
    ok: true,
    cached: true,
    executed: false,
  });
  expect(c.noProgress).toBe(3);
});
describe("per-attempt preflight and reserve", () => {
  it("counts system plus tool schemas and preserves all mandatory obligations", () => {
    const c = make();
    const f = c.preflight("Safety", [tool("readFile")], 50000);
    expect(f.request.messages[1]?.content).toContain("execution-packet-v1");
    expect(f.observation.toolSchemaEstimatedTokens).toBeGreaterThan(0);
    expect(Number(f.observation.estimatedInputTokens) + 6000 + 33000).toBeLessThanOrEqual(50000);
  });
  it("blocks reserve invasion before sending a request", () => {
    const c = make();
    expect(() => c.preflight("safe", [], 33000)).toThrowError(/reserve/);
    expect(c.metrics()).toMatchObject({
      blockedRequests: 1,
      modelDecisions: 0,
      TokensToFirstPatch: null,
    });
  });
  it("cannot trim safety/targets/hash/blocker away to satisfy a tiny cap", () => {
    const c = make(packet(), { contextTokenCap: 5 });
    c.blockers.push("current target is stale");
    expect(() => c.preflight("safety", [], 50000)).toThrow();
    expect(c.blockers[0]).toContain("stale");
  });
  it("deduplicates exact slices and removes stale revisions rather than replaying history", () => {
    const p = packet();
    p.codeSlices.push(
      { ...p.codeSlices[0]! },
      { ...p.codeSlices[0]!, workspaceRevision: 1, code: "STALE" },
    );
    const c = make(p);
    const f = c.preflight("safe", [], 50000);
    const data = JSON.parse(String(f.request.messages[1]!.content).split("\n").slice(1).join("\n"));
    expect(data.codeSlices).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain("STALE");
  });
  it("enforces a bounded model-decision budget without resetting the Run budget", () => {
    const c = make();
    for (let i = 0; i < 3; i++) c.preflight("safe", [], 50000);
    expect(() => c.preflight("safe", [], 50000)).toThrowError(/decisions exhausted/);
  });
  it("compresses source to a labelled target region, never dropping the target", () => {
    const p = packet();
    p.codeSlices[0]!.code = "function fix() {\n" + "x();\n".repeat(300);
    p.codeSlices[0]!.endLine = 302;
    const c = make(p, { contextTokenCap: 750 });
    const f = c.preflight("safe", [], 50000);
    expect(f.observation.compression).toContain(
      "BOUND_TARGET_REGION_KEEP_SIGNATURE_HASH_AND_OBLIGATION",
    );
    expect(f.request.messages[1]?.content).toContain("src/a.ts");
    expect(f.request.messages[1]?.content).toContain('"truncated":true');
  });
});
describe("bounded observable exploration and real mutation metrics", () => {
  it("starts direct without broad schemas; model text cannot grant tools", () => {
    const c = make();
    expect(c.level).toBe(0);
    expect(c.available(tool("searchCode"))).toBe(false);
    expect(c.available(tool("locateIssue"))).toBe(false);
    expect(c.available(tool("applyPatch"))).toBe(true);
  });
  it("enters Level 1 from structurally truncated source and Level 2 only on a failed read", async () => {
    const p = packet();
    p.codeSlices[0]!.truncated = true;
    const c = make(p);
    expect(c.level).toBe(1);
    await c.observe(
      { id: "a", name: "readFile", input: { path: "src/a.ts" } },
      {
        ok: false,
        durationMs: 1,
        error: { code: "NOT_FOUND", message: "absent", retryable: false },
      },
    );
    expect(c.level).toBe(2);
    expect(c.available(tool("searchCode"))).toBe(true);
    expect(
      c.authorize({
        name: "searchCode",
        input: { path: ".", query: "a", maxResults: 30 },
      }),
    ).toMatch(/MODULE/);
    expect(
      c.authorize({
        name: "searchCode",
        input: { path: "src", query: "a", maxResults: 30 },
      }),
    ).toBeUndefined();
  });
  it("no-op and ok=true alone do not become a patch", async () => {
    const c = make();
    await c.observe(
      { name: "applyPatch", input: {} },
      { ok: true, durationMs: 1, output: { applied: true } },
    );
    expect(c.metrics().TokensToFirstPatch).toBeNull();
  });
  it("counts the first authoritative APPLIED mutation and stops only prepatch projection", async () => {
    const c = make();
    c.preflight("safe", [], 50000);
    c.usage(100, 25);
    const mutation: MutationResult = {
      status: "APPLIED",
      mutationApplied: true,
      workspaceChanged: true,
      executionSucceeded: true,
      mutationAttempted: true,
      reason: "applied",
      beforeRevision: 0,
      afterRevision: 1,
      changedFiles: ["src/a.ts"],
      currentHashes: {},
    };
    await c.observe(
      { name: "applyPatch", input: {} },
      { ok: true, durationMs: 1, output: {}, mutation },
    );
    expect(c.active).toBe(false);
    expect(c.metrics()).toMatchObject({
      TokensToFirstPatch: 125,
      ModelCallsToFirstPatch: 1,
      ToolCallsToFirstPatch: 1,
    });
  });
  it("fails closed on repeated failed reads with metrics intact", async () => {
    const c = make();
    const result = {
      ok: false as const,
      durationMs: 1,
      error: {
        code: "NOT_FOUND" as const,
        message: "missing",
        retryable: false,
      },
    };
    c.preflight("safe", [], 50000);
    await c.observe({ name: "readFile", input: { path: "src/a.ts" } }, result);
    c.endDecision();
    c.preflight("safe", [], 50000);
    await c.observe({ name: "readFile", input: { path: "src/a.ts" } }, result);
    c.endDecision();
    c.preflight("safe", [], 50000);
    expect(c.authorize({ name: "readFile", input: { path: "src/a.ts" } })).toMatch(
      /CORRECTION_REQUIRED/,
    );
    expect(() => c.endDecision()).toThrowError(/Repeated current evidence/);
    expect(c.metrics()).toMatchObject({
      TokensToFirstPatch: null,
      ToolCallsToFirstPatch: null,
    });
  });
  it("denies traversal/new edit obligations and incomplete whole-file writes", () => {
    const c = make();
    expect(c.authorize({ name: "readFile", input: { path: "../secret" } })).toMatch(/OUTSIDE/);
    expect(
      c.authorize({
        name: "applyPatch",
        input: { patch: "--- a/other.ts\n+++ b/other.ts\n" },
      }),
    ).toMatch(/OUTSIDE/);
    const p = packet();
    p.codeSlices[0]!.fullFile = false;
    expect(
      make(p).authorize({
        name: "writeFile",
        input: { path: "src/a.ts", content: "x" },
      }),
    ).toMatch(/complete current file/);
  });
  it("runtime sends packet/state, not Task/history, and retains failed provider usage", async () => {
    const c = make();
    const model = new FakeLanguageModel([
      (request) => {
        expect(JSON.stringify(request.messages)).not.toContain("PRIVATE_FULL_TASK");
        return fakeModelResponse({
          toolCalls: [],
          usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
          text: "I want to explore",
        });
      },
    ]);
    const result = await new DefaultAgentRuntime(model).run(
      {
        prePatch: c,
        maxSteps: 12,
        maxRetries: 0,
        timeoutMs: 1000,
        systemPrompt: "Safety",
        executionBudget: {
          stage: "EXECUTE",
          maxModelCalls: 12,
          maxToolCalls: 36,
          maxTotalTokens: 50000,
        },
      },
      {
        runId: randomUUID(),
        task: {
          taskId: randomUUID(),
          repositoryId: randomUUID(),
          title: "PRIVATE_FULL_TASK",
          description: "PRIVATE_FULL_TASK",
        },
        signal: new AbortController().signal,
        tools: [],
        emit: async () => {},
        executeTool: async () => ({ ok: true, durationMs: 0, output: {} }),
      },
    );
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("PRE_PATCH_EXPLORATION_STALLED");
    expect(result.metrics.tokenUsage.totalTokens).toBe(50);
    expect(result.metrics.prePatch?.TokensToFirstPatch).toBeNull();
  });
});

describe("candidate-first reserve and real source expansion", () => {
  it("affords the historical 40119-token case while preserving mandatory downstream tokens", () => {
    const c = make(packet(), { adaptiveReserve: true });
    const f = c.preflight("Safety", [tool("readFile")], 40119);
    expect(f.observation.downstreamReserve).toBe(14041);
    expect(Number(f.observation.estimatedInputTokens) + 6000 + 14041).toBeLessThanOrEqual(40119);
    expect(f.request.settings?.maxOutputTokens).toBe(6000);
    expect(() =>
      make(packet(), { adaptiveReserve: true }).preflight("Safety", [], 12000),
    ).toThrow();
  });
  it("retains prior regions and makes two new reads available to the next decision", async () => {
    const p = packet();
    p.codeSlices[0]!.fullFile = false;
    p.codeSlices[0]!.complete = false;
    p.codeSlices[0]!.truncated = true;
    const c = new PrePatchController(
      p,
      {
        ...PREPATCH_DEFAULTS,
        adaptiveReserve: true,
        targetedReads: 4,
        searchQueries: 2,
        relocalizations: 1,
      },
      0,
      async (_path, _content, _revision, previous) => ({
        ...p.codeSlices[0]!,
        startLine: (previous?.endLine ?? 0) + 1,
        endLine: (previous?.endLine ?? 0) + 1,
        code: "NEXT_REGION_" + previous?.endLine,
      }),
    );
    const request = {
      name: "readFile",
      input: { path: "src/a.ts", maxBytes: 100 },
    };
    const result = {
      ok: true as const,
      durationMs: 0,
      output: { path: "src/a.ts", content: "current", truncated: false },
    };
    for (let i = 0; i < 2; i++) {
      expect(c.authorize(request)).toBeUndefined();
      await c.observe(request, result);
    }
    const f = c.preflight("Safety", [], 40119);
    expect(f.request.messages[1]?.content).toContain("NEXT_REGION_1");
    expect(f.request.messages[1]?.content).toContain("NEXT_REGION_2");
    expect(c.noProgress).toBe(0);
  });
});

it("reduces a large test region before destroying the smaller behavioral source region", () => {
  const p = packet();
  p.codeSlices[0] = {
    ...p.codeSlices[0]!,
    startLine: 170,
    endLine: 289,
    fullFile: false,
    truncated: true,
    complete: false,
    code:
      "// padding source\n".repeat(35) +
      "if (actualFlag) silentlyDropDefault();\n" +
      "// padding source\n".repeat(84),
  };
  p.editTargets.push({
    path: "test/a.ts",
    symbol: null,
    operation: "MODIFY",
    rationale: "Add regression",
  });
  p.codeSlices.push({
    ...p.codeSlices[0]!,
    path: "test/a.ts",
    startLine: 1,
    endLine: 440,
    code: "// Very large unrelated existing regression test fixture line with long content\n".repeat(
      440,
    ),
  });
  const f = make(p, { adaptiveReserve: true, contextTokenCap: 2000 }).preflight(
    "Safety",
    [],
    40119,
  );
  expect(f.request.messages[1]?.content).toContain("if (actualFlag) silentlyDropDefault();");
  expect(f.request.messages[1]?.content).toContain("test/a.ts");
});
