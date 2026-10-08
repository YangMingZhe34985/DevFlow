import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  DefaultAgentRuntime,
  FakeLanguageModel,
  fakeModelResponse,
  PostPatchController,
  contentHash,
  type ModelToolCall,
  InMemoryAgentStateStore,
  type AgentStateStore,
} from "../src/index.js";
import type { MutationResult } from "@devflow/shared";

const write: ModelToolCall = {
  id: "w",
  name: "writeFile",
  input: { path: "a.ts", content: "new" },
};
const finish: ModelToolCall = {
  id: "f",
  name: "finishPhase",
  input: { summary: "The issue is fixed!", outcome: "CHANGED" },
};
const read: ModelToolCall = { id: "r", name: "readFile", input: { path: "a.ts" } };

it("retains approved Plan inspect reads after a mutation without adding them to write scope", () => {
  const controller = new PostPatchController(["a.ts"]);
  controller.necessaryReadPaths = ["a.ts", "interface.ts"];
  controller.firstMutationEndedAt = Date.now();
  expect(controller.authorize("readFile", ["interface.ts"])).toBeUndefined();
  expect(controller.authorize("writeFile", ["interface.ts"])).toContain("only planned targets");
  expect(controller.authorize("readFile", ["unapproved.ts"])).toContain("only planned targets");
});
async function run(
  options: {
    reserve?: boolean;
    auto?: boolean;
    noop?: boolean;
    calls?: ModelToolCall[][];
    maxSteps?: number;
    maxTools?: number;
    initialContent?: string;
    stateStore?: AgentStateStore;
    runId?: string;
  } = {},
) {
  const c = new PostPatchController(["a.ts"], 4, options.auto);
  let current = options.initialContent ?? "old";
  const tools = ["writeFile", "readFile", "gitDiff", "finishPhase", "searchCode"].map((name) => ({
    name,
    description: name,
    inputSchema: z.unknown(),
  }));
  const calls = options.calls ?? [[write], [finish]];
  const model = new FakeLanguageModel(
    calls.map((toolCalls, i) => async (request) => {
      if (i > 0 && c.active) {
        const text = JSON.stringify(request.messages);
        expect(text).toContain("POST_PATCH_COMPLETION");
        expect(text).toContain("Approved plan (follow this plan)");
        expect(text).toContain("Task:");
        expect(request.tools.map((t) => t.name)).not.toContain("searchCode");
        expect(c.ready).toBe(false);
        if (options.reserve && i === calls.length - 1)
          expect(request.tools.map((t) => t.name)).toEqual(["finishPhase"]);
        else expect(request.tools.map((t) => t.name)).toContain("writeFile");
      }
      return fakeModelResponse({
        toolCalls,
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      });
    }),
  );
  const result = await new DefaultAgentRuntime(model).run(
    {
      maxSteps: options.maxSteps ?? calls.length,
      maxRetries: 0,
      timeoutMs: 3000,
      approvedPlan: {
        summary: "Update a.ts",
        steps: [{ id: "edit", title: "Edit", description: "Correct a.ts" }],
      },
      additionalContext: "STALE_WORKING_SET EXPLORATION_HISTORY",
      postPatch: c,
      ...(options.reserve
        ? {
            modelSettings: { maxOutputTokens: 512 },
            convergenceReserve: { downstreamSteps: 0, downstreamTokens: 100 },
          }
        : {}),
      executionBudget: {
        stage: "EXECUTE",
        maxModelCalls: 10,
        maxToolCalls: options.maxTools ?? 20,
        maxTotalTokens: options.reserve ? 10000 : 1000,
      },
      emitRunLifecycle: false,
    },
    {
      runId: options.runId ?? randomUUID(),
      ...(options.stateStore ? { stateStore: options.stateStore } : {}),
      signal: new AbortController().signal,
      task: {
        taskId: randomUUID(),
        repositoryId: randomUUID(),
        title: "Edit",
        description: "Edit a.ts",
      },
      tools,
      emit: async () => undefined,
      executeTool: async (_step, request) => {
        if (request.name === "writeFile") {
          const next = String((request.input as { content: string }).content);
          const unchanged = options.noop || next === current;
          const mutation: MutationResult = {
            status: unchanged ? "NO_OP" : "APPLIED",
            executionSucceeded: true,
            mutationAttempted: true,
            mutationApplied: !unchanged,
            workspaceChanged: !unchanged,
            reason: unchanged ? "CONTENT_IDENTICAL" : "CONTENT_CHANGED",
            beforeRevision: c.revision,
            afterRevision: c.revision + (unchanged ? 0 : 1),
            changedFiles: unchanged ? [] : ["a.ts"],
            currentHashes: { "a.ts": contentHash(next) },
          };
          if (!unchanged) current = next;
          c.observeMutation(mutation, ["a.ts"]);
          return { ok: true, output: {}, durationMs: 1, mutation };
        }
        if (request.name === "gitDiff")
          c.observeDiff(
            current === "old" ? "" : `valid current diff:${current}`,
            current === "old" ? [] : ["a.ts"],
            true,
          );
        return {
          ok: true,
          output: { path: "a.ts", fileSha256: contentHash(current), content: current },
          durationMs: 1,
        };
      },
    },
  );
  return { result, model, c };
}
it("finishes via one minimal completion call, with truthful summary and exact postpatch accounting", async () => {
  const { result } = await run();
  expect(result.status).toBe("SUCCEEDED");
  expect(result.summary).not.toContain("issue is fixed");
  expect(result.executeCompletion).toMatchObject({
    outcome: "PATCH_READY",
    metrics: {
      postPatchModelCalls: 1,
      postPatchToolCalls: 2,
      postPatchInputTokens: 10,
      postPatchOutputTokens: 2,
      postPatchGitDiffCalls: 1,
    },
  });
  expect(result.metrics.toolCalls).toBe(3);
});
it("same-batch write + finish checks the deterministic diff first without another model call", async () => {
  const { result } = await run({ calls: [[write, finish]] });
  expect(result.executeCompletion).toMatchObject({
    outcome: "PATCH_READY",
    metrics: { postPatchModelCalls: 0 },
  });
});
it("closing model exploration preserves the authoritative post-write diff probe and handoff", async () => {
  const { result } = await run({ reserve: true, calls: [[write], [finish]] });
  expect(result.status).toBe("SUCCEEDED");
  expect(result.executeCompletion?.outcome).toBe("PATCH_READY");
  expect(result.executeCompletion?.metrics.postPatchGitDiffCalls).toBe(1);
});
it("legacy auto mode cannot complete without an explicit finish decision", async () => {
  expect((await run({ auto: true, calls: [[write]] })).result.executeCompletion?.outcome).toBe(
    "NEEDS_MORE_WORK",
  );
  const { result, c } = await run({ auto: true, calls: [[write]], maxTools: 1 });
  expect(result.executeCompletion?.failure).toBe("BUDGET_EXHAUSTED_BEFORE_PATCH");
  expect(c.active).toBe(false);
});
it("no-op writes and real nonprogress never become a candidate", async () => {
  const { result } = await run({ noop: true, calls: [[write], [write]] });
  expect(result.executeCompletion).toMatchObject({
    outcome: "FAILED",
    state: "NO_PATCH",
    failure: "REAL_NO_PROGRESS",
    metrics: { PostPatchConvergenceMs: null, postPatchModelCalls: null },
  });
});
it("does not confuse a stable candidate with an explicit completion", async () => {
  const { result } = await run({ calls: [[write], [read], [read], [read]] });
  expect(result.status).toBe("FAILED");
  expect(result.executeCompletion?.failure).toBe("REAL_NO_PROGRESS");
});
it("STOP without a valid mutation cannot claim completion", async () => {
  const { result } = await run({ calls: [[]] });
  expect(result.status).toBe("FAILED");
  expect(result.executeCompletion?.state).toBe("NO_PATCH");
  expect(result.executeCompletion?.failure).toBe("NO_VALID_PATCH");
});
it("continues approved edits after a stable diff, then submits without an extra confirmation", async () => {
  const second = { ...write, id: "w2", input: { path: "a.ts", content: "complete" } };
  const { result, model } = await run({ calls: [[write], [second], [finish]] });
  expect(result.status).toBe("SUCCEEDED");
  expect(model.requests).toHaveLength(3);
  expect(result.executeCompletion?.metrics.postPatchMutationAttempts).toBe(1);
});
it("does not require a stable patch's other approved candidate to be modified", () => {
  const c = new PostPatchController(["a.ts", "b.ts"]);
  c.observeMutation(
    {
      status: "APPLIED",
      executionSucceeded: true,
      mutationAttempted: true,
      mutationApplied: true,
      workspaceChanged: true,
      reason: "changed",
      beforeRevision: 0,
      afterRevision: 1,
      changedFiles: ["a.ts"],
      currentHashes: { "a.ts": "new" },
    },
    ["a.ts"],
  );
  c.observeDiff("candidate", ["a.ts"], true);
  expect(c.canSubmit).toBe(true);
  expect(c.ready).toBe(false);
  expect(c.submit()).toBe(true);
});
it("stops two oscillating candidates without using an extra summary call", async () => {
  const alternative = { ...write, id: "other", input: { path: "a.ts", content: "alternative" } };
  const { result, model } = await run({
    calls: [
      [write],
      [alternative],
      [{ ...write, id: "again" }],
      [{ ...alternative, id: "again2" }],
      [finish],
    ],
  });
  expect(result.error?.details).toMatchObject({ stopReason: "STALLED", noProgressStreak: 2 });
  expect(result.executeCompletion?.outcome).toBe("NEEDS_MORE_WORK");
  expect(model.requests).toHaveLength(4);
});
it("retains nonprogress and candidate identities across resume and revalidates before submit", async () => {
  const store = new InMemoryAgentStateStore(),
    runId = randomUUID();
  await run({ calls: [[write], [read]], runId, stateStore: store });
  const checkpoint = (await store.load(runId))!;
  expect(checkpoint.executionConvergence?.noProgressStreak).toBe(1);
  delete checkpoint.finalResult;
  checkpoint.phase = "THINKING";
  await store.save(checkpoint);
  const stopped = await run({
    calls: [[read]],
    runId,
    stateStore: store,
    maxSteps: 5,
    initialContent: "new",
  });
  expect(stopped.model.requests).toHaveLength(1);
  expect(stopped.result.error?.details).toMatchObject({ noProgressStreak: 2 });
  // A separately resumed unfinished snapshot can explicitly hand off once it is revalidated.
  await store.save(checkpoint);
  const submitted = await run({
    calls: [[finish]],
    runId,
    stateStore: store,
    maxSteps: 5,
    initialContent: "new",
  });
  expect(submitted.result.status).toBe("SUCCEEDED");
  expect(submitted.c.calls.diff).toBe(2);
  const completed = await run({
    calls: [],
    maxSteps: 5,
    runId,
    stateStore: store,
    initialContent: "new",
  });
  expect(completed.result.status).toBe("SUCCEEDED");
  expect(completed.model.requests).toHaveLength(0);
});
it("does not reset an expired deadline or trust a legacy automatic completion", async () => {
  const store = new InMemoryAgentStateStore(),
    runId = randomUUID();
  await run({ calls: [[write]], runId, stateStore: store });
  const saved = (await store.load(runId))!;
  delete saved.finalResult;
  saved.phaseDeadlineAt = Date.now() - 1000;
  await store.save(saved);
  const expired = await run({ calls: [[finish]], maxSteps: 5, runId, stateStore: store });
  expect(expired.result.status).toBe("TIMED_OUT");
  expect(expired.model.requests).toHaveLength(0);
  saved.finalResult = {
    ...expired.result,
    status: "SUCCEEDED",
    executeCompletion: {
      ...expired.result.executeCompletion!,
      outcome: "PATCH_READY",
      state: "PATCH_READY",
    },
  };
  delete saved.postPatch;
  await store.save(saved);
  const legacy = await run({ calls: [[finish]], maxSteps: 5, runId, stateStore: store });
  expect(legacy.result.error?.message).toContain("LEGACY_COMPLETION_UNCONFIRMED");
  expect(legacy.model.requests).toHaveLength(0);
});
