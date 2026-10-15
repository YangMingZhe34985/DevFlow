import { InMemoryBudgetLedgerStore } from "@devflow/database";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import type { SandboxSession } from "@devflow/sandbox";
import {
  AgentPlanSchema,
  FreshAgentPlanOutputSchema,
  FreshAgentPlanWithContractSchema,
  type ExecutionContract,
} from "@devflow/shared";
import {
  buildExecutionPacket,
  normalizeTargetPath,
  sourceSlice,
} from "../src/runs/execution-packet.js";
import { hash } from "../src/localization/contracts.js";

const signal = new AbortController().signal;
const code = "export function fix(value: number) { return value - 1; }\n";
const contract = (): ExecutionContract => ({
  version: "execution-contract-v1",
  editTargets: [
    { path: "src/a.ts", symbol: "fix", operation: "MODIFY", rationale: "Fix behavior" },
  ],
  inspectTargets: [{ path: "test/a.ts", symbol: null, rationale: "Inspect only, preserve test" }],
  verificationHints: [
    { path: "test/a.ts", commandHint: "npm test", description: "Workflow hint, not edit" },
  ],
  unresolvedQuestions: [],
});
const plan = {
  summary: "Correct fix while preserving unrelated behavior",
  steps: [{ id: "a", title: "Fix", description: "Apply a minimal edit" }],
  complexity: "SIMPLE",
  estimatedSteps: 3,
  confidence: 0.9,
};
describe("structured edit obligations, not natural-language path promotion", () => {
  it.each(["../x.ts", "/etc/passwd", "C:\\secret.ts", ".env", "src/../../x.ts", ".git/config"])(
    "rejects unsafe path %s",
    (path) => expect(() => normalizeTargetPath(path)).toThrow(),
  );
  it("normalizes current safe paths", () =>
    expect(normalizeTargetPath("./src\\a.ts")).toBe("src/a.ts"));
  it("retains persisted plans and requires the contract for fresh Agent plans", () => {
    expect(AgentPlanSchema.parse(plan)).not.toHaveProperty("executionContract");
    expect(FreshAgentPlanOutputSchema.parse(plan)).toEqual(plan);
    expect(FreshAgentPlanWithContractSchema.safeParse(plan).success).toBe(false);
    const json = z.toJSONSchema(FreshAgentPlanWithContractSchema);
    expect(json.required).toContain("executionContract");
    expect(
      FreshAgentPlanWithContractSchema.parse({ ...plan, executionContract: contract() }),
    ).toHaveProperty("executionContract");
  });
});
describe("current action-oriented packet", () => {
  it("does not copy score/profile/history/task; retains hashes, edit and inspect roles", async () => {
    const result = await buildExecutionPacket({
      plan: AgentPlanSchema.parse({ ...plan, executionContract: contract() }),
      title: "Fix record",
      baseCommitSha: "a".repeat(40),
      revision: 3,
      constraints: ["preserve public API"],
      read: async () => ({ content: code, truncated: false }),
      signal,
    });
    const text = JSON.stringify(result.packet);
    expect(text).not.toMatch(/retrievalSource|score|repositoryProfile|conversationHistory/);
    expect(result.packet.codeSlices[0]).toMatchObject({
      contentHash: hash(code),
      workspaceRevision: 3,
      symbol: "fix",
      complete: true,
    });
    expect(result.packet.inspectTargets).toHaveLength(1);
    expect(result.workingSet.targetFiles).toEqual(["src/a.ts"]);
    expect(result.reads).toBe(1);
  });
  it("fails closed on partial source hashes", async () => {
    await expect(
      buildExecutionPacket({
        plan: AgentPlanSchema.parse({ ...plan, executionContract: contract() }),
        title: "fix",
        baseCommitSha: "a",
        revision: 0,
        constraints: [],
        read: async () => ({ content: code, truncated: true }),
        signal,
      }),
    ).rejects.toMatchObject({ code: "TARGET_READ_FAILED" });
  });
  it("bounded symbol slices do not pretend the entire large function is complete", async () => {
    const s = await sourceSlice(
      "a.ts",
      "fix",
      "function fix(){\n" + "  const x=1;\n".repeat(500) + "}",
      0,
      "EDIT",
      signal,
    );
    expect(s.truncated).toBe(true);
    expect(s.fullFile).toBe(false);
    expect(s.endLine - s.startLine).toBeLessThanOrEqual(159);
  });
});

it("actual Worker PLAN emits the contract before approval; runAgentPhase receives packet and retains failed metrics", async () => {
  const { randomUUID } = await import("node:crypto");
  const { FakeLanguageModel, fakeModelResponse } = await import("@devflow/agent");
  const { encodeLocalRepositorySnapshot, LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME } =
    await import("@devflow/sandbox");
  const { ApprovalWorkflowRunExecutor, createTools } =
    await import("../src/runs/approval-workflow-run-executor.js");
  const { loadWorkerEnvironment } = await import("../src/config/env.js");
  const { SandboxGitService } = await import("@devflow/git");
  const artifacts = [
    {
      kind: "OTHER",
      name: LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME,
      content: encodeLocalRepositorySnapshot({
        version: 1,
        sourceHead: "a".repeat(40),
        totalBytes: Buffer.byteLength(code) * 2,
        files: ["src/a.ts", "test/a.ts"].map((path) => ({
          kind: "FILE",
          path,
          mode: 0o644,
          sizeBytes: Buffer.byteLength(code),
          sha256: hash(code),
          contentBase64: Buffer.from(code).toString("base64"),
        })),
      }),
    },
  ];
  const events: unknown[] = [];
  const database = {
    budgetLedgers: new InMemoryBudgetLedgerStore(),
    artifacts: { list: async () => artifacts, create: async () => ({ id: randomUUID() }) },
    events: {
      list: async () => events,
      append: async (e: unknown) => {
        events.push(e);
      },
    },
    approvals: { list: async () => [] },
    runs: { transition: async () => undefined },
  } as unknown as DatabaseAdapter;
  const run = {
    id: randomUUID(),
    status: "RUNNING",
    currentStage: "START",
    retryCount: 0,
    maxSteps: 12,
    maxTestRetries: 1,
    maxReviewRetries: 1,
    dispatchRevision: 0,
    task: {
      id: randomUUID(),
      title: "fix",
      description: "FULL_TASK_MUST_NOT_BE_REPEATED",
      baseCommitSha: "a".repeat(40),
    },
    repository: { id: randomUUID(), sourceKind: "LOCAL", sourceUri: process.cwd() },
  } as RunExecutionRecord;
  const planModel = new FakeLanguageModel([
    (request) => {
      expect(request.output?.name).toBe("issue_localization");
      const body = JSON.parse(
        String(request.messages.find((message) => message.role === "USER")!.content),
      );
      const target = body.evidence.find((item: { path: string }) => item.path === "src/a.ts");
      expect(target).toBeDefined();
      return fakeModelResponse({
        text: JSON.stringify({
          summary: "Locate the actual fix implementation",
          hypotheses: [],
          inspect: [],
          candidates: [{ evidenceId: target.id, explanation: "Actual source implementation" }],
          uncertainty: ["Behavior still requires public-test validation after approval"],
        }),
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      });
    },
    (request) => {
      expect(request.output?.name).toBe("plan_proposal");
      return fakeModelResponse({
        text: JSON.stringify({
          decision: "PROPOSE",
          goal: plan.summary,
          approach: ["Fix src/a.ts"],
          candidateFiles: [
            { path: "src/a.ts", intent: "EDIT", reason: "Arithmetic implementation" },
          ],
          verification: [],
          uncertainties: [],
        }),
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      });
    },
    fakeModelResponse({
      text: JSON.stringify({
        ...plan,
        executionContract: contract(),
        behaviorAudit: {
          constraints: [],
          uncertainties: [
            "The fixture's test-named file contains only implementation text; expected behavior is not established by an assertion.",
          ],
        },
      }),
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    }),
  ]);
  const worker = new ApprovalWorkflowRunExecutor(
    database,
    loadWorkerEnvironment({
      DATABASE_URL: "unused",
      DEVFLOW_PREPATCH_EFFICIENCY_ENABLED: "true",
      DEVFLOW_PLAN_AGENT_MAX_TOTAL_TOKENS: "24000",
    }),
    () => planModel,
  );
  const planned = await worker.execute(run, signal);
  expect(planned.status, JSON.stringify(planned)).toBe("WAITING_APPROVAL");
  if (planned.status !== "WAITING_APPROVAL" || !("plan" in planned))
    throw new Error("missing approved plan");
  expect(planned.plan.executionContract?.editTargets).toHaveLength(1);
  expect(planModel.requests.map((request) => request.output?.name)).toEqual([
    "issue_localization",
    "plan_proposal",
  ]);
  const finalSchema = z.toJSONSchema(planModel.requests.at(-1)!.output!.schema);
  expect(finalSchema.required).toContain("candidateFiles");
  const built = await buildExecutionPacket({
    plan: planned.plan,
    title: "fix",
    baseCommitSha: "a".repeat(40),
    revision: 0,
    constraints: [],
    read: async () => ({ content: code, truncated: false }),
    signal,
  });
  const executeModel = new FakeLanguageModel([
    (r) => {
      expect(JSON.stringify(r.messages)).toContain("src/a.ts");
      expect(r.tools.some((t) => t.name === "searchCode")).toBe(false);
      return fakeModelResponse({
        toolCalls: [],
        text: "stop",
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      });
    },
  ]);
  const result = await worker["runAgentPhase"]({
    run: { ...run, currentStage: "EXECUTE" },
    plan: planned.plan,
    sandbox: {
      id: "mock",
      workspacePath: "/workspace",
    } as SandboxSession,
    signal,
    ...createTools(new SandboxGitService()),
    model: executeModel,
    purpose: "IMPLEMENTATION",
    maxSteps: 12,
    adaptiveStepBudget: {
      initialLimit: 4,
      hardLimit: 12,
      onLimitReached: () => ({ action: "STOP", reason: "NO_PROGRESS" }),
    },
    timeoutMs: 900000,
    executionBudget: {
      stage: "EXECUTE",
      maxModelCalls: 12,
      maxToolCalls: 36,
      maxTotalTokens: 50000,
    },
    additionalContext: "OLD_EVIDENCE",
    executionPacket: built.packet,
    packetSourceBytes: built.sourceBytes,
    workingSet: built.workingSet,
  });
  expect(result.status).toBe("FAILED");
  expect(result.metrics.tokenUsage.totalTokens).toBe(30);
  expect(result.metrics.prePatch).toBeUndefined();
});

describe("behavior-focused source windows", () => {
  it("keeps a late rare technical term instead of the first generic goal word", async () => {
    const content =
      "// output schema input default helpers\n" +
      "// unrelated padding description\n".repeat(500) +
      "if (schema._prefault) schema.default = schema._prefault;\n" +
      "// tail padding\n".repeat(240);
    const slice = await sourceSlice(
      "src/export.ts",
      null,
      content,
      0,
      "EDIT",
      signal,
      "Fix output schema for missing prefault falsy defaults",
    );
    expect(slice.code).toContain("if (schema._prefault)");
    expect(slice.startLine).toBeGreaterThan(120);
    expect(slice.fullFile).toBe(false);
  });
  it("uses only hash-matching verified ranges and genuinely expands a targeted read", async () => {
    const content =
      "// header\n" +
      "// padding\n".repeat(180) +
      "if (value) keep(value);\n" +
      "// padding\n".repeat(1200);
    const initial = await sourceSlice("src/a.ts", null, content, 0, "EDIT", signal, "", {
      range: { contentHash: hash(content), startLine: 182, endLine: 182 },
    });
    expect(initial.code).toContain("if (value)");
    const next = await sourceSlice("src/a.ts", null, content, 0, "EDIT", signal, "", {
      expandFrom: initial,
    });
    expect(next.endLine).toBeGreaterThan(initial.endLine);
    expect(next.contentHash).toBe(initial.contentHash);
    expect(next.fullFile).toBe(false);
    const stale = await sourceSlice("src/a.ts", null, content, 0, "EDIT", signal, "", {
      range: { contentHash: "wrong", startLine: 182, endLine: 182 },
    });
    expect(stale.startLine).toBe(1);
  });
});
