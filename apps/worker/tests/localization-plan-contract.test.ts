import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import type { ModelRequest } from "@devflow/agent";
import { FreshAgentPlanOutputSchema } from "@devflow/shared";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import { createConfiguredLanguageModel } from "../../../packages/agent/src/vercel-ai-model.js";
import { ApprovalWorkflowRunExecutor } from "../src/runs/approval-workflow-run-executor.js";
import { loadWorkerEnvironment } from "../src/config/env.js";
import { hash } from "../src/localization/contracts.js";
import { generateStructuredOutput } from "../src/runs/workflow-structured-output.js";

vi.mock("../src/runs/local-run-snapshot.js", () => ({
  ensureLocalRunSnapshot: async () => undefined,
  requireLocalRunSnapshot: async () => {
    const content = "export const add = (a, b) => a - b;\n";
    return {
      files: [
        {
          path: "calculator.mjs",
          kind: "FILE",
          sizeBytes: Buffer.byteLength(content),
          sha256: hash(content),
          contentBase64: Buffer.from(content).toString("base64"),
        },
      ],
    };
  },
}));
afterEach(() => vi.unstubAllGlobals());
const plan = {
  summary: "Repair addition",
  steps: [
    { id: "fix", title: "Fix addition", description: "Use addition; preserve the public test." },
  ],
  complexity: "SIMPLE",
  estimatedSteps: 4,
  confidence: 0.9,
  executionContract: {
    version: "execution-contract-v1",
    editTargets: [
      {
        path: "calculator.mjs",
        symbol: "add",
        operation: "MODIFY",
        rationale: "Correct the observed subtraction implementation",
      },
    ],
    inspectTargets: [],
    verificationHints: [],
    unresolvedQuestions: [],
  },
  behaviorAudit: {
    constraints: [],
    uncertainties: [
      "No public behavior test is present in this fixture; verify addition after approval.",
    ],
  },
};

it("keeps the original PLAN schema in fallback format repair and fails closed after one attempt", async () => {
  const bodies: { messages: { content: string }[] }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: "invalid",
          object: "chat.completion",
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: '{"taskType":"bug","relevantFiles":[]}' },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  const model = createConfiguredLanguageModel({
    provider: "openai-compatible",
    providerName: "test",
    model: "unknown",
    apiKey: "test-only",
    baseUrl: "https://models.example.test/v1",
  });
  await expect(
    generateStructuredOutput({
      model,
      schema: FreshAgentPlanOutputSchema,
      name: "agent_plan",
      description: "Plan",
      purpose: "PLAN",
      signal: new AbortController().signal,
      messages: [{ role: "USER", content: "SECRET_TASK_AND_EVIDENCE" }],
    }),
  ).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]!.messages[0]).toEqual(bodies[0]!.messages[0]);
  expect(JSON.stringify(bodies[1])).not.toContain("SECRET_TASK_AND_EVIDENCE");
  expect(JSON.stringify(bodies[1])).toContain("validationErrors");
});

it("sends localization and a minimal proposal through the actual provider adapter", async () => {
  const requests: ModelRequest[] = [];
  const wires: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      wires.push(JSON.parse(String(init?.body)));
      const request = requests.at(-1)!;
      const name = request.output?.name;
      const body = JSON.parse(
        String(request.messages.find((message) => message.role === "USER")!.content),
      );
      const output =
        name === "issue_localization"
          ? {
              summary: "Observed calculator implementation",
              hypotheses: [],
              inspect: [],
              candidates: [
                { evidenceId: body.evidence[0].id, explanation: "Actual addition implementation" },
              ],
              uncertainty: ["Behavior is not executed"],
            }
          : name === "plan_iteration"
            ? {
                action: "FINAL",
                reason: "Observed complete implementation",
                hypotheses: [],
                inspect: [],
                searches: [],
                uncertainty: [],
              }
            : {
                decision: "PROPOSE",
                goal: plan.summary,
                approach: [plan.steps[0]!.description],
                candidateFiles: [
                  { path: "calculator.mjs", intent: "EDIT", reason: "Correct subtraction" },
                ],
                verification: ["Check addition"],
                uncertainties: [],
              };
      return new Response(
        JSON.stringify({
          id: "agent-contract",
          object: "chat.completion",
          created: 1,
          model: "deepseek-v4.1-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify(output) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  const run = {
    id: "contract-run",
    currentStage: "START",
    status: "RUNNING",
    retryCount: 0,
    maxSteps: 12,
    maxTestRetries: 1,
    maxReviewRetries: 1,
    task: {
      title: "Repair addition",
      description: "Fix calculator.mjs without changing public behavior.",
      baseCommitSha: "a".repeat(40),
    },
    repository: { id: "contract-repo", sourceKind: "LOCAL" },
  } as RunExecutionRecord;
  const database = {
    artifacts: { list: async () => [], create: async () => ({ id: "evidence" }) },
    approvals: { list: async () => [] },
    events: { list: async () => [], append: async () => undefined },
    runs: { transition: async () => undefined },
  } as unknown as DatabaseAdapter;
  const adapter = createConfiguredLanguageModel({
    provider: "openai-compatible",
    providerName: "bailian",
    model: "deepseek-v4.1-flash",
    apiKey: "test-only",
    baseUrl: "https://models.example.test/v1",
    structuredOutputMode: "auto",
  });
  const executor = new ApprovalWorkflowRunExecutor(
    database,
    loadWorkerEnvironment({
      DATABASE_URL: "unused",
      DEVFLOW_PLAN_AGENT_MAX_TOTAL_TOKENS: "24000",
    }),
    () => ({
      async generate(request, options) {
        requests.push(request);
        return adapter.generate(request, options);
      },
    }),
  );
  const result = await executor.execute(run, new AbortController().signal);
  expect(result.status, JSON.stringify(result)).toBe("WAITING_APPROVAL");
  expect(requests.map((request) => request.output?.name)).toEqual([
    "issue_localization",
    "plan_proposal",
  ]);
  expect(wires).toHaveLength(2);
  const request = requests.at(-1)!;
  const contract = z.toJSONSchema(request.output!.schema);
  expect(contract.required).toContain("candidateFiles");
  expect(contract.required).not.toContain("executionContract");
  expect(JSON.stringify(request.messages)).toContain("calculator.mjs");
  const messages = wires.at(-1)!.messages as { role: string; content: string }[];
  expect(JSON.parse(messages[0]!.content.split("\n").at(-1)!)).toEqual(contract);
  expect(wires.at(-1)!.response_format).toEqual({ type: "json_object" });
});
