import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  FakeLanguageModel,
  fakeModelResponse,
  PostPatchController,
  contentHash,
  type ModelRequest,
} from "@devflow/agent";
import { DockerSandboxManager, type SandboxSession } from "@devflow/sandbox";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import { DevflowError, type NewAgentEvent } from "@devflow/shared";
import {
  normalizeMutation,
  observePostPatchTool,
  requestPaths,
  plannedTargets,
  plannedTargetScope,
  verificationContract,
} from "../src/runs/post-patch.js";
import { ApprovalWorkflowRunExecutor } from "../src/runs/approval-workflow-run-executor.js";
import { loadWorkerEnvironment } from "../src/config/env.js";
import { WorkflowBudgetLedger } from "../src/runs/workflow-budget.js";
import { createWorkflowMetrics } from "../src/runs/workflow-metrics.js";

afterEach(() => vi.restoreAllMocks());
it("does not issue Review when input plus configured output exceeds the remaining budget", async () => {
  const events: NewAgentEvent[] = [];
  const db = {
    runs: { transition: async () => ({}) },
    events: {
      append: async (e: NewAgentEvent) => {
        events.push(e);
      },
    },
  } as unknown as DatabaseAdapter;
  const reviewer = new FakeLanguageModel([]);
  const workflow = new ApprovalWorkflowRunExecutor(
    db,
    loadWorkerEnvironment({ DATABASE_URL: "unused" }),
    undefined,
    () => reviewer,
  );
  const run = {
    id: "review-budget",
    task: { title: "Fix", description: "Fix supported behavior" },
  } as RunExecutionRecord;
  await expect(
    workflow["review"](
      run,
      { summary: "Fix", steps: [] },
      "diff",
      {
        exitCode: 0,
        stdout: "pass",
        stderr: "",
        timedOut: false,
        durationMs: 1,
        outputTruncated: false,
      },
      new AbortController().signal,
      0,
      createWorkflowMetrics(),
      new WorkflowBudgetLedger({
        maxSteps: 10,
        maxReviewRetries: 1,
        maxTotalTokens: 5,
        timeoutMs: 10000,
      }),
    ),
  ).rejects.toMatchObject({
    code: "EXECUTION_BUDGET_EXCEEDED",
    details: { stage: "REVIEW", requestIssued: false, remainingTokens: 5 },
  });
  expect(events.some((e) => e.type === "LLM_REQUEST")).toBe(false);
});
const ok = { ok: true as const, output: {}, durationMs: 1 };
it("does not infer a command's entire mutation scope from unvalidated path hints", () => {
  expect(
    requestPaths({
      name: "runCommand",
      input: { program: "node", args: [], path: "a.ts", paths: ["b.ts"] },
    }),
  ).toEqual([]);
  expect(requestPaths({ name: "replaceText", input: { path: "src/a.ts" } })).toEqual(["src/a.ts"]);
});
it("normalizes execution success separately from APPLIED, NO_OP, rejected, malformed and unobserved mutations", () => {
  expect(normalizeMutation(ok, { a: "old" }, { a: "new" }, ["a"], 5)).toMatchObject({
    status: "APPLIED",
    mutationApplied: true,
    beforeRevision: 5,
    afterRevision: 6,
  });
  expect(normalizeMutation(ok, { a: "same" }, { a: "same" }, ["a"], 5)).toMatchObject({
    status: "NO_OP",
    mutationApplied: false,
    afterRevision: 5,
  });
  expect(
    normalizeMutation({ ...ok, output: { applied: false } }, { a: "old" }, { a: "old" }, ["a"], 5),
  ).toMatchObject({ status: "REJECTED", executionSucceeded: true, mutationApplied: false });
  expect(normalizeMutation(ok, {}, {}, [], 5).status).toBe("FAILED");
  expect(
    normalizeMutation(
      {
        ok: false,
        durationMs: 0,
        error: new DevflowError({ code: "CONFLICT", message: "STALE" }).toJSON(),
      },
      { a: "old" },
      { a: "old" },
      ["a"],
      5,
    ),
  ).toMatchObject({ status: "REJECTED", workspaceChanged: false });
});
it("distinguishes complete unchanged failures from partial or unknown mutation observations", () => {
  const failed = {
    ok: false as const,
    durationMs: 1,
    error: new DevflowError({ code: "CONFLICT", message: "TEXT_MATCH_COUNT" }).toJSON(),
  };
  expect(normalizeMutation(failed, { a: "same" }, { a: "same" }, ["a"], 2)).toMatchObject({
    observationComplete: true,
    affectedPaths: ["a"],
    changedFiles: [],
    workspaceChanged: false,
    beforeRevision: 2,
    afterRevision: 2,
  });
  expect(normalizeMutation(failed, { a: "old" }, { a: "new" }, ["a"], 2)).toMatchObject({
    status: "REJECTED",
    observationComplete: true,
    changedFiles: ["a"],
    workspaceChanged: true,
    afterRevision: 3,
  });
  expect(normalizeMutation(failed, { a: "old" }, {}, ["a"], 2)).toMatchObject({
    observationComplete: false,
    affectedPaths: ["a"],
    workspaceChanged: false,
  });
  expect(normalizeMutation(failed, {}, {}, [], 2).observationComplete).toBe(false);
  expect(
    normalizeMutation(failed, { a: "old", b: "old" }, { a: "new" }, ["a", "b"], 2)
      .observationComplete,
  ).toBe(false);
});
it("requires an explicit submission of a current diff, not edits to every approved target", () => {
  const c = new PostPatchController(["a", "b"], 5);
  c.observeMutation(normalizeMutation(ok, { a: "old" }, { a: "new" }, ["a"], 5), ["a"]);
  c.observeDiff("diff", ["a"], true);
  expect(c.state).toBe("PATCH_STABLE");
  expect(c.ready).toBe(false);
  expect(c.canSubmit).toBe(true);
  expect(c.authorize("writeFile", ["a"])).toBeUndefined();
  c.observeMutation(normalizeMutation(ok, { b: "old" }, { b: "new" }, ["b"], 6), ["b"]);
  c.observeDiff("diff", ["a", "b"], true);
  expect(c.submit()).toBe(true);
  expect(c.authorize("searchCode", [])).toContain("POST_PATCH_GATE");
  expect(c.authorize("writeFile", ["a"])).toContain("POST_PATCH_GATE");
  expect(c.authorize("readFile", ["other"])).toContain("POST_PATCH_GATE");
  c.observeDiff("diff", ["a", "b", "unrelated"], true);
  expect(c.ready).toBe(false);
  c.observeDiff("diff", ["a", "b"], false);
  expect(c.ready).toBe(false);
  expect(c.result(false, "MAX_STEPS_EXCEEDED").failure).toBe("BUDGET_EXHAUSTED_AFTER_PATCH");
});
it("does not reuse a candidate as current evidence after external content drift", async () => {
  const c = new PostPatchController(["a.ts"]);
  c.observeMutation(normalizeMutation(ok, { "a.ts": "old" }, { "a.ts": "expected" }, ["a.ts"], 0), [
    "a.ts",
  ]);
  await observePostPatchTool({
    controller: c,
    request: { name: "gitDiff", input: {} },
    sandbox: {
      readFile: async () => ({ content: "unexpected", truncated: false }),
      exec: async () => {
        throw new Error("status unavailable");
      },
    } as unknown as SandboxSession,
    signal: new AbortController().signal,
    execute: async () => ({
      ...ok,
      output: { patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n", truncated: false },
    }),
  });
  expect(c.ready).toBe(false);
  expect(c.result(false).failure).toBe("PATCH_STALE");
});
it("does not infer issue verification from passing regression tests, review, or missing tests", () => {
  expect(verificationContract("PATCH_READY", "TEST_PASSED", "REVIEW_PASSED")).toMatchObject({
    issue: "VERIFICATION_INCONCLUSIVE",
    reason: "ISSUE_REPRODUCTION_NOT_ESTABLISHED",
  });
  expect(verificationContract("PATCH_READY", "SKIPPED", "REVIEW_PASSED").test).toBe("SKIPPED");
  expect(plannedTargets({ summary: "Edit a.ts and b.ts", steps: [] }, ["a.ts"])).toEqual([
    "a.ts",
    "b.ts",
  ]);
});

it("keeps inspect/test/preserve references distinct from explicit edit targets without test-file exceptions", () => {
  const plan = {
    summary: "Fix arithmetic and preserve regression tests",
    steps: [
      { id: "read", title: "Inspect", description: "Read a.ts and tests/regression.ts" },
      { id: "fix", title: "Correct behavior", description: "Update a.ts" },
      { id: "test", title: "Run tests", description: "Run tests/regression.ts" },
    ],
  };
  expect(plannedTargets(plan, ["a.ts"])).toEqual(["a.ts"]);
  expect(plannedTargets({ summary: "Edit tests/regression.ts", steps: [] }, ["a.ts"])).toEqual([
    "tests/regression.ts",
  ]);
  expect(
    plannedTargets({ summary: "Fix a.ts and preserve tests/regression.ts", steps: [] }, []),
  ).toEqual(["a.ts"]);
  expect(plannedTargets({ summary: "Edit a.ts and preserve a.ts", steps: [] }, ["a.ts"])).toEqual(
    [],
  );
});

it("observed writes use CAS even without a WorkingSet", async () => {
  const c = new PostPatchController(["a.ts"]);
  const request = { name: "writeFile", input: { path: "a.ts", content: "new" } };
  let content = "old";
  const result = await observePostPatchTool({
    controller: c,
    request,
    signal: new AbortController().signal,
    sandbox: { readFile: async () => ({ content, truncated: false }) } as unknown as SandboxSession,
    execute: async () => {
      expect(request.input).toMatchObject({ expectedSha256: contentHash("old") });
      content = "new";
      return ok;
    },
  });
  expect(result.mutation?.status).toBe("APPLIED");
});

it("does not interpret a following preservation sentence as forbidding the edited file", () => {
  const scope = plannedTargetScope(
    {
      summary: "Fix behavior",
      steps: [
        {
          id: "edit",
          title: "Apply the fix",
          description: "Edit a.ts to correct behavior. Do not modify tests/a.ts or package.json.",
        },
      ],
    },
    ["a.ts"],
  );
  expect(scope.requiredTargets).toEqual(["a.ts"]);
  expect(scope.blockers).toEqual([]);
});

it("a filtered diff view cannot erase current completion evidence without a revision change", async () => {
  const c = new PostPatchController(["a.ts"]);
  c.observeMutation(normalizeMutation(ok, { "a.ts": "old" }, { "a.ts": "new" }, ["a.ts"], 0), [
    "a.ts",
  ]);
  c.observeDiff("authoritative global diff", ["a.ts"], true);
  await observePostPatchTool({
    controller: c,
    request: { name: "gitDiff", input: { paths: ["a.ts"] } },
    sandbox: {} as SandboxSession,
    signal: new AbortController().signal,
    execute: async () => ({ ...ok, output: { patch: "a partial view", truncated: true } }),
  });
  expect(c.canSubmit).toBe(true);
  expect(c.diff).toBe("authoritative global diff");
});

it("verification of an edited file does not attach a following unchanged-test constraint to it", () => {
  const scope = plannedTargetScope(
    {
      summary: "Repair service behavior",
      steps: [
        {
          id: "edit",
          title: "Apply fix",
          description: "Edit src/service.ts to correct the result.",
        },
        {
          id: "review",
          title: "Final review",
          description:
            "Verify src/service.ts contains the correction, the public test file is unchanged, and the test passes.",
        },
      ],
    },
    ["src/service.ts", "tests/public.ts"],
  );
  expect(scope.requiredTargets).toEqual(["src/service.ts"]);
  expect(scope.blockers).toEqual([]);
});

it("evidence candidates and rejected capabilities do not become unfulfilled edit obligations", () => {
  const scope = plannedTargetScope(
    {
      summary: "Fix behavior",
      steps: [
        {
          id: "read",
          title: "Identify problem",
          description: "Read package.json and tests/behavior.ts to find the change",
        },
      ],
    },
    ["a.ts", "package.json", "tests/behavior.ts"],
  );
  expect(scope.requiredTargets).toEqual([]);
  const c = new PostPatchController(scope.targets, 0, false, scope.requiredTargets);
  c.observeMutation(
    {
      ...normalizeMutation(ok, {}, {}, [], 0),
      status: "REJECTED",
      mutationAttempted: false,
      executionSucceeded: false,
      reason: "Tool is not available in this phase.",
    },
    [],
  );
  c.observeMutation(normalizeMutation(ok, { "a.ts": "old" }, { "a.ts": "new" }, ["a.ts"], 0), [
    "a.ts",
  ]);
  c.observeDiff("valid", ["a.ts"], true);
  expect(c.canSubmit).toBe(true);
  expect(
    plannedTargetScope({ summary: "Edit a.ts and preserve a.ts", steps: [] }, ["a.ts"]).blockers,
  ).toEqual(["CONFLICTING_PLAN_TARGET:a.ts"]);
});

function fixture(skipTests = false) {
  let content = "export const value = 0;\n";
  const original = content;
  let testCalls = 0;
  const order: string[] = [];
  const sandbox = {
    id: "test",
    workspacePath: "/workspace",
    dispose: async () => undefined,
    listFiles: async () => ({
      entries: ["a.ts", ...(skipTests ? [] : ["package.json"])].map((path) => ({
        path,
        kind: "FILE",
        sizeBytes: 80,
      })),
      truncated: false,
    }),
    readFile: async ({ path }: { path: string }) => {
      if (path === "a.ts")
        return { path, content, truncated: false, fileSha256: contentHash(content) };
      if (path === "package.json" && !skipTests)
        return { path, content: '{"scripts":{"test":"node --test"}}', truncated: false };
      throw new DevflowError({ code: "NOT_FOUND", message: "missing" });
    },
    writeFile: async (input: { content: string }) => {
      content = input.content;
      order.push("WRITE");
      return { path: "a.ts", sizeBytes: content.length, sha256: contentHash(content) };
    },
    exec: async (input: { program: string; args?: string[] }) => {
      let stdout = "",
        exitCode = 0;
      const args = input.args ?? [];
      if (input.program === "git") {
        if (args[0] === "diff")
          stdout =
            content === original
              ? ""
              : args.includes("--numstat")
                ? "1\t1\ta.ts\n"
                : `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-${original.trim()}\n+${content.trim()}\n`;
        else if (args[0] === "status")
          stdout = "## main\0" + (content === original ? "" : " M a.ts\0");
        else if (args[0] === "rev-parse") stdout = "a".repeat(40);
      } else {
        order.push("TEST");
        testCalls++;
        exitCode = content.includes("value = 1") ? 1 : 0;
        stdout = exitCode ? "expected value 2" : "tests passed";
      }
      return {
        stdout,
        stderr: "",
        exitCode,
        durationMs: 1,
        timedOut: false,
        outputTruncated: false,
      };
    },
  } as unknown as SandboxSession;
  return { sandbox, order, tests: () => testCalls };
}

it("runs public diagnostics on a stalled stable candidate without converting it into completion", async () => {
  const f = fixture();
  vi.spyOn(DockerSandboxManager.prototype, "create").mockResolvedValue(f.sandbox);
  const artifacts: { name: string; content?: string }[] = [];
  const plan = {
    summary: "Update a.ts",
    steps: [{ id: "edit", title: "Edit", description: "Update a.ts" }],
  };
  const db = {
    approvals: { list: async () => [{ kind: "PLAN", status: "APPROVED", request: { plan } }] },
    events: { list: async () => [], append: async () => {} },
    artifacts: {
      list: async () => artifacts,
      create: async (a: { name: string; content?: string }) => {
        artifacts.push(a);
        return { ...a, id: randomUUID() };
      },
    },
    runs: { transition: async () => ({}) },
  } as unknown as DatabaseAdapter;
  const model = new FakeLanguageModel([
    fakeModelResponse({
      toolCalls: [
        {
          id: "write",
          name: "writeFile",
          input: {
            path: "a.ts",
            content: "export const value = 2;\n",
          },
        },
      ],
    }),
    ...Array.from({ length: 4 }, (_, i) =>
      fakeModelResponse({
        toolCalls: [{ id: `r${i}`, name: "readFile", input: { path: "a.ts" } }],
      }),
    ),
  ]);
  const reviewer = new FakeLanguageModel([]);
  const workflow = new ApprovalWorkflowRunExecutor(
    db,
    loadWorkerEnvironment({
      DATABASE_URL: "unused",
      DEVFLOW_POST_PATCH_CONVERGENCE_ENABLED: "true",
    }),
    () => model,
    () => reviewer,
  );
  const result = await workflow["executeApprovedPlan"](
    {
      id: randomUUID(),
      currentStage: "EXECUTE",
      status: "RUNNING",
      retryCount: 0,
      maxSteps: 12,
      maxTestRetries: 1,
      maxReviewRetries: 1,
      repository: {
        id: randomUUID(),
        sourceKind: "GIT",
        sourceUri: "https://example.invalid/repo.git",
      },
      task: {
        id: randomUUID(),
        title: "Update",
        description: "Update a.ts",
        baseCommitSha: "a".repeat(40),
      },
    } as RunExecutionRecord,
    new AbortController().signal,
  );
  expect(result.status).toBe("FAILED");
  expect(result.executeCompletion).toMatchObject({
    outcome: "NEEDS_MORE_WORK",
    termination: "NO_PROGRESS",
  });
  expect(result.verification?.test).toBe("TEST_PASSED");
  expect(f.order.filter((e) => e === "TEST")).toHaveLength(1);
  expect(reviewer.requests).toHaveLength(0);
  expect(artifacts.some((a) => a.name === "execute-unfinished-candidate-v1.json")).toBe(true);
});

function reviewedFindings(request: ModelRequest) {
  const message = request.messages.find(
    (m) =>
      m.role === "USER" &&
      typeof m.content === "string" &&
      m.content.includes("Current source and host protection policy:\n"),
  );
  const text = typeof message?.content === "string" ? message.content : "";
  return (
    JSON.parse(
      text
        .split("Current source and host protection policy:\n")[1]
        ?.split("\n\nTest evidence")[0] ?? "{}",
    ).findingHistory ?? []
  );
}
it.each([
  ["PASS", false],
  ["NEEDS_EVIDENCE", false],
  ["PASS", true],
] as const)(
  "host supplements Review within shared rounds, then independently returns %s without artificial Repair",
  async (finalVerdict, omitRequests) => {
    const f = fixture();
    vi.spyOn(DockerSandboxManager.prototype, "create").mockResolvedValue(f.sandbox);
    const artifacts: { name: string; content?: string }[] = [],
      events: NewAgentEvent[] = [];
    const plan = {
      summary: "Fix value",
      complexity: "COMPLEX",
      estimatedSteps: 20,
      confidence: 0.8,
      steps: [{ id: "edit", title: "Edit", description: "Fix a.ts" }],
    };
    const db = {
      approvals: { list: async () => [{ kind: "PLAN", status: "APPROVED", request: { plan } }] },
      events: {
        list: async () => [],
        append: async (e: NewAgentEvent) => {
          events.push(e);
        },
      },
      artifacts: {
        list: async () => artifacts,
        create: async (a: { name: string; content?: string }) => {
          artifacts.push(a);
          return { ...a, id: randomUUID() };
        },
      },
      runs: { transition: async () => ({}) },
    } as unknown as DatabaseAdapter;
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [
          {
            id: "edit",
            name: "writeFile",
            input: { path: "a.ts", content: "export const value = 2;\n" },
          },
          {
            id: "finish",
            name: "finishPhase",
            input: { summary: "Candidate ready", outcome: "CHANGED" },
          },
        ],
      }),
    ]);
    const reviewer = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [],
        text: JSON.stringify({
          verdict: "NEEDS_EVIDENCE",
          summary: "Need current value",
          issues: omitRequests
            ? [
                {
                  kind: "EVIDENCE_GAP",
                  severity: "medium",
                  message: "Need current value",
                  evidence: { path: "a.ts", quote: "value = 2" },
                },
              ]
            : [],
          ...(omitRequests
            ? {}
            : {
                evidenceRequests: [
                  { path: "a.ts", symbol: "value", question: "Read current implementation" },
                ],
              }),
        }),
      }),
      async (request) => {
        expect(request.tools).toEqual([]);
        expect(JSON.stringify(request.messages)).toContain('\\"used\\":true');
        expect(JSON.stringify(request.messages)).toContain(
          contentHash("export const value = 2;\n"),
        );
        return fakeModelResponse({
          toolCalls: [],
          text: JSON.stringify({
            verdict: finalVerdict,
            summary:
              finalVerdict === "PASS"
                ? "Current code satisfies the issue"
                : "Still missing API contract",
            issues:
              omitRequests && finalVerdict === "PASS"
                ? reviewedFindings(request).map((f: { findingId: string }) => ({
                    findingId: f.findingId,
                    kind: "EVIDENCE_GAP",
                    severity: "medium",
                    disposition: "RESOLVED",
                    message: "Current value observed",
                    evidence: { path: "a.ts", quote: "value = 2" },
                    behavior: {
                      scenario: "Read value",
                      expected: "2",
                      actual: "2",
                      requirementBasis: "ISSUE",
                      requirement: "Update a.ts",
                    },
                  }))
                : [],
            ...(finalVerdict === "PASS"
              ? {}
              : { evidenceRequests: [{ path: "a.ts", question: "Read again" }] }),
          }),
        });
      },
      ...(finalVerdict === "NEEDS_EVIDENCE"
        ? [
            fakeModelResponse({
              toolCalls: [],
              text: JSON.stringify({
                verdict: "NEEDS_EVIDENCE",
                summary: "API contract is still unavailable after two rounds",
                issues: [],
                evidenceRequests: [{ path: "a.ts", question: "Still missing contract" }],
              }),
            }),
          ]
        : []),
    ]);
    const workflow = new ApprovalWorkflowRunExecutor(
      db,
      loadWorkerEnvironment({
        DATABASE_URL: "unused",
        DEVFLOW_POST_PATCH_CONVERGENCE_ENABLED: "true",
        DEVFLOW_POST_PATCH_AUTOFINISH_ENABLED: "true",
      }),
      () => model,
      () => reviewer,
    );
    const run = {
      id: randomUUID(),
      currentStage: "EXECUTE",
      status: "RUNNING",
      retryCount: 0,
      maxSteps: 30,
      maxTestRetries: 1,
      maxReviewRetries: 1,
      repository: {
        id: randomUUID(),
        sourceKind: "GIT",
        sourceUri: "https://example.invalid/repo.git",
      },
      task: {
        id: randomUUID(),
        title: "Change value",
        description: "Update a.ts",
        baseCommitSha: "a".repeat(40),
      },
    } as RunExecutionRecord;
    const result = await workflow["executeApprovedPlan"](run, new AbortController().signal);
    expect(result.status, JSON.stringify(result)).toBe(
      finalVerdict === "PASS" ? "SUCCEEDED" : "FAILED",
    );
    if (finalVerdict !== "PASS")
      expect(result.error?.details).toMatchObject({ workflowCode: "REVIEW_EVIDENCE_UNRESOLVED" });
    expect(artifacts.filter((a) => a.name === "review-evidence-supplement-v1.json")).toHaveLength(
      finalVerdict === "NEEDS_EVIDENCE" ? 2 : 1,
    );
    if (omitRequests)
      expect(artifacts.filter((a) => a.name === "review-host-feedback-v1.json")).toHaveLength(0);
    expect(events.filter((e) => e.type === "REPAIR_STARTED")).toHaveLength(0);
    expect(f.order.filter((e) => e === "WRITE")).toHaveLength(1);
  },
);

it.each([false, true])(
  "Gate A: actual auto-finish workflow retains TEST/REPAIR/REVIEW boundary (skip=%s)",
  async (skip) => {
    const f = fixture(skip);
    vi.spyOn(DockerSandboxManager.prototype, "create").mockResolvedValue(f.sandbox);
    const events: NewAgentEvent[] = [],
      artifacts: { name: string; content?: string }[] = [];
    const plan = {
      summary: "Update a.ts",
      complexity: "COMPLEX",
      estimatedSteps: 20,
      confidence: 0.8,
      steps: [{ id: "edit", title: "Edit", description: "Implement a.ts value" }],
    };
    const db = {
      approvals: { list: async () => [{ kind: "PLAN", status: "APPROVED", request: { plan } }] },
      events: {
        list: async () => [],
        append: async (event: NewAgentEvent) => {
          events.push(event);
        },
      },
      artifacts: {
        list: async () => [],
        create: async (a: { name: string; content?: string }) => {
          artifacts.push(a);
          return { ...a, id: randomUUID() };
        },
      },
      runs: { transition: async () => ({}) },
    } as unknown as DatabaseAdapter;
    const write = (n: number) =>
      fakeModelResponse({
        toolCalls: [
          {
            id: randomUUID(),
            name: "writeFile",
            input: { path: "a.ts", content: `export const value = ${n};\n` },
          },
          ...(n === 1 || skip
            ? [
                {
                  id: randomUUID(),
                  name: "finishPhase",
                  input: { summary: "Candidate ready", outcome: "CHANGED" },
                },
              ]
            : []),
        ],
      });
    const model = new FakeLanguageModel(
      skip
        ? [write(2)]
        : [
            write(1),
            write(2),
            fakeModelResponse({
              toolCalls: [
                {
                  id: randomUUID(),
                  name: "finishPhase",
                  input: { summary: "Repair done", outcome: "CHANGED" },
                },
              ],
            }),
            write(3),
            fakeModelResponse({
              toolCalls: [
                {
                  id: randomUUID(),
                  name: "finishPhase",
                  input: { summary: "Review repair done", outcome: "CHANGED" },
                },
              ],
            }),
          ],
    );
    let reviews = 0;
    const reviewer = new FakeLanguageModel(
      Array.from({ length: 2 }, () => async (request) => {
        f.order.push("REVIEW");
        reviews++;
        expect(request.tools).toEqual([]);
        expect(skip || f.tests() >= 2).toBe(true);
        return fakeModelResponse({
          toolCalls: [],
          text: JSON.stringify({
            verdict: skip || reviews > 1 ? "PASS" : "FAIL",
            summary: skip ? "The issue is fixed; all tests passed." : "Check value contract",
            issues:
              skip || reviews > 1
                ? reviewedFindings(request).map((f: { findingId: string }) => ({
                    findingId: f.findingId,
                    kind: "DEFECT",
                    severity: "high",
                    disposition: "RESOLVED",
                    message: "Current implementation satisfies value contract",
                    evidence: { path: "a.ts", quote: "value = 3" },
                    behavior: {
                      scenario: "Read exported value",
                      expected: "3",
                      actual: "3",
                      requirementBasis: "ISSUE",
                      requirement: "Return value 3",
                    },
                  }))
                : [
                    {
                      severity: "high",
                      message: "a.ts value contract needs correction; use value 3",
                      kind: "DEFECT",
                      evidence: { path: "a.ts", quote: "value = 2" },
                      behavior: {
                        scenario: "Read exported value",
                        expected: "3",
                        actual: "2",
                        requirementBasis: "ISSUE",
                        requirement: "Return value 3",
                      },
                    },
                  ],
          }),
        });
      }),
    );
    const workflow = new ApprovalWorkflowRunExecutor(
      db,
      loadWorkerEnvironment({
        DATABASE_URL: "unused",
        DEVFLOW_POST_PATCH_CONVERGENCE_ENABLED: "true",
        DEVFLOW_POST_PATCH_AUTOFINISH_ENABLED: "true",
      }),
      () => model,
      () => reviewer,
    );
    const run = {
      id: randomUUID(),
      currentStage: "EXECUTE",
      status: "RUNNING",
      retryCount: 0,
      maxSteps: 30,
      maxTestRetries: 2,
      maxReviewRetries: 1,
      repository: {
        id: randomUUID(),
        sourceKind: "GIT",
        sourceUri: "https://example.invalid/repo.git",
      },
      task: {
        id: randomUUID(),
        title: "Change value",
        description: "Update a.ts",
        baseCommitSha: "a".repeat(40),
      },
    } as RunExecutionRecord;
    const result = await workflow["executeApprovedPlan"](run, new AbortController().signal);
    expect(result, JSON.stringify({ result, events, order: f.order })).toMatchObject({
      status: "SUCCEEDED",
      executeCompletion: { outcome: "PATCH_READY", metrics: { postPatchModelCalls: 0 } },
    });
    expect(f.order).toEqual(
      skip
        ? ["WRITE", "REVIEW"]
        : ["WRITE", "TEST", "WRITE", "TEST", "REVIEW", "WRITE", "TEST", "REVIEW"],
    );
    expect(artifacts.some((a) => a.name === "verification-boundary.json")).toBe(true);
    if ("summary" in result && skip) {
      expect(result.summary).toContain("SKIPPED");
      expect(result.summary).not.toMatch(/tests passed/iu);
    }
    expect("verification" in result && result.verification?.issue).toBe(
      "VERIFICATION_INCONCLUSIVE",
    );
  },
);
