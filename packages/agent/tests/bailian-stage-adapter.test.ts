import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createConfiguredLanguageModel } from "../src/vercel-ai-model.js";
describe("Bailian stage wire protocol", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(["deepseek-v4-pro-0813", "glm-5.3"])(
    "keeps %s reasoning with JSON-object and counts reasoning once",
    async (modelName) => {
      let body: Record<string, unknown> = {};
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, request: RequestInit) => {
          body = JSON.parse(String(request.body));
          return new Response(
            JSON.stringify({
              id: "test",
              object: "chat.completion",
              created: 1,
              model: modelName,
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: '{"ok":true}',
                    reasoning_content: "internal",
                  },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30,
                completion_tokens_details: { reasoning_tokens: 15 },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }),
      );
      const model = createConfiguredLanguageModel({
        provider: "openai-compatible",
        model: modelName,
        apiKey: "test",
        baseUrl: "https://example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        structuredOutputMode: "json-object",
        enableThinking: true,
      });
      const response = await model.generate(
        {
          messages: [{ role: "USER", content: "Return JSON" }],
          tools: [],
          settings: { reasoningEffort: "high", maxOutputTokens: 2048 },
          output: { schema: z.object({ ok: z.boolean() }) },
        },
        { signal: AbortSignal.timeout(1000) },
      );
      expect(body.enable_thinking).toBe(true);
      expect(body.reasoning_effort).toBe("high");
      expect(body.response_format).toMatchObject({ type: "json_object" });
      expect(body.max_tokens).toBe(2048);
      if (modelName === "glm-5.3") expect(body.clear_thinking).toBe(true);
      expect(response.output).toEqual({ ok: true });
      expect(response.usage.totalTokens).toBe(30);
      expect(response.reasoningTokens).toBe(15);
      expect(JSON.stringify(response)).not.toContain("internal");
    },
  );
  it("keeps assistant tool calls paired with their returned result in a GLM follow-up", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, request: RequestInit) => {
        body = JSON.parse(String(request.body));
        return new Response(
          JSON.stringify({
            id: "test",
            model: "glm-5.3",
            choices: [
              { index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const model = createConfiguredLanguageModel({
      provider: "openai-compatible",
      model: "glm-5.3",
      apiKey: "test",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    await model.generate(
      {
        tools: [],
        messages: [
          { role: "USER", content: "Read" },
          {
            role: "ASSISTANT",
            content: "",
            toolCalls: [{ id: "read-1", name: "readFile", input: { path: "a" } }],
          },
          {
            role: "TOOL",
            toolCallId: "read-1",
            toolName: "readFile",
            content: { content: "a" },
            isError: false,
          },
        ],
      },
      { signal: AbortSignal.timeout(1000) },
    );
    expect(body.clear_thinking).toBe(true);
    const messages = body.messages as {
      role: string;
      tool_call_id?: string;
      tool_calls?: { id: string }[];
    }[];
    expect(messages[1]?.tool_calls?.[0]?.id).toBe("read-1");
    expect(messages[2]?.tool_call_id).toBe("read-1");
  });
  it("keeps DeepSeek tool reasoning privately within its model instance", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, request: RequestInit) => {
        bodies.push(JSON.parse(String(request.body)));
        const first = bodies.length === 1;
        return new Response(
          JSON.stringify({
            id: "test",
            model: "deepseek-v4-pro-0813",
            choices: [
              {
                index: 0,
                message: first
                  ? {
                      role: "assistant",
                      content: null,
                      reasoning_content: "private continuation",
                      tool_calls: [
                        {
                          id: "read-1",
                          type: "function",
                          function: { name: "readFile", arguments: '{"path":"a"}' },
                        },
                      ],
                    }
                  : { role: "assistant", content: "done" },
                finish_reason: first ? "tool_calls" : "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const configuration = {
      provider: "openai-compatible" as const,
      model: "deepseek-v4-pro-0813",
      apiKey: "test",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    };
    const model = createConfiguredLanguageModel(configuration);
    const tools = [
      { name: "readFile", description: "Read", inputSchema: z.object({ path: z.string() }) },
    ];
    const first = await model.generate(
      { tools, messages: [{ role: "USER", content: "Read a" }] },
      { signal: AbortSignal.timeout(1000) },
    );
    expect(JSON.stringify(first)).not.toContain("private continuation");
    const messages = [
      { role: "USER" as const, content: "Read a" },
      { role: "ASSISTANT" as const, content: "", toolCalls: first.toolCalls },
      {
        role: "TOOL" as const,
        toolName: "readFile",
        toolCallId: "read-1",
        content: "a",
        isError: false,
      },
    ];
    await model.generate({ tools, messages }, { signal: AbortSignal.timeout(1000) });
    expect((bodies[1]?.messages as { reasoning_content?: string }[])[1]?.reasoning_content).toBe(
      "private continuation",
    );
    await createConfiguredLanguageModel(configuration).generate(
      { tools, messages },
      { signal: AbortSignal.timeout(1000) },
    );
    expect(
      (bodies[2]?.messages as { reasoning_content?: string }[])[1]?.reasoning_content,
    ).toBeUndefined();
  });
});
