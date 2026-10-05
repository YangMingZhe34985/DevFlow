import { afterEach, expect, it, vi } from "vitest";
import { createConfiguredLanguageModel } from "../src/vercel-ai-model.js";

afterEach(() => vi.unstubAllGlobals());

it("maps the pinned DeepSeek compatible request to max_tokens and retains reasoning-only LENGTH usage", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: "offline-length-fixture",
          object: "chat.completion",
          created: 1,
          model: "deepseek-v4.1-flash",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "fixture reasoning",
              },
              finish_reason: "length",
            },
          ],
          usage: {
            prompt_tokens: 4435,
            completion_tokens: 6000,
            total_tokens: 10435,
            completion_tokens_details: { reasoning_tokens: 6000 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  const adapter = createConfiguredLanguageModel({
    provider: "openai-compatible",
    providerName: "bailian",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "offline-fixture-only",
    model: "deepseek-v4.1-flash",
    parameters: { maxOutputTokens: 6000 },
  });
  const result = await adapter.generate(
    {
      messages: [{ role: "USER", content: "fixture" }],
      tools: [],
      settings: { reasoningEffort: "low", maxOutputTokens: 9000 },
    },
    { signal: new AbortController().signal },
  );
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    max_tokens: 6000,
    enable_thinking: true,
    reasoning_effort: "low",
  });
  for (const key of ["max_completion_tokens", "thinking_budget"])
    expect(bodies[0]).not.toHaveProperty(key);
  expect(result).toMatchObject({
    finishReason: "LENGTH",
    toolCalls: [],
    reasoningTokens: 6000,
    usage: { inputTokens: 4435, outputTokens: 6000, totalTokens: 10435 },
  });
});
