import { randomUUID } from "node:crypto";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import type { CommandResult } from "@devflow/sandbox";
import type { AgentPlan, NewAgentEvent, RunMetrics } from "@devflow/shared";
import { afterEach, expect, it, vi } from "vitest";
import { loadWorkerEnvironment } from "../src/config/env.js";
import { ApprovalWorkflowRunExecutor } from "../src/runs/approval-workflow-run-executor.js";
import { WorkflowBudgetLedger } from "../src/runs/workflow-budget.js";
import { createWorkflowMetrics } from "../src/runs/workflow-metrics.js";

afterEach(() => vi.unstubAllGlobals());

function fixture(options: { repeatLength?: boolean; maxCalls?: number } = {}) {
  const bodies: Record<string, unknown>[] = [];
  const events: NewAgentEvent[] = [];
  const artifacts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
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
                  ? ""
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
    timeoutMs: 10000,
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
  expect(current.bodies[1]).toMatchObject({ max_tokens: 4096, enable_thinking: false });
  expect(current.bodies[1]).not.toHaveProperty("reasoning_effort");
  expect(current.bodies[1]?.messages).toEqual(current.bodies[0]?.messages);
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

it("preserves the original failed usage and issues no recovery request when the shared call budget is exhausted", async () => {
  const current = fixture({ maxCalls: 1 });
  await expect(current.execute()).rejects.toMatchObject({ code: "EXECUTION_BUDGET_EXCEEDED" });
  expect(current.bodies).toHaveLength(1);
  expect(current.metrics).toMatchObject({ modelCalls: 1, tokenUsage: { totalTokens: 4196 } });
  expect(current.events.some((e) => e.type === "REVIEW_RESULT")).toBe(false);
});

it("stops after a second invalid LENGTH and never invents an approving result", async () => {
  const current = fixture({ repeatLength: true });
  await expect(current.execute()).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  expect(current.bodies).toHaveLength(2);
  expect(current.metrics).toMatchObject({ modelCalls: 2, tokenUsage: { totalTokens: 8392 } });
  expect(current.events.some((e) => e.type === "REVIEW_RESULT")).toBe(false);
});
