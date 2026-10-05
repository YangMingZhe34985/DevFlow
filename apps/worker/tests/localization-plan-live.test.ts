import { readFile, writeFile } from "node:fs/promises";
import { createConfiguredLanguageModel, type ModelMessage } from "@devflow/agent";
import { FreshAgentPlanOutputSchema } from "@devflow/shared";
import { it, expect } from "vitest";
import { z } from "zod";
import { loadWorkerEnvironment } from "../src/config/env.js";
import { generateStructuredOutput } from "../src/runs/workflow-structured-output.js";

it.skipIf(process.env.DEVFLOW_PLAN_CONTRACT_LIVE !== "1")(
  "Gate A: same-model PLAN contract OFF/ON",
  async () => {
    const env = loadWorkerEnvironment();
    if (!env.LLM_PROVIDER || !env.LLM_MODEL || !env.LLM_API_KEY)
      throw new Error("Configured credentials required");
    const captured = JSON.parse(
      await readFile("docs/performance/results/plan-contract-after.json", "utf8"),
    ) as {
      captures: {
        enabled: boolean;
        port: {
          messages: ModelMessage[];
          output: { name: string; description: string; schema: unknown };
        };
      }[];
    };
    const samples: unknown[] = [];
    for (let repeat = 0; repeat < 10; repeat++)
      for (const capture of captured.captures) {
        expect(capture.port.output.schema).toEqual(z.toJSONSchema(FreshAgentPlanOutputSchema));
        const model = createConfiguredLanguageModel({
          provider: env.LLM_PROVIDER,
          model: env.LLM_MODEL,
          apiKey: env.LLM_API_KEY,
          ...(env.LLM_BASE_URL ? { baseUrl: env.LLM_BASE_URL } : {}),
          ...(env.LLM_PROVIDER_NAME ? { providerName: env.LLM_PROVIDER_NAME } : {}),
          structuredOutputMode: env.LLM_STRUCTURED_OUTPUT_MODE,
          parameters: { temperature: 0 },
        });
        const started = Date.now();
        const attempts: unknown[] = [];
        try {
          const result = await generateStructuredOutput({
            model,
            schema: FreshAgentPlanOutputSchema,
            name: capture.port.output.name,
            description: capture.port.output.description,
            purpose: "PLAN",
            messages: capture.port.messages,
            signal: AbortSignal.timeout(60_000),
            onResponse: async (attempt) => {
              attempts.push({
                formatRepair: attempt.formatRepair,
                finishReason: attempt.response.finishReason,
                usage: attempt.response.usage,
                structuredOutput: attempt.response.structuredOutput,
                failure: attempt.failure,
              });
            },
          });
          samples.push({
            repeat,
            enabled: capture.enabled,
            valid: true,
            formatRepairs: result.formatRepairAttempts,
            wallMs: Date.now() - started,
            attempts,
          });
        } catch (error) {
          samples.push({
            repeat,
            enabled: capture.enabled,
            valid: false,
            wallMs: Date.now() - started,
            attempts,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
        await writeFile(
          "docs/performance/results/plan-contract-live.json",
          JSON.stringify(
            {
              model: env.LLM_MODEL,
              provider: env.LLM_PROVIDER,
              temperature: 0,
              maxFormatRepairs: 1,
              samples,
            },
            null,
            2,
          ),
        );
      }
    expect(samples.filter((sample) => !(sample as { valid: boolean }).valid)).toEqual([]);
  },
  600_000,
);
