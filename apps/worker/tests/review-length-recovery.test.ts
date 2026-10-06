import { randomUUID } from "node:crypto";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import type { CommandResult } from "@devflow/sandbox";
import type { AgentPlan, NewAgentEvent, RunMetrics } from "@devflow/shared";
import { afterEach, expect, it, vi } from "vitest";
import { loadWorkerEnvironment } from "../src/config/env.js";
import { ApprovalWorkflowRunExecutor } from "../src/runs/approval-workflow-run-executor.js";
import { WorkflowBudgetLedger } from "../src/runs/workflow-budget.js";
import { createWorkflowMetrics } from "../src/runs/workflow-metrics.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture(
  options: {
    repeatLength?: boolean;
    maxCalls?: number;
    pro?: boolean;
    validLength?: boolean;
    timeoutMs?: number;
    requestTimeoutMs?: number;
    hang?: boolean;
  } = {},
) {
  const bodies: Record<string, unknown>[] = [];
  const events: NewAgentEvent[] = [];
  const artifacts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      if (options.hang)
        return await new Promise<Response>((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
        );
      const length = bodies.length === 1 || options.repeatLength;
      return new Response(
        JSON.stringify({
          id: `review-${bodies.length}`,
          object: "chat.completion",
          created: 1,
          model: "deepseek-v4.1-flash",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: length
                  ? options.validLength
                    ? JSON.stringify({
                        verdict: "PASS",
                        summary: "Truncated but parseable",
                        issues: [],
                      })
                    : ""
                  : JSON.stringify({
                      verdict: "FAIL",
                      summary: "A further code change is required",
                      issues: [
                        { severity: "high", message: "The patch still changes another behavior" },
                      ],
                    }),
              },
              finish_reason: length ? "length" : "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: length ? 4096 : 80,
            total_tokens: length ? 4196 : 180,
            completion_tokens_details: { reasoning_tokens: length ? 4096 : 0 },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  const database = {
    runs: { transition: vi.fn() },
    events: {
      append: async (event: NewAgentEvent) => {
        events.push(event);
      },
    },
    artifacts: {
      list: async () => artifacts,
      create: async (artifact: Record<string, unknown>) => {
        const saved = { ...artifact, id: randomUUID() };
        artifacts.push(saved);
        return saved;
      },
    },
  } as unknown as DatabaseAdapter;
  const environment = loadWorkerEnvironment({
    DATABASE_URL: "test",
    LLM_PROVIDER: "openai-compatible",
    LLM_MODEL: "deepseek-v4.1-flash",
    LLM_API_KEY: "test",
    LLM_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    LLM_PROVIDER_NAME: "bailian",
    LLM_REVIEW_MAX_OUTPUT_TOKENS: "4096",
    LLM_REVIEW_ENABLE_THINKING: "true",
    LLM_REVIEW_REASONING_EFFORT: "low",
    ...(options.requestTimeoutMs
      ? {
          DEVFLOW_REVIEW_REQUEST_TIMEOUT_MS: String(options.requestTimeoutMs),
          DEVFLOW_REVIEW_RECOVERY_TIMEOUT_MS: String(options.requestTimeoutMs),
          DEVFLOW_FINALIZE_TIMEOUT_MS: "30",
        }
      : {}),
    ...(options.pro
      ? {
          LLM_REVIEW_MODEL: "deepseek-v4-pro-0813",
          LLM_REVIEW_REASONING_EFFORT: "high",
          LLM_REVIEW_MAX_OUTPUT_TOKENS: "16384",
          LLM_REVIEW_CONTEXT_TOKENS: "64000",
        }
      : {}),
  });
  const executor = new ApprovalWorkflowRunExecutor(database, environment);
  const run = {
    id: randomUUID(),
    task: { title: "Fix addition", description: "Preserve the API" },
    model: { provider: "openai-compatible", name: "deepseek-v4.1-flash", parameters: {} },
  } as RunExecutionRecord;
  const plan: AgentPlan = {
    summary: "Correct addition",
    complexity: "SIMPLE",
    estimatedSteps: 4,
    confidence: 0.8,
    steps: [{ id: "fix", title: "Correct add", description: "Replace subtraction with addition" }],
  };
  const test: CommandResult = {
    exitCode: 0,
    stdout: "public test passed",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    outputTruncated: false,
  };
  const metrics = createWorkflowMetrics();
  const budget = new WorkflowBudgetLedger({
    maxSteps: 5,
    maxReviewRetries: 1,
    timeoutMs: options.timeoutMs ?? 600_000,
    maxModelCalls: options.maxCalls ?? 5,
  });
  const access = executor as unknown as {
    review(
      run: RunExecutionRecord,
      plan: AgentPlan,
      diff: string,
      test: CommandResult,
      signal: AbortSignal,
      attempt: number,
      metrics: RunMetrics,
      budget: WorkflowBudgetLedger,
    ): Promise<{ approved: boolean; summary: string }>;
  };
  return {
    bodies,
    events,
    artifacts,
    metrics,
    execute: () =>
      access.review(
        run,
        plan,
        "public patch",
        test,
        AbortSignal.timeout(10000),
        0,
        metrics,
        budget,
      ),
  };
}

it("sends the explicit Pro binding, high thinking and configured 16384-token ceiling to the actual compatible request", async () => {
  const current = fixture({ pro: true });
  await current.execute();
  expect(current.bodies[0]).toMatchObject({
    model: "deepseek-v4-pro-0813",
    enable_thinking: true,
    reasoning_effort: "high",
    max_tokens: 16384,
  });
  expect(current.bodies[1]).toMatchObject({
    model: "deepseek-v4-pro-0813",
    max_tokens: 16384,
    enable_thinking: true,
    reasoning_effort: "low",
  });
});

it("recovers an empty thinking LENGTH once through production Review without changing its verdict or evidence", async () => {
  const current = fixture();
  expect(await current.execute()).toMatchObject({
    approved: false,
    summary: "A further code change is required",
  });
  expect(current.bodies).toHaveLength(2);
  expect(current.bodies[0]).toMatchObject({
    max_tokens: 4096,
    enable_thinking: true,
    reasoning_effort: "low",
  });
  expect(current.bodies[1]).toMatchObject({
    max_tokens: 4096,
    enable_thinking: true,
    reasoning_effort: "low",
  });
  expect(current.bodies[1]?.messages).not.toEqual(current.bodies[0]?.messages);
  expect(current.metrics).toMatchObject({
    modelCalls: 2,
    steps: 2,
    reasoningTokens: 4096,
    tokenUsage: { inputTokens: 200, outputTokens: 4176, totalTokens: 4376 },
  });
  expect(current.metrics.control?.structuredOutputFailures).toBe(1);
  expect(current.metrics.control?.structuredOutputRepairAttempts).toBe(0);
  expect(
    current.events.filter((e) => e.type === "LLM_RESPONSE").map((e) => e.payload.purpose),
  ).toEqual(["REVIEW", "REVIEW_LENGTH_REGENERATION"]);
  expect(current.artifacts.find((a) => a.kind === "REVIEW_REPORT")?.metadata).toMatchObject({
    formatRepairAttempts: 0,
    lengthRegenerationAttempts: 1,
  });
});

it("issues no request when a normal decision and recovery cannot fit the shared call budget", async () => {
  const current = fixture({ maxCalls: 1 });
  await expect(current.execute()).rejects.toMatchObject({ code: "EXECUTION_BUDGET_EXCEEDED" });
  expect(current.bodies).toHaveLength(0);
  expect(current.metrics).toMatchObject({ modelCalls: 0, tokenUsage: { totalTokens: 0 } });
  expect(current.events.some((e) => e.type === "REVIEW_RESULT")).toBe(false);
});

it("reserves the actual review/recovery time before issuing an HTTP request", async () => {
  const current = fixture({ timeoutMs: 174_000, pro: true });
  await expect(current.execute()).rejects.toMatchObject({
    code: "EXECUTION_BUDGET_EXCEEDED",
    details: { requestIssued: false, requiredTimeMs: 480_000 },
  });
  expect(current.bodies).toHaveLength(0);
  expect(current.events.find((e) => e.type === "WORKFLOW_CHECKPOINT")?.payload).toMatchObject({
    missingTimeMs: expect.any(Number),
  });
});

it("bounds a hung review independently without emitting a refusal or consuming a recovery", async () => {
  const current = fixture({ timeoutMs: 1000, requestTimeoutMs: 20, hang: true });
  await expect(current.execute()).rejects.toMatchObject({
    code: "TIMEOUT",
    details: { reviewIncomplete: true, requestIssued: true },
  });
  expect(current.bodies).toHaveLength(1);
  expect(current.events.some((e) => e.type === "REVIEW_RESULT")).toBe(false);
  expect(current.artifacts.some((a) => a.name === "review-output-recovery-v1.json")).toBe(false);
});

it("stops after a second invalid LENGTH and never invents an approving result", async () => {
  const current = fixture({ repeatLength: true });
  await expect(current.execute()).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  expect(current.bodies).toHaveLength(2);
  expect(current.metrics).toMatchObject({ modelCalls: 2, tokenUsage: { totalTokens: 8392 } });
  expect(current.events.some((e) => e.type === "REVIEW_RESULT")).toBe(false);
});

it("rejects parseable LENGTH output and preserves recovery usage after resumed Review decisions", async () => {
  const current = fixture({ repeatLength: true, validLength: true, pro: true });
  await expect(current.execute()).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  await expect(current.execute()).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  await expect(current.execute()).rejects.toMatchObject({ code: "EXECUTION_BUDGET_EXCEEDED" });
  expect(current.bodies).toHaveLength(5);
  expect(current.bodies.map((b) => b.reasoning_effort)).toEqual([
    "high",
    "low",
    "high",
    "low",
    "high",
  ]);
  expect(
    current.artifacts
      .filter((a) => a.name === "review-output-recovery-v1.json")
      .map((a) => JSON.parse(String(a.content)).used),
  ).toEqual([1, 2]);
  expect(current.events.some((e) => e.type === "REVIEW_RESULT")).toBe(false);
});
