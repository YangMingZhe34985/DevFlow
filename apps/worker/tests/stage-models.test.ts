import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { loadWorkerEnvironment } from "../src/config/env.js";
import { resolveStageModel } from "../src/config/stage-models.js";
import { stageLanguageModel } from "../src/runs/stage-language-model.js";
import {
  FakeLanguageModel,
  fakeModelResponse,
  createConfiguredLanguageModel,
} from "@devflow/agent";
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
  it.each(["REVIEW", "REPAIR"] as const)(
    "forwards the public %s configuration to HTTP without a smaller internal output cap",
    async (stage) => {
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
        model: stage === "REVIEW" ? "deepseek-v4-pro-0813" : "glm-5.3",
        max_tokens: 16384,
        enable_thinking: true,
        reasoning_effort: stage === "REVIEW" ? "high" : "low",
      });
      expect(configured.stageModels?.[stage]?.contextTokens).toBe(64000);
    },
  );
  it("resolves independent models/settings while inheriting default transport and credentials", () => {
    const configured = loadWorkerEnvironment({
      ...env,
      LLM_PLANNER_MODEL: "deepseek-v4-pro-0813",
      LLM_EXECUTE_MODEL: "glm-5.3",
      LLM_PLANNER_REASONING_EFFORT: "high",
      LLM_EXECUTE_REASONING_EFFORT: "low",
    });
    const planner = resolveStageModel("PLANNER", configured);
    const execute = resolveStageModel("EXECUTE", configured);
    expect(planner.config.model).toBe("deepseek-v4-pro-0813");
    expect(execute.config.model).toBe("glm-5.3");
    expect(planner.settings.reasoningEffort).toBe("high");
    expect(execute.settings.reasoningEffort).toBe("low");
    expect(resolveStageModel("REVIEW", configured).config.model).toBe("default");
    expect(JSON.stringify(planner.provenance)).not.toContain(env.LLM_API_KEY);
    expect(planner.provenance.configurationHash).not.toBe(execute.provenance.configurationHash);
  });
  it("stage selection takes priority over a legacy run default, without changing the run", () => {
    const configured = loadWorkerEnvironment({ ...env, LLM_PLANNER_MODEL: "stage" });
    const run = { modelProvider: "openai-compatible", modelName: "run-default" };
    expect(resolveStageModel("PLANNER", configured, run).config.model).toBe("stage");
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
  it("preserves format repair none and clamps requested output to the stage cap", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({ toolCalls: [] }),
      fakeModelResponse({ toolCalls: [] }),
    ]);
    const records: unknown[] = [];
    const bound = stageLanguageModel({
      model,
      stage: "PLANNER",
      settings: { reasoningEffort: "high", maxOutputTokens: 8000 },
      provenance: { model: "test" },
      record: async (artifact, binding) => {
        records.push({ artifact, binding });
      },
    });
    await bound.generate(
      {
        messages: [{ role: "USER", content: "work" }],
        tools: [],
        settings: { maxOutputTokens: 9000 },
      },
      { signal: AbortSignal.timeout(1000) },
    );
    await bound.generate(
      {
        messages: [{ role: "SYSTEM", content: "You are a lossless JSON format converter." }],
        tools: [],
        settings: { reasoningEffort: "none", maxOutputTokens: 1024 },
      },
      { signal: AbortSignal.timeout(1000) },
    );
    expect(model.requests[0]?.settings).toEqual({ reasoningEffort: "high", maxOutputTokens: 8000 });
    expect(model.requests[1]?.settings).toEqual({ reasoningEffort: "none", maxOutputTokens: 1024 });
    expect(records).toHaveLength(2);
  });

  it("honors explicit non-thinking inspection and recovery without recognizing prompt text", async () => {
    const model = new FakeLanguageModel([fakeModelResponse({ toolCalls: [] })]);
    const bound = stageLanguageModel({
      model,
      stage: "PLANNER",
      settings: { reasoningEffort: "high", maxOutputTokens: 8192 },
      provenance: {},
    });
    await bound.generate(
      {
        messages: [{ role: "USER", content: "Inspect evidence" }],
        tools: [],
        settings: { reasoningEffort: "none", maxOutputTokens: 768 },
      },
      { signal: new AbortController().signal },
    );
    expect(model.requests[0]?.settings).toEqual({ reasoningEffort: "none", maxOutputTokens: 768 });
  });
});
