import {
  prepareStageContext,
  preparedInput,
  inputHash,
  type LanguageModelPort,
  type ModelGenerationSettings,
  type ModelRequest,
} from "@devflow/agent";
import type { ModelStage } from "../config/stage-models.js";
import { DevflowError } from "@devflow/shared";

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
  const configure = (request: ModelRequest): ModelRequest => {
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
      ...(configured.reasoningEffort &&
      request.settings?.reasoningEffort !== "none" &&
      !(
        input.stage === "REVIEW" &&
        request.settings?.reasoningEffort === "low" &&
        request.output?.name === "review_result" &&
        request.tools.length === 0
      )
        ? { reasoningEffort: configured.reasoningEffort }
        : {}),
      ...(outputCap === undefined ? {} : { maxOutputTokens: outputCap }),
    };
    return { ...request, settings };
  };
  return {
    ...(input.model.prepareRequest
      ? {
          prepareRequest: (request, options) =>
            input.model.prepareRequest!(configure(request), options),
        }
      : {}),
    generate: async (request, options) => {
      options.signal.throwIfAborted();
      request = configure(request);
      const prepared = preparedInput(request);
      const artifact = prepareStageContext({
        stage: input.stage,
        history: request.messages,
        maxBytes: prepared ? Number.MAX_SAFE_INTEGER : (input.contextTokens ?? 32000) * 3,
      });
      if (prepared) {
        artifact.view = [...request.messages];
        artifact.viewSha256 = inputHash(JSON.stringify(artifact.view));
        artifact.viewBytes = Buffer.byteLength(JSON.stringify(artifact.view));
        artifact.maxBytes = (input.contextTokens ?? 32000) * 3;
        artifact.omitted = [];
        artifact.projected = [];
        if (
          prepared.serializedBytes > artifact.maxBytes ||
          prepared.estimatedInputTokens > (input.contextTokens ?? 32000)
        )
          throw new DevflowError({
            code: "VALIDATION_ERROR",
            message: "Prepared stage input exceeds configured context capacity",
            details: {
              requestIssued: false,
              requiredBytes: prepared.serializedBytes,
              maxBytes: artifact.maxBytes,
            },
          });
      }
      await input.record?.(artifact, { ...input.provenance, effectiveSettings: request.settings });
      options.signal.throwIfAborted();
      return input.model.generate(
        prepared ? request : { ...request, messages: artifact.view },
        options,
      );
    },
  };
}
