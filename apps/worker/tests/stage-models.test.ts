import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { loadWorkerEnvironment } from "../src/config/env.js";
import { resolveStageModel } from "../src/config/stage-models.js";
import { createConfiguredLanguageModel } from "@devflow/agent";
afterEach(() => vi.unstubAllGlobals());

const env = {
  DATABASE_URL: "test",
  LLM_PROVIDER: "openai-compatible",
  LLM_MODEL: "default",
  LLM_API_KEY: "secret-never-log",
  LLM_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  LLM_PROVIDER_NAME: "bailian",
};
describe("stage model bindings", () => {
  it.each([
    {
      stage: "REVIEW" as const,
      model: "deepseek-v4-pro-0813",
      maxTokens: 16384,
      effort: "high",
      context: 64000,
    },
    { stage: "EXECUTE" as const, model: "glm-5.3", maxTokens: 8192, effort: "low", context: 32000 },
  ])(
    "forwards the public $stage configuration to HTTP without a smaller internal output cap",
    async ({ stage, model, maxTokens, effort, context }) => {
      const example = Object.fromEntries(
        readFileSync(".env.example", "utf8")
          .split(/\r?\n/u)
          .flatMap((line) => {
            const match = line.match(/^(LLM_[A-Z_]+)=(.*)$/u);
            return match ? [[match[1]!, match[2]!]] : [];
          }),
      );
      const configured = loadWorkerEnvironment({
        ...example,
        DATABASE_URL: "test",
        LLM_API_KEY: "mock-only-key",
      });
      const binding = resolveStageModel(stage, configured),
        bodies: Record<string, unknown>[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init: RequestInit) => {
          bodies.push(JSON.parse(String(init.body)));
          return new Response(
            JSON.stringify({
              id: "mock",
              object: "chat.completion",
              created: 1,
              model: binding.config.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Done" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }),
      );
      await createConfiguredLanguageModel(binding.config).generate(
        {
          messages: [{ role: "USER", content: "Finish current stage" }],
          tools: [],
          settings: binding.settings,
        },
        { signal: new AbortController().signal },
      );
      expect(bodies[0]).toMatchObject({
        model,
        max_tokens: maxTokens,
        enable_thinking: true,
        reasoning_effort: effort,
      });
      expect(configured.stageModels?.[stage]?.contextTokens).toBe(context);
    },
  );
  it("resolves independent models/settings while inheriting default transport and credentials", () => {
    const configured = loadWorkerEnvironment({
      ...env,
      LLM_REVIEW_MODEL: "deepseek-v4-pro-0813",
      LLM_REVIEW_REASONING_EFFORT: "high",
    });
    const review = resolveStageModel("REVIEW", configured);
    const execute = resolveStageModel("EXECUTE", configured);
    expect(review.config.model).toBe("deepseek-v4-pro-0813");
    expect(execute.config.model).toBe("default");
    expect(review.settings.reasoningEffort).toBe("high");
    expect(execute.settings.reasoningEffort).toBeUndefined();
    expect(JSON.stringify(review.provenance)).not.toContain(env.LLM_API_KEY);
    expect(review.provenance.configurationHash).not.toBe(execute.provenance.configurationHash);
  });
  it("stage selection takes priority over a legacy run default, without changing the run", () => {
    const configured = loadWorkerEnvironment({ ...env, LLM_REVIEW_MODEL: "stage" });
    const run = { modelProvider: "openai-compatible", modelName: "run-default" };
    expect(resolveStageModel("REVIEW", configured, run).config.model).toBe("stage");
    expect(resolveStageModel("EXECUTE", configured, run).config.model).toBe("run-default");
    expect(run.modelName).toBe("run-default");
  });
  it("does not forward inherited credentials to a different provider endpoint", () => {
    const configured = loadWorkerEnvironment({
      ...env,
      LLM_EXECUTE_BASE_URL: "https://other.example/v1",
    });
    expect(() => resolveStageModel("EXECUTE", configured)).toThrow(/API_KEY/);
    const explicit = loadWorkerEnvironment({
      ...env,
      LLM_EXECUTE_BASE_URL: "https://other.example/v1",
      LLM_EXECUTE_API_KEY: "other-secret",
    });
    expect(resolveStageModel("EXECUTE", explicit).config.apiKey).toBe("other-secret");
  });
  it("fails known unsupported capabilities before calling a provider", () => {
    for (const bad of [
      { LLM_EXECUTE_REASONING_EFFORT: "medium" },
      { LLM_EXECUTE_ENABLE_THINKING: "false" },
      { LLM_EXECUTE_STRUCTURED_OUTPUT_MODE: "json-schema" },
    ]) {
      const configured = loadWorkerEnvironment({ ...env, LLM_EXECUTE_MODEL: "glm-5.3", ...bad });
      expect(() => resolveStageModel("EXECUTE", configured)).toThrow(/glm-5.3/);
    }
  });
});
