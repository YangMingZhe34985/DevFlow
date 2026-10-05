import {
  prepareStageContext,
  type LanguageModelPort,
  type ModelGenerationSettings,
} from "@devflow/agent";
import type { ModelStage } from "../config/stage-models.js";

export function stageLanguageModel(input: {
  model: LanguageModelPort;
  stage: ModelStage;
  settings?: ModelGenerationSettings;
  contextTokens?: number;
  provenance: Record<string, unknown>;
  record?(
    artifact: ReturnType<typeof prepareStageContext>,
    binding: Record<string, unknown>,
  ): Promise<void>;
}): LanguageModelPort {
  return {
    generate: async (request, options) => {
      options.signal.throwIfAborted();
      const configured = input.settings ?? {};
      const outputCap =
        request.settings?.maxOutputTokens === undefined
          ? configured.maxOutputTokens
          : Math.min(
              request.settings.maxOutputTokens,
              configured.maxOutputTokens ?? Number.MAX_SAFE_INTEGER,
            );
      // Explicit none is a bounded helper/recovery decision. Re-enabling stage
      // thinking here can consume its entire output envelope before any JSON.
      const settings = {
        ...request.settings,
        ...(configured.reasoningEffort && request.settings?.reasoningEffort !== "none"
          ? { reasoningEffort: configured.reasoningEffort }
          : {}),
        ...(outputCap === undefined ? {} : { maxOutputTokens: outputCap }),
      };
      const artifact = prepareStageContext({
        stage: input.stage,
        history: request.messages,
        maxBytes: (input.contextTokens ?? 32000) * 3,
      });
      await input.record?.(artifact, { ...input.provenance, effectiveSettings: settings });
      options.signal.throwIfAborted();
      return input.model.generate({ ...request, messages: artifact.view, settings }, options);
    },
  };
}
