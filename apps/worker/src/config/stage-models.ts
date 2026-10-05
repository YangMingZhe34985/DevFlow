import { createHash } from "node:crypto";
import { z } from "zod";
import { DevflowError } from "@devflow/shared";
import type { VercelAiModelConfig, ModelGenerationSettings } from "@devflow/agent";

export const MODEL_STAGES = ["LOCALIZATION", "PLANNER", "EXECUTE", "REPAIR", "REVIEW"] as const;
export type ModelStage = (typeof MODEL_STAGES)[number];
const blank = (v: unknown) => (typeof v === "string" && !v.trim() ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());
const StageOptionsSchema = z.object({
  provider: optional(z.enum(["openai", "openai-compatible"])),
  model: optional(z.string().trim().min(1)),
  apiKey: optional(z.string().min(1)),
  baseUrl: optional(z.string().url()),
  providerName: optional(z.string().min(1)),
  structuredOutputMode: optional(z.enum(["auto", "json-schema", "json-object"])),
  reasoningEffort: optional(z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])),
  enableThinking: optional(z.enum(["true", "false"]).transform((v) => v === "true")),
  maxOutputTokens: optional(z.coerce.number().int().positive()),
  contextTokens: optional(z.coerce.number().int().min(512)),
});
export type StageOptions = z.infer<typeof StageOptionsSchema>;
export type StageModels = Partial<Record<ModelStage, StageOptions>>;
const fields = {
  provider: "PROVIDER",
  model: "MODEL",
  apiKey: "API_KEY",
  baseUrl: "BASE_URL",
  providerName: "PROVIDER_NAME",
  structuredOutputMode: "STRUCTURED_OUTPUT_MODE",
  reasoningEffort: "REASONING_EFFORT",
  enableThinking: "ENABLE_THINKING",
  maxOutputTokens: "MAX_OUTPUT_TOKENS",
  contextTokens: "CONTEXT_TOKENS",
} as const;

export function parseStageModels(env: NodeJS.ProcessEnv): StageModels {
  return Object.fromEntries(
    MODEL_STAGES.map((stage) => [
      stage,
      StageOptionsSchema.parse(
        Object.fromEntries(
          Object.entries(fields).map(([key, suffix]) => [key, env[`LLM_${stage}_${suffix}`]]),
        ),
      ),
    ]),
  );
}

export function resolveStageModel(
  stage: ModelStage,
  env: {
    LLM_PROVIDER?: VercelAiModelConfig["provider"] | undefined;
    LLM_MODEL?: string | undefined;
    LLM_API_KEY?: string | undefined;
    LLM_BASE_URL?: string | undefined;
    LLM_PROVIDER_NAME?: string | undefined;
    LLM_STRUCTURED_OUTPUT_MODE: VercelAiModelConfig["structuredOutputMode"];
    stageModels?: StageModels;
  },
  run: { modelProvider?: string; modelName?: string } = {},
) {
  const override = env.stageModels?.[stage] ?? {};
  const provider = override.provider ?? run.modelProvider ?? env.LLM_PROVIDER;
  const model = override.model ?? run.modelName ?? env.LLM_MODEL;
  const baseUrl = override.baseUrl ?? env.LLM_BASE_URL;
  const apiKey = override.apiKey ?? env.LLM_API_KEY;
  const origin = (url?: string) => new URL(url ?? "https://api.openai.com/v1").origin;
  if (
    !override.apiKey &&
    (provider !== (run.modelProvider ?? env.LLM_PROVIDER) ||
      origin(baseUrl) !== origin(env.LLM_BASE_URL))
  )
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: `${stage}: a different provider/endpoint requires LLM_${stage}_API_KEY; credentials are not forwarded across providers.`,
    });
  if (
    !model ||
    !apiKey ||
    !["openai", "openai-compatible"].includes(provider ?? "") ||
    (provider === "openai-compatible" && !baseUrl)
  )
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: `${stage}: provider, model, API key and compatible endpoint must be configured.`,
    });
  if (
    baseUrl &&
    (new URL(baseUrl).username || new URL(baseUrl).password || new URL(baseUrl).search)
  )
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: `${stage}: endpoint must not contain credentials or query parameters.`,
    });
  const glm53 = /^glm-5\.3(?:[.-]|$)/i.test(model);
  const deepseekV4 = /^deepseek-v4/i.test(model);
  if (
    (glm53 || deepseekV4) &&
    override.reasoningEffort &&
    !["low", "high", "max", ...(glm53 ? [] : ["none"])].includes(override.reasoningEffort)
  )
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: `${stage}: ${model} does not support reasoning effort ${override.reasoningEffort}.`,
    });
  if (
    glm53 &&
    (override.enableThinking === false || override.structuredOutputMode === "json-schema")
  )
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: `${stage}: glm-5.3 requires thinking and JSON-object structured output.`,
    });
  const config: VercelAiModelConfig = {
    provider: provider as VercelAiModelConfig["provider"],
    model,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...((override.providerName ?? env.LLM_PROVIDER_NAME)
      ? { providerName: (override.providerName ?? env.LLM_PROVIDER_NAME)! }
      : {}),
    structuredOutputMode: override.structuredOutputMode ?? env.LLM_STRUCTURED_OUTPUT_MODE ?? "auto",
    contextMaxBytes: (override.contextTokens ?? 32000) * 3,
    ...(override.enableThinking === undefined ? {} : { enableThinking: override.enableThinking }),
  };
  const settings: ModelGenerationSettings = {
    ...(override.reasoningEffort ? { reasoningEffort: override.reasoningEffort } : {}),
    ...(override.maxOutputTokens ? { maxOutputTokens: override.maxOutputTokens } : {}),
  };
  const provenance = {
    version: "stage-model-binding-v1",
    stage,
    provider,
    model,
    baseUrl: baseUrl ?? "https://api.openai.com/v1",
    providerName: config.providerName ?? provider,
    structuredOutputMode: config.structuredOutputMode,
    modelSource: override.model
      ? `LLM_${stage}_MODEL`
      : run.modelName
        ? "run.modelName"
        : "LLM_MODEL",
    credentialSource: override.apiKey ? `LLM_${stage}_API_KEY` : "LLM_API_KEY",
    settings,
    enableThinking: override.enableThinking ?? "provider-default",
    contextTokens: override.contextTokens ?? 32000,
  };
  return {
    config,
    settings,
    contextTokens: override.contextTokens ?? 32000,
    provenance: {
      ...provenance,
      configurationHash: createHash("sha256").update(JSON.stringify(provenance)).digest("hex"),
    },
  };
}
