import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createConfiguredLanguageModel } from "../src/vercel-ai-model.js";
import { preparedInput } from "../src/model-budget.js";
const model = () =>
  createConfiguredLanguageModel({
    provider: "openai-compatible",
    providerName: "bailian",
    model: "glm-5.3",
    apiKey: "offline-only",
    baseUrl: "https://provider.invalid/v1",
    parameters: { maxOutputTokens: 8192 },
    enableThinking: true,
    contextMaxBytes: 96000,
  });
const signal = new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

it("materializes complete actual HTTP input without issuing HTTP and dispatches the identical body", async () => {
  let sent = "";
  const http = vi.fn(async (_url, init) => {
    sent = init.body;
    return new Response(
      JSON.stringify({
        id: "offline",
        model: "glm-5.3",
        choices: [
          { index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", http);
  const adapter = model();
  const request = await adapter.prepareRequest!(
    {
      messages: [{ role: "USER", content: "Keep the Issue and current Plan" }],
      tools: [
        {
          name: "readFile",
          description: "Read exact current evidence",
          inputSchema: z.object({ path: z.string() }),
        },
      ],
      settings: { maxOutputTokens: 8192, reasoningEffort: "low" },
    },
    { signal },
  );
  expect(http).not.toHaveBeenCalled();
  const input = preparedInput(request)!;
  expect(JSON.parse(input.serialized)).toMatchObject({
    model: "glm-5.3",
    max_tokens: 8192,
    enable_thinking: true,
    tools: [
      {
        type: "function",
        function: { name: "readFile", parameters: expect.objectContaining({ type: "object" }) },
      },
    ],
  });
  await adapter.generate(request, { signal });
  expect(http).toHaveBeenCalledTimes(1);
  expect(sent).toBe(input.serialized);
});

it("rejects mutated request or forged projection without HTTP", async () => {
  const http = vi.fn();
  vi.stubGlobal("fetch", http);
  const adapter = model();
  const prepared = await adapter.prepareRequest!(
    { messages: [{ role: "USER", content: "original" }], tools: [] },
    { signal },
  );
  await expect(
    adapter.generate({ ...prepared, messages: [{ role: "USER", content: "changed" }] }, { signal }),
  ).rejects.toMatchObject({ details: { requestIssued: false } });
  await expect(
    adapter.generate(
      {
        ...prepared,
        inputProjection: {
          ...prepared.inputProjection!,
          guardSerialized: "{}",
          serializedBytes: prepared.inputProjection!.wireBytes,
          estimatedInputTokens: Math.ceil(prepared.inputProjection!.wireBytes / 3),
        },
      },
      { signal },
    ),
  ).rejects.toMatchObject({ details: { requestIssued: false } });
  expect(http).not.toHaveBeenCalled();
});

it("preserves the original adapter-envelope and final HTTP 96000 byte caps", async () => {
  const http = vi.fn();
  vi.stubGlobal("fetch", http);
  const adapter = model();
  const prepared = await adapter.prepareRequest!(
    { messages: [{ role: "USER", content: "evidence".repeat(14000) }], tools: [] },
    { signal },
  );
  expect(prepared.inputProjection!.serializedBytes).toBeGreaterThan(96000);
  await expect(adapter.generate(prepared, { signal })).rejects.toMatchObject({
    details: { requestIssued: false, maxBytes: 96000 },
  });
  expect(http).not.toHaveBeenCalled();
});
