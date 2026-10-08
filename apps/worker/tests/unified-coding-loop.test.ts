import { InMemoryBudgetLedgerStore } from "@devflow/database";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentHash, FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import { DockerSandboxManager, type SandboxSession } from "@devflow/sandbox";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import { DevflowError, type NewAgentEvent } from "@devflow/shared";
import { ApprovalWorkflowRunExecutor } from "../src/runs/approval-workflow-run-executor.js";
import { loadWorkerEnvironment } from "../src/config/env.js";

afterEach(() => vi.restoreAllMocks());

function workerFixture(publicValues = [2], outsideFailure = false) {
  const original = "export const value = 0;\n";
  let source = original;
  const order: string[] = [];
  const events: NewAgentEvent[] = [];
  const artifacts: { id: string; name: string; content?: string; kind?: string }[] = [];
  const sandbox = {
    id: "unified-coding-sandbox",
    workspacePath: "/workspace",
    dispose: async () => undefined,
    listFiles: async () => ({
      entries: ["a.ts", "package.json", ...(outsideFailure ? ["b.ts"] : [])].map((path) => ({
        path,
        kind: "FILE",
        sizeBytes: 80,
      })),
      truncated: false,
    }),
    readFile: async ({ path }: { path: string }) => {
      const content =
        path === "a.ts"
          ? source
          : path === "package.json"
            ? '{"scripts":{"test":"node --test"}}'
            : outsideFailure && path === "b.ts"
              ? "export const consumer = 0;\n"
              : undefined;
      if (content === undefined) throw new DevflowError({ code: "NOT_FOUND", message: "missing" });
      return {
        path,
        content,
        startLine: 1,
        endLine: content.split("\n").length,
        fileSha256: contentHash(content),
        truncated: false,
      };
    },
    writeFile: async ({ path, content }: { path: string; content: string }) => {
      expect(path).toBe("a.ts");
      source = content;
      order.push(`EDIT:${content.trim()}`);
      return { path, sizeBytes: content.length, sha256: contentHash(content) };
    },
    exec: async ({ program, args = [] }: { program: string; args?: string[] }) => {
      let stdout = "",
        exitCode = 0;
      if (program === "git") {
        if (args[0] === "rev-parse") stdout = "a".repeat(40);
        if (args[0] === "status") stdout = "## main\0" + (source === original ? "" : " M a.ts\0");
        if (args[0] === "show") stdout = original;
        if (args[0] === "diff")
          stdout =
            source === original
              ? ""
              : args.includes("--numstat")
                ? "1\t1\ta.ts\n"
                : `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-${original.trim()}\n+${source.trim()}\n`;
      } else {
        exitCode = publicValues.some((value) => source.includes(`value = ${value}`)) ? 0 : 1;
        stdout = exitCode
          ? outsideFailure
            ? "b.ts:1: error: expected consumer 2; received consumer 0"
            : "a.ts:1: error: expected value 2; received value 1"
          : "public assertion passed";
        order.push(`TEST:${exitCode}`);
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
  vi.spyOn(DockerSandboxManager.prototype, "create").mockResolvedValue(sandbox);
  const plan = {
    summary: "Correct value and preserve the public assertion",
    steps: [
      { id: "value", title: "Correct the value", description: "Update a.ts to return value 2." },
    ],
  };
  const db = {
    budgetLedgers: new InMemoryBudgetLedgerStore(),
    approvals: {
      list: async () => [
        { id: "original-approval", kind: "PLAN", status: "APPROVED", request: { plan } },
      ],
    },
    events: {
      list: async () => events,
      append: async (event: NewAgentEvent) => {
        events.push(event);
      },
    },
    artifacts: {
      list: async () => artifacts,
      create: async (artifact: { name: string; content?: string; kind?: string }) => {
        const saved = { ...artifact, id: randomUUID() };
        artifacts.push(saved);
        return saved;
      },
    },
    runs: { transition: async () => ({}) },
  } as unknown as DatabaseAdapter;
  const run = {
    id: randomUUID(),
    currentStage: "EXECUTE",
    status: "RUNNING",
    retryCount: 0,
    maxSteps: 25,
    maxTestRetries: 2,
    maxReviewRetries: 1,
    repository: {
      id: randomUUID(),
      sourceKind: "GIT",
      sourceUri: "https://example.invalid/unified.git",
    },
    task: {
      id: randomUUID(),
      title: "Correct value",
      description: "Return value 2 and preserve the public assertion.",
      baseCommitSha: "a".repeat(40),
    },
  } as RunExecutionRecord;
  const environment = loadWorkerEnvironment({
    DATABASE_URL: "unused",
    DEVFLOW_MAX_RETRIES: "0",
    DEVFLOW_MAX_TOTAL_TOKENS: "250000",
    DEVFLOW_TIMEOUT_MS: "1500000",
    DEVFLOW_CONTEXT_COMPRESSION_ENABLED: "false",
    DEVFLOW_POST_PATCH_CONVERGENCE_ENABLED: "true",
  });
  return { db, run, environment, order, artifacts, events, plan };
}

const submitted = (value: number, unfinished = false) =>
  fakeModelResponse({
    text:
      value === 1
        ? "Keep this causal hypothesis: the first candidate may still fail the public assertion."
        : "Revise after the observed failure.",
    toolCalls: [
      {
        id: `edit-value-${value}`,
        name: "writeFile",
        input: { path: "a.ts", content: `export const value = ${value};\n` },
      },
      {
        id: `submit-value-${value}`,
        name: "finishPhase",
        input: {
          outcome: "CHANGED",
          summary: "Submit current candidate for host verification",
          ...(unfinished
            ? {
                unfinishedWork: [
                  "The value still needs the public assertion checked and corrected.",
                ],
              }
            : {}),
        },
      },
    ],
    usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
  });

describe("unified Coding Loop through the real Worker orchestration", () => {
  it("opens one persisted read-only investigation after two public failures and dispatches a new Plan approval", async () => {
    const f = workerFixture([], true);
    f.run.maxTestRetries = 3;
    Object.assign(f.plan, {
      proposalVersion: "plan-proposal-v1",
      approvalScope: {
        version: "plan-approval-scope-v1",
        mode: "READY",
        baseCommitSha: "a".repeat(40),
        workspaceRevision: 0,
        files: [{ path: "a.ts", operation: "MODIFY" }],
      },
    });
    const model = new FakeLanguageModel([
      submitted(1),
      fakeModelResponse({
        toolCalls: [
          {
            id: "refresh-approved-current",
            name: "readFile",
            input: { path: "a.ts", maxBytes: 1000 },
          },
        ],
      }),
      submitted(2),
      async (request) => {
        expect(JSON.stringify(request.messages)).toContain(
          "Host-observed public failures permit bounded read-only investigation",
        );
        expect(JSON.stringify(request.messages)).toContain("b.ts");
        expect(f.order.filter((row) => row === "TEST:1")).toHaveLength(2);
        expect(request.tools.map((tool) => tool.name)).toContain("readFile");
        return fakeModelResponse({
          toolCalls: [
            { id: "inspect-consumer", name: "readFile", input: { path: "b.ts", maxBytes: 1000 } },
          ],
        });
      },
      async (request) => {
        const source = "export const consumer = 0;\n";
        expect(JSON.stringify(request.messages)).toContain("inspect-consumer");
        const state = JSON.parse(
          f.artifacts.findLast((artifact) => artifact.name === "coding-session-v1.json")!.content!,
        ).state;
        expect(state.hostToolState.exploration.investigation.reads).toBe(1);
        return fakeModelResponse({
          toolCalls: [
            {
              id: "scope-handoff",
              name: "finishPhase",
              input: {
                outcome: "SCOPE_CONFLICT",
                summary:
                  "Public failures point to the unapproved consumer; investigate causality in a new plan.",
                evidence: [{ path: "b.ts", quote: source.trim(), fileSha256: contentHash(source) }],
                replanRequest: {
                  candidatePaths: ["b.ts"],
                  reason: "The diagnosed consumer is outside current write approval",
                },
              },
            },
          ],
        });
      },
      async (request) => {
        expect(request.output?.name).toBe("plan_proposal");
        expect(JSON.stringify(request.messages)).toContain("expected consumer 2");
        return fakeModelResponse({
          toolCalls: [],
          output: {
            decision: "PROPOSE",
            goal: "Correct the diagnosed consumer and preserve current candidate",
            approach: ["Correct the observed consumer after approval"],
            candidateFiles: ["a.ts", "b.ts"].map((path) => ({
              path,
              intent: "EDIT",
              reason: "Preserve current candidate and correct public consumer failure",
            })),
            verification: ["Run the public test"],
            uncertainties: [],
          },
        });
      },
    ]);
    const reviewer = new FakeLanguageModel([]);
    const result = await new ApprovalWorkflowRunExecutor(
      f.db,
      f.environment,
      () => model,
      () => reviewer,
    ).execute(f.run, AbortSignal.timeout(30_000));
    expect(result.status, JSON.stringify(result)).toBe("WAITING_APPROVAL");
    expect(
      model.requests.filter((request) => request.output?.name === "plan_proposal"),
    ).toHaveLength(1);
    expect(f.order.filter((row) => row.startsWith("EDIT:"))).toEqual([
      "EDIT:export const value = 1;",
      "EDIT:export const value = 2;",
    ]);
    expect(reviewer.requests).toHaveLength(0);
    const investigation = f.artifacts.filter((artifact) =>
      artifact.name.startsWith("failure-investigation-"),
    );
    expect(investigation).toHaveLength(1);
    expect(JSON.parse(investigation[0]!.content!)).toMatchObject({
      readOnly: true,
      writeApprovalUnchanged: true,
      consecutiveFailures: 2,
    });
  });

  it("blocks a legacy lightweight resume whose history and consumed resources cannot be recovered", async () => {
    const f = workerFixture();
    f.artifacts.push({
      id: "legacy-progress",
      name: "execute-convergence-v1.json",
      kind: "OTHER",
      content: JSON.stringify({ version: 1, submissionOnly: false }),
    });
    const model = new FakeLanguageModel([]),
      reviewer = new FakeLanguageModel([]);
    const result = await new ApprovalWorkflowRunExecutor(
      f.db,
      f.environment,
      () => model,
      () => reviewer,
    ).execute(f.run, AbortSignal.timeout(30_000));
    expect(result.status).toBe("FAILED");
    expect(JSON.stringify(result)).toContain("CODING_LEGACY_RESUME_UNCONFIRMED");
    expect(model.requests).toHaveLength(0);
    expect(reviewer.requests).toHaveLength(0);
    expect(f.order).toEqual([]);
  });

  it.each([false, true])(
    "returns failed public validation to the same history, including unfinished=%s",
    async (unfinished) => {
      const f = workerFixture();
      const model = new FakeLanguageModel([
        submitted(1, unfinished),
        async (request) => {
          const context = JSON.stringify(request.messages);
          expect(context).toContain("edit-value-1");
          expect(context).toContain("expected value 2");
          expect(context).toContain("preserve the public assertion");
          expect(request.tools.map((tool) => tool.name)).toContain("writeFile");
          return submitted(2);
        },
      ]);
      const reviewer = new FakeLanguageModel([
        async (request) => {
          f.order.push("REVIEW");
          expect(request.tools).toEqual([]);
          expect(f.order.at(-2)).toBe("TEST:0");
          return fakeModelResponse({
            toolCalls: [],
            output: {
              verdict: "PASS",
              summary: "Current behavior satisfies the original task and public assertion.",
              issues: [],
            },
          });
        },
      ]);
      const worker = new ApprovalWorkflowRunExecutor(
        f.db,
        f.environment,
        () => model,
        () => reviewer,
      );
      const result = await worker.execute(f.run, AbortSignal.timeout(30_000));
      expect(result.status, JSON.stringify(result)).toBe("SUCCEEDED");
      expect(model.requests).toHaveLength(2);
      expect(reviewer.requests).toHaveLength(1);
      if (!("metrics" in result)) throw new Error("Expected workflow resource accounting");
      const checkpoints = f.artifacts
        .filter((artifact) => artifact.name === "coding-session-v1.json")
        .map((artifact) => JSON.parse(artifact.content!));
      expect(new Set(checkpoints.map((checkpoint) => checkpoint.sessionId)).size).toBe(1);
      expect(result.metrics.modelRequestsDispatched).toBe(
        model.requests.length + reviewer.requests.length,
      );
      expect(result.metrics.steps).toBe(
        checkpoints.at(-1).state.stepCount + reviewer.requests.length,
      );
      expect(f.order).toEqual([
        "EDIT:export const value = 1;",
        "TEST:1",
        "EDIT:export const value = 2;",
        "TEST:0",
        "REVIEW",
      ]);
      expect(f.artifacts.filter((artifact) => artifact.kind === "TEST_REPORT")).toHaveLength(2);
    },
  );

  it("never sends a failed final validation to Independent Review when correction allowance is exhausted", async () => {
    const f = workerFixture();
    f.run.maxTestRetries = 0;
    const model = new FakeLanguageModel([submitted(1)]);
    const reviewer = new FakeLanguageModel([]);
    const result = await new ApprovalWorkflowRunExecutor(
      f.db,
      f.environment,
      () => model,
      () => reviewer,
    ).execute(f.run, AbortSignal.timeout(30_000));
    expect(result.status).toBe("FAILED");
    expect(model.requests).toHaveLength(1);
    expect(reviewer.requests).toHaveLength(0);
    expect(f.order).toEqual(["EDIT:export const value = 1;", "TEST:1"]);
  });

  it("does not rerun an unchanged failed candidate without current contradictory evidence", async () => {
    const f = workerFixture();
    Object.assign(f.plan, {
      proposalVersion: "plan-proposal-v1",
      approvalScope: {
        version: "plan-approval-scope-v1",
        mode: "READY",
        baseCommitSha: "a".repeat(40),
        workspaceRevision: 0,
        files: [{ path: "a.ts", operation: "MODIFY" }],
      },
    });
    const model = new FakeLanguageModel([
      submitted(1),
      fakeModelResponse({
        toolCalls: [
          {
            id: "repeat-submission",
            name: "finishPhase",
            input: { outcome: "CHANGED", summary: "Same candidate again" },
          },
        ],
      }),
    ]);
    const reviewer = new FakeLanguageModel([]);
    const result = await new ApprovalWorkflowRunExecutor(
      f.db,
      f.environment,
      () => model,
      () => reviewer,
    ).execute(f.run, AbortSignal.timeout(30_000));
    expect(result.status).toBe("FAILED");
    expect(JSON.stringify(result)).toContain("UNCHANGED_CANDIDATE_AND_PUBLIC_FAILURE");
    expect(model.requests).toHaveLength(2);
    expect(f.order).toEqual(["EDIT:export const value = 1;", "TEST:1"]);
    expect(reviewer.requests).toHaveLength(0);
  });

  it("accepts a current evidence response without manufacturing another edit and independently reviews it", async () => {
    const f = workerFixture();
    const quote = "export const value = 2;";
    const model = new FakeLanguageModel([
      submitted(2),
      async (request) => {
        expect(JSON.stringify(request.messages)).toContain("edit-value-2");
        const report = JSON.parse(
          f.artifacts.findLast((artifact) => artifact.kind === "REVIEW_REPORT")!.content!,
        );
        const findingId = report.findings[0].findingId;
        expect(findingId).toBeTruthy();
        return fakeModelResponse({
          toolCalls: [
            {
              id: "evidence-answer",
              name: "finishPhase",
              input: {
                outcome: "CONTRADICTED",
                summary: "Current source directly returns the required value 2",
                findingResponses: [
                  {
                    findingId,
                    outcome: "CONTRADICTED",
                    summary: "The review inference conflicts with the current return value",
                    evidence: [{ path: "a.ts", quote, fileSha256: contentHash(`${quote}\n`) }],
                  },
                ],
              },
            },
          ],
        });
      },
    ]);
    const reviewer = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [],
        output: {
          verdict: "FAIL",
          summary: "Check original value requirement",
          issues: [
            {
              kind: "DEFECT",
              severity: "high",
              message: "Suspected exported value 1 instead of required 2",
              evidence: { path: "a.ts", quote },
              behavior: {
                scenario: "Read exported value",
                expected: "2",
                actual: "1",
                requirementBasis: "ISSUE",
                requirement: "Return value 2",
              },
            },
          ],
        },
      }),
      async (request) => {
        expect(request.tools).toEqual([]);
        expect(JSON.stringify(request.messages)).toContain("CONTRADICTED");
        const report = JSON.parse(
          f.artifacts.findLast((artifact) => artifact.kind === "REVIEW_REPORT")!.content!,
        );
        return fakeModelResponse({
          toolCalls: [],
          output: {
            verdict: "PASS",
            summary: "Current evidence refutes the previous inference",
            issues: [
              {
                findingId: report.findings[0].findingId,
                kind: "DEFECT",
                severity: "high",
                disposition: "CONTRADICTED",
                message: "Current source returns the required 2",
                evidence: { path: "a.ts", quote },
                behavior: {
                  scenario: "Read exported value",
                  expected: "2",
                  actual: "2",
                  requirementBasis: "ISSUE",
                  requirement: "Return value 2",
                },
              },
            ],
          },
        });
      },
    ]);
    const result = await new ApprovalWorkflowRunExecutor(
      f.db,
      f.environment,
      () => model,
      () => reviewer,
    ).execute(f.run, AbortSignal.timeout(30_000));
    expect(result.status, JSON.stringify(result)).toBe("SUCCEEDED");
    expect(model.requests).toHaveLength(2);
    expect(reviewer.requests).toHaveLength(2);
    if (!("metrics" in result)) throw new Error("Expected workflow resource accounting");
    const state = JSON.parse(
      f.artifacts.findLast((artifact) => artifact.name === "coding-session-v1.json")!.content!,
    ).state;
    expect(result.metrics.modelRequestsDispatched).toBe(4);
    expect(result.metrics.steps).toBe(state.stepCount + reviewer.requests.length);
    expect(f.order.filter((entry) => entry.startsWith("EDIT:"))).toHaveLength(1);
    expect(f.order.filter((entry) => entry === "TEST:0")).toHaveLength(2);
  });

  it("returns an independently confirmed defect to the same coding session and revalidates the revision", async () => {
    const f = workerFixture([2, 3]);
    f.run.task.description = "Return value 3 and preserve the public assertion.";
    const model = new FakeLanguageModel([
      submitted(2),
      async (request) => {
        const context = JSON.stringify(request.messages);
        expect(context).toContain("edit-value-2");
        expect(context).toContain("Return value 3");
        expect(context).toContain("value contract");
        return submitted(3);
      },
    ]);
    let reviews = 0;
    const reviewer = new FakeLanguageModel(
      Array.from({ length: 2 }, () => async (request) => {
        f.order.push("REVIEW");
        expect(request.tools).toEqual([]);
        reviews++;
        const message = request.messages.find(
          (m) =>
            m.role === "USER" &&
            typeof m.content === "string" &&
            m.content.includes("Current source and host protection policy:\n"),
        );
        const context = typeof message?.content === "string" ? message.content : "";
        const findings =
          JSON.parse(
            context
              .split("Current source and host protection policy:\n")[1]
              ?.split("\n\nTest evidence")[0] ?? "{}",
          ).findingHistory ?? [];
        const resolved = reviews > 1;
        return fakeModelResponse({
          toolCalls: [],
          output: {
            verdict: resolved ? "PASS" : "FAIL",
            summary: "Check original value contract",
            issues: resolved
              ? findings.map((finding: { findingId: string }) => ({
                  findingId: finding.findingId,
                  kind: "DEFECT",
                  severity: "high",
                  disposition: "RESOLVED",
                  message: "Current revision satisfies the value contract",
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
                    kind: "DEFECT",
                    severity: "high",
                    message: "The value contract requires 3, while current source returns 2",
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
          },
        });
      }),
    );
    const result = await new ApprovalWorkflowRunExecutor(
      f.db,
      f.environment,
      () => model,
      () => reviewer,
    ).execute(f.run, AbortSignal.timeout(30_000));
    expect(result.status, JSON.stringify(result)).toBe("SUCCEEDED");
    expect(model.requests).toHaveLength(2);
    expect(reviewer.requests).toHaveLength(2);
    expect(f.order).toEqual([
      "EDIT:export const value = 2;",
      "TEST:0",
      "REVIEW",
      "EDIT:export const value = 3;",
      "TEST:0",
      "REVIEW",
    ]);
  });
});
