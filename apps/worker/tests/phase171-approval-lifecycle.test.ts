import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import {
  DockerSandboxManager,
  encodeLocalRepositorySnapshot,
  LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME,
  type SandboxSession,
} from "@devflow/sandbox";
import { DevflowError, type NewAgentEvent } from "@devflow/shared";
import { ApprovalWorkflowRunExecutor } from "../src/runs/approval-workflow-run-executor.js";
import { loadWorkerEnvironment } from "../src/config/env.js";

afterEach(() => vi.restoreAllMocks());

it("PLAN waits without a container; approved and recovered EXECUTE create fresh segments and dispose before returning", async () => {
  const events: NewAgentEvent[] = [];
  const approvals: unknown[] = [];
  const source = "export function behavior() { return false; }\n";
  const snapshot = {
    version: 1 as const,
    sourceHead: "a".repeat(40),
    totalBytes: Buffer.byteLength(source),
    files: [
      {
        path: "behavior.ts",
        kind: "FILE" as const,
        mode: 0o644,
        sizeBytes: Buffer.byteLength(source),
        sha256: createHash("sha256").update(source).digest("hex"),
        contentBase64: Buffer.from(source).toString("base64"),
      },
    ],
  };
  const artifacts = [
    {
      kind: "OTHER",
      name: LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME,
      content: encodeLocalRepositorySnapshot(snapshot),
    },
  ];
  const run = {
    id: randomUUID(),
    taskId: randomUUID(),
    currentStage: "START",
    status: "RUNNING",
    retryCount: 0,
    maxSteps: 12,
    maxTestRetries: 1,
    maxReviewRetries: 1,
    dispatchRevision: 0,
    task: {
      id: randomUUID(),
      title: "Fix behavior",
      description: "Fix behavior.ts; preserve the public API",
      baseCommitSha: snapshot.sourceHead,
    },
    repository: { id: randomUUID(), sourceKind: "LOCAL", sourceUri: process.cwd() },
  } as RunExecutionRecord;
  const database = {
    artifacts: { list: async () => artifacts, create: async () => ({ id: randomUUID() }) },
    approvals: { list: async () => approvals },
    events: {
      list: async () => events,
      append: async (e: NewAgentEvent) => {
        events.push(e);
      },
    },
    runs: { transition: async () => undefined },
  } as unknown as DatabaseAdapter;
  const plan = {
    summary: "Small fix",
    steps: [{ id: "fix", title: "Fix", description: "Correct the behavior" }],
    complexity: "SIMPLE",
    estimatedSteps: 4,
    confidence: 0.9,
    executionContract: {
      version: "execution-contract-v1",
      editTargets: [
        {
          path: "behavior.ts",
          symbol: "behavior",
          operation: "MODIFY",
          rationale: "Fix observed behavior",
        },
      ],
      inspectTargets: [],
      verificationHints: [],
      unresolvedQuestions: [],
    },
    behaviorAudit: {
      constraints: [],
      uncertainties: ["Public behavior tests are absent from this fixture."],
    },
  };
  const executionRequests: unknown[] = [];
  const executor = new ApprovalWorkflowRunExecutor(
    database,
    loadWorkerEnvironment({
      DATABASE_URL: "unused",
      DEVFLOW_PLAN_AGENT_MAX_TOTAL_TOKENS: "24000",
      DEVFLOW_EFFICIENCY_TRACE_ENABLED: "true",
    }),
    (current) =>
      current.currentStage === "START"
        ? {
            async generate(request) {
              const name = request.output?.name;
              const body = JSON.parse(
                String(request.messages.find((message) => message.role === "USER")!.content),
              );
              const output =
                name === "issue_localization"
                  ? {
                      summary: "Observed behavior source",
                      hypotheses: [],
                      inspect: [],
                      candidates: [
                        { evidenceId: body.evidence[0].id, explanation: "Observed implementation" },
                      ],
                      uncertainty: [],
                    }
                  : name === "plan_iteration"
                    ? {
                        action: "FINAL",
                        reason: "Source is available",
                        hypotheses: [],
                        inspect: [],
                        searches: [],
                        uncertainty: [],
                      }
                    : {
                        decision: "PROPOSE",
                        goal: plan.summary,
                        approach: ["Fix observed behavior"],
                        candidateFiles: [
                          {
                            path: "behavior.ts",
                            intent: "EDIT",
                            reason: "Behavior implementation",
                          },
                        ],
                        verification: [],
                        uncertainties: [],
                      };
              return fakeModelResponse({
                toolCalls: [],
                text: JSON.stringify(output),
                usage: { inputTokens: 11, outputTokens: 9, totalTokens: 20 },
              });
            },
          }
        : new FakeLanguageModel([
            (request) => {
              executionRequests.push(request);
              throw new DevflowError({
                code: "LLM_FAILED",
                message: "deterministic stop after entering EXECUTE",
              });
            },
          ]),
  );
  const sessions: SandboxSession[] = [];
  const create = vi.spyOn(DockerSandboxManager.prototype, "create").mockImplementation(async () => {
    const session = {
      id: randomUUID(),
      workspacePath: "/workspace",
      dispose: vi.fn(async () => undefined),
      listFiles: async () => ({
        entries: [{ path: "behavior.ts", kind: "FILE", sizeBytes: Buffer.byteLength(source) }],
        truncated: false,
      }),
      readFile: async () => ({
        path: "behavior.ts",
        content: source,
        truncated: false,
        encoding: "utf8",
      }),
      exec: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        outputTruncated: false,
      }),
    } as unknown as SandboxSession;
    sessions.push(session);
    return session;
  });
  const planned = await executor.execute(run, new AbortController().signal);
  expect(planned.status, JSON.stringify(planned)).toBe("WAITING_APPROVAL");
  expect(create).not.toHaveBeenCalled();
  // Recovery must still accept plans persisted before contracts and budget hints existed.
  approvals.push({
    kind: "PLAN",
    status: "APPROVED",
    request: {
      plan: { summary: plan.summary, steps: plan.steps },
    },
  });
  for (const revision of [1, 2]) {
    const result = await executor.execute(
      {
        ...run,
        currentStage: "EXECUTE",
        dispatchRevision: revision,
        executionOwner: `owner-${revision}`,
      },
      new AbortController().signal,
    );
    expect(result.status).toBe("FAILED");
    expect(result).toMatchObject({ metrics: { modelCalls: expect.any(Number) } });
    expect(sessions.at(-1)?.dispose).toHaveBeenCalledOnce();
    expect(create.mock.calls.at(-1)?.[0]).toMatchObject({
      repository: { snapshot },
      owner: { executionOwner: `owner-${revision}`, dispatchRevision: revision },
    });
  }
  expect(executionRequests).toHaveLength(2);
  expect(sessions[0]?.id).not.toBe(sessions[1]?.id);
  expect(create.mock.calls[0]?.[0].owner?.segment).not.toBe(
    create.mock.calls[1]?.[0].owner?.segment,
  );
  create.mockRejectedValueOnce(
    new DevflowError({ code: "SANDBOX_CREATE_FAILED", message: "infrastructure unavailable" }),
  );
  const failed = await executor.execute(
    { ...run, currentStage: "EXECUTE", dispatchRevision: 3, executionOwner: "owner-3" },
    new AbortController().signal,
  );
  expect(failed).toMatchObject({ status: "FAILED", error: { code: "SANDBOX_CREATE_FAILED" } });
  if (failed.status !== "WAITING_APPROVAL") {
    expect(failed.metrics.modelCalls).toBeGreaterThan(0);
    expect(failed.metrics.tokenUsage.totalTokens).toBeGreaterThanOrEqual(20);
  }
});
