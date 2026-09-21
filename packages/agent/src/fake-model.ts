import { DevflowError } from "@devflow/shared";

import type { LanguageModelPort, ModelRequest, ModelResponse } from "./model.js";

export type FakeModelStep =
  | ModelResponse
  | ((request: ModelRequest, options: { signal: AbortSignal }) => Promise<ModelResponse>);

export class FakeLanguageModel implements LanguageModelPort {
  readonly requests: ModelRequest[] = [];
  private cursor = 0;

  constructor(private readonly steps: readonly FakeModelStep[]) {}

  async generate(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelResponse> {
    options.signal.throwIfAborted();
    this.requests.push(request);
    const step = this.steps[this.cursor];
    this.cursor += 1;
    if (step === undefined) {
      throw new DevflowError({
        code: "LLM_FAILED",
        message: "FakeLanguageModel has no scripted response remaining.",
      });
    }
    return typeof step === "function" ? step(request, options) : step;
  }
}

export function fakeModelResponse(
  options: Partial<ModelResponse> & Pick<ModelResponse, "toolCalls">,
): ModelResponse {
  return {
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.structuredOutput === undefined
      ? {}
      : { structuredOutput: options.structuredOutput }),
    toolCalls: options.toolCalls,
    finishReason: options.finishReason ?? (options.toolCalls.length > 0 ? "TOOL_CALLS" : "STOP"),
    usage: options.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ...(options.reasoningTokens === undefined ? {} : { reasoningTokens: options.reasoningTokens }),
    latencyMs: options.latencyMs ?? 0,
  };
}
