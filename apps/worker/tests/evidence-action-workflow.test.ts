import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { contentHash, FakeLanguageModel, fakeModelResponse, type WorkingSet } from "@devflow/agent";
import { SandboxGitService } from "@devflow/git";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import type { SandboxSession } from "@devflow/sandbox";
import { loadWorkerEnvironment } from "../src/config/env.js";
import {
  ApprovalWorkflowRunExecutor,
  createTools,
} from "../src/runs/approval-workflow-run-executor.js";

const original = "export const value = 1;\n";
function fixture() {
  let content = original,
    writes = 0;
  const sandbox = {
    id: "test",
    workspacePath: "/workspace",
    dispose: async () => undefined,
    readFile: async () => ({ path: "a.ts", content, truncated: false, encoding: "utf8" }),
    writeFile: async (input: { content: string; expectedSha256?: string }) => {
      if (input.expectedSha256 && input.expectedSha256 !== contentHash(content))
        throw new Error("CAS rejected");
      content = input.content;
      writes++;
      return { path: "a.ts", sha256: contentHash(content), sizeBytes: content.length };
    },
    exec: async () => {
      throw new Error("Broad command must not execute");
    },
  } as unknown as SandboxSession;
  const workingSet: WorkingSet = {
    version: "working-set-v1",
    evidenceVersion: "v7",
    workspaceRevision: 7,
    targetFiles: ["a.ts"],
    targetSymbols: [],
    relevantCode: [
      {
        path: "a.ts",
        contentHash: contentHash(original),
        startLine: 1,
        endLine: 2,
        workspaceRevision: 7,
        code: original,
        complete: true,
        role: "TARGET",
      },
    ],
    requiredInterfaces: [],
    relevantTests: [],
    constraints: [],
    uncertainty: [],
    evidenceSufficient: true,
    requiresAdditionalExploration: false,
    missingInformation: [],
  };
  const workflow = new ApprovalWorkflowRunExecutor(
    {
      events: { append: async () => undefined },
      artifacts: { list: async () => [] },
    } as unknown as DatabaseAdapter,
    loadWorkerEnvironment({
      DATABASE_URL: "unused",
      DEVFLOW_EVIDENCE_ACTION_ENABLED: "true",
    }),
  );
  const run = {
    id: randomUUID(),
    task: { id: randomUUID(), title: "Change value", description: "Change a.ts value to two" },
    repository: { id: randomUUID() },
  } as RunExecutionRecord;
  return {
    sandbox,
    workingSet,
    workflow,
    run,
    writes: () => writes,
    set: (value: string) => {
      content = value;
    },
  };
}
const finish = {
  id: "finish",
  name: "finishPhase",
  input: { summary: "Changed", outcome: "CHANGED" },
};
function execute(f: ReturnType<typeof fixture>, model: FakeLanguageModel) {
  return f.workflow["runAgentPhase"]({
    run: f.run,
    plan: {
      summary: "Change value",
      steps: [{ id: "change", title: "Change", description: "Minimal edit" }],
    },
    sandbox: f.sandbox,
    signal: new AbortController().signal,
    ...createTools(new SandboxGitService()),
    model,
    purpose: "IMPLEMENTATION",
    maxSteps: 6,
    adaptiveStepBudget: {
      initialLimit: 6,
      hardLimit: 6,
      onLimitReached: () => ({ action: "STOP", reason: "NO_PROGRESS" }),
    },
    timeoutMs: 900000,
    executionBudget: {
      stage: "EXECUTE",
      maxModelCalls: 6,
      maxToolCalls: 12,
      maxTotalTokens: 10000,
    },
    additionalContext: JSON.stringify(f.workingSet),
    workingSet: f.workingSet,
  });
}
it("passes current working code at a nonzero revision, gates fabricated search, and writes with CAS", async () => {
  const f = fixture();
  const model = new FakeLanguageModel([
    async (request) => {
      expect(JSON.stringify(request.messages)).toContain("export const value = 1");
      expect(request.tools.map((t) => t.name)).not.toContain("searchCode");
      expect(request.tools.map((t) => t.name)).not.toContain("applyPatch");
      return fakeModelResponse({
        toolCalls: [{ id: "s", name: "searchCode", input: { query: "value" } }],
      });
    },
    async (request) => {
      expect(request.messages.at(-1)).toMatchObject({ isError: true });
      return fakeModelResponse({
        toolCalls: [
          {
            id: "w",
            name: "writeFile",
            input: { path: "a.ts", content: "export const value = 2;\n" },
          },
          finish,
        ],
      });
    },
  ]);
  expect((await execute(f, model)).status).toBe("SUCCEEDED");
  expect(f.writes()).toBe(1);
});
it.each(["a.ts", "./a.ts"])(
  "does not overwrite stale target %s; bounded relocation accepts a fresh read",
  async (targetPath) => {
    const f = fixture();
    f.set("export const value = 9;\n");
    const write = {
      id: "w",
      name: "writeFile",
      input: { path: targetPath, content: "export const value = 2;\n" },
    };
    const model = new FakeLanguageModel([
      fakeModelResponse({ toolCalls: [write] }),
      async (request) => {
        expect(f.writes()).toBe(0);
        expect(request.tools.map((t) => t.name)).toContain("searchCode");
        return fakeModelResponse({
          toolCalls: [{ id: "read", name: "readFile", input: { path: "a.ts" } }],
        });
      },
      fakeModelResponse({ toolCalls: [{ ...write, id: "w2" }, finish] }),
    ]);
    expect((await execute(f, model)).status).toBe("SUCCEEDED");
    expect(f.writes()).toBe(1);
  },
);
