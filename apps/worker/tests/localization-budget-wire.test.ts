import { afterEach, expect, it, vi } from "vitest";
import { createConfiguredLanguageModel } from "@devflow/agent";
import { loadWorkerEnvironment } from "../src/config/env.js";
import { resolveStageModel } from "../src/config/stage-models.js";
import { stageLanguageModel } from "../src/runs/stage-language-model.js";
import { IssueLocalizationAgent } from "../src/localization/issue-localization-agent.js";

afterEach(() => vi.unstubAllGlobals());

it("carries the stage ceiling onto the wire and disables thinking only for the accounted LENGTH recovery", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const first = bodies.length === 1;
      return new Response(
        JSON.stringify({
          id: `response-${bodies.length}`,
          object: "chat.completion",
          created: 1,
          model: "deepseek-v4.1-flash",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: first
                  ? ""
                  : JSON.stringify({
                      summary: "Evidence is inconclusive",
                      hypotheses: [],
                      inspect: [],
                      candidates: [],
                      uncertainty: ["Need more evidence"],
                    }),
              },
              finish_reason: first ? "length" : "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: first ? 4096 : 50,
            total_tokens: first ? 4196 : 150,
            completion_tokens_details: { reasoning_tokens: first ? 4096 : 0 },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  const environment = loadWorkerEnvironment({
    DATABASE_URL: "test",
    LLM_PROVIDER: "openai-compatible",
    LLM_MODEL: "deepseek-v4.1-flash",
    LLM_API_KEY: "test",
    LLM_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    LLM_PROVIDER_NAME: "bailian",
    LLM_LOCALIZATION_MAX_OUTPUT_TOKENS: "4096",
    LLM_LOCALIZATION_ENABLE_THINKING: "true",
    LLM_LOCALIZATION_REASONING_EFFORT: "low",
  });
  const binding = resolveStageModel("LOCALIZATION", environment);
  const model = stageLanguageModel({
    model: createConfiguredLanguageModel(binding.config),
    stage: "LOCALIZATION",
    settings: binding.settings,
    provenance: binding.provenance,
  });
  const result = await new IssueLocalizationAgent().run({
    title: "bug",
    description: "public issue",
    repositoryId: "repo",
    baseCommitSha: "base",
    source: {
      identity: "immutable",
      fileCount: 0,
      manifest: async () => ({ entries: [], incomplete: false }),
      read: async () => {
        throw Error("No invented source read");
      },
    },
    model,
    maxOutputTokens: binding.settings.maxOutputTokens,
    maxTokens: 18000,
    signal: new AbortController().signal,
    retrieve: async () => undefined,
  });
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({
    max_tokens: 4096,
    enable_thinking: true,
    reasoning_effort: "low",
  });
  expect(bodies[1]).toMatchObject({ max_tokens: 4096, enable_thinking: false });
  expect(bodies[1]).not.toHaveProperty("reasoning_effort");
  expect(bodies[1]?.messages).toEqual(bodies[0]?.messages);
  expect(result.metrics).toMatchObject({ modelCalls: 2, totalTokens: 4346 });
  expect(result.status).toBe("INCONCLUSIVE");
});
