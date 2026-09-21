import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createConfiguredLanguageModel,
  resolveStructuredOutputMode,
  VercelAiLanguageModel,
} from "../src/vercel-ai-model.js";

describe("VercelAiLanguageModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies pinned benchmark generation parameters to every provider call", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 3, text: 3, reasoning: 0 },
        },
        warnings: [],
      },
    });
    const adapter = new VercelAiLanguageModel(model, {
      temperature: 0,
      topP: 0.75,
      seed: 42,
      maxOutputTokens: 321,
    });

    const result = await adapter.generate(
      { messages: [{ role: "USER", content: "work" }], tools: [] },
      { signal: new AbortController().signal },
    );

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]).toMatchObject({
      temperature: 0,
      topP: 0.75,
      seed: 42,
      maxOutputTokens: 321,
    });
    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      reasoningTokens: 0,
    });
  });

  it("uses Output.object, validates the value, and forwards stage reasoning", async () => {
    const model = modelReturning('{"answer":"ok"}');
    const adapter = new VercelAiLanguageModel(model, {}, { providerOptionsName: "test" });

    const result = await adapter.generate(
      {
        messages: [{ role: "USER", content: "return an answer" }],
        tools: [],
        output: {
          name: "review_result",
          description: "A strict review result.",
          schema: z.object({ answer: z.string() }).strict(),
        },
        settings: { reasoningEffort: "low" },
      },
      { signal: new AbortController().signal },
    );

    expect(result.output).toEqual({ answer: "ok" });
    expect(result.structuredOutput).toMatchObject({
      status: "SUCCESS",
      rawTextLength: 15,
    });
    expect(result.structuredOutput?.rawTextHash).toHaveLength(64);
    expect(model.doGenerateCalls[0]).toMatchObject({
      responseFormat: {
        type: "json",
        name: "review_result",
        description: "A strict review result.",
      },
      providerOptions: { test: { reasoningEffort: "low" } },
    });
  });

  it("returns INVALID_JSON with raw output and usage instead of losing diagnostics", async () => {
    const adapter = new VercelAiLanguageModel(modelReturning("not-json"));

    const result = await adapter.generate(
      {
        messages: [{ role: "USER", content: "return JSON" }],
        tools: [],
        output: { schema: z.object({ answer: z.string() }) },
      },
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({
      text: "not-json",
      finishReason: "STOP",
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      structuredOutput: {
        status: "ERROR",
        code: "INVALID_JSON",
        rawText: "not-json",
        rawTextLength: 8,
      },
    });
    expect(result.structuredOutput?.rawTextHash).toHaveLength(64);
  });

  it("returns SCHEMA_MISMATCH with normalized Zod issues", async () => {
    const adapter = new VercelAiLanguageModel(modelReturning('{"answer":7}'));

    const result = await adapter.generate(
      {
        messages: [{ role: "USER", content: "return JSON" }],
        tools: [],
        output: { schema: z.object({ answer: z.string() }).strict() },
      },
      { signal: new AbortController().signal },
    );

    expect(result.structuredOutput).toMatchObject({
      status: "ERROR",
      code: "SCHEMA_MISMATCH",
      rawText: '{"answer":7}',
      issues: [
        {
          path: "answer",
          code: "invalid_type",
        },
      ],
    });
  });

  it("classifies a stopped response with no content as EMPTY_OUTPUT", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(),
        warnings: [],
      },
    });
    const adapter = new VercelAiLanguageModel(model);

    const result = await adapter.generate(
      {
        messages: [{ role: "USER", content: "return JSON" }],
        tools: [],
        output: { schema: z.object({ answer: z.string() }) },
      },
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({
      structuredOutput: {
        status: "ERROR",
        code: "EMPTY_OUTPUT",
        rawTextLength: 0,
      },
    });
  });

  it("auto-selects native schema only for known compatible providers and models", () => {
    expect(
      resolveStructuredOutputMode({
        provider: "openai-compatible",
        providerName: "bailian",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.8-flash",
      }),
    ).toBe("json-schema");
    expect(
      resolveStructuredOutputMode({
        provider: "openai-compatible",
        providerName: "custom",
        baseUrl: "https://models.example.test/v1",
        model: "qwen3.8-flash",
      }),
    ).toBe("json-object");
    expect(
      resolveStructuredOutputMode({
        provider: "openai-compatible",
        providerName: "custom",
        baseUrl: "https://models.example.test/v1",
        model: "custom-model",
        structuredOutputMode: "json-schema",
      }),
    ).toBe("json-schema");
  });

  it("sends Bailian native JSON schema with thinking disabled", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as unknown);
        return new Response(
          JSON.stringify({
            id: "completion-1",
            object: "chat.completion",
            created: 1,
            model: "qwen3.8-flash",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: '{"answer":"ok"}' },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const adapter = createConfiguredLanguageModel({
      provider: "openai-compatible",
      providerName: "bailian",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-key",
      model: "qwen3.8-flash",
    });

    const result = await adapter.generate(
      {
        messages: [{ role: "USER", content: "return JSON" }],
        tools: [],
        output: { name: "answer", schema: z.object({ answer: z.string() }).strict() },
        settings: { reasoningEffort: "none" },
      },
      { signal: new AbortController().signal },
    );

    expect(result.output).toEqual({ answer: "ok" });
    expect(bodies[0]).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", strict: true },
      },
      enable_thinking: false,
    });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
  });

  it("uses JSON-object wire mode for an unknown OpenAI-compatible provider", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as unknown);
        return new Response(
          JSON.stringify({
            id: "completion-2",
            object: "chat.completion",
            created: 1,
            model: "custom-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: '{"answer":"ok"}' },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const adapter = createConfiguredLanguageModel({
      provider: "openai-compatible",
      providerName: "custom",
      baseUrl: "https://models.example.test/v1",
      apiKey: "test-key",
      model: "custom-model",
    });

    const result = await adapter.generate(
      {
        messages: [{ role: "USER", content: "return JSON" }],
        tools: [],
        output: { schema: z.object({ answer: z.string() }).strict() },
        settings: { reasoningEffort: "low" },
      },
      { signal: new AbortController().signal },
    );

    expect(result.output).toEqual({ answer: "ok" });
    expect(bodies[0]).toMatchObject({
      response_format: { type: "json_object" },
    });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    expect(bodies[0]).not.toHaveProperty("enable_thinking");
  });
});

function modelReturning(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    },
  });
}

function usage() {
  return {
    inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 3, text: 3, reasoning: 0 },
  };
}
