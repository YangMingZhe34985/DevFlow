/** Same stage/environment bindings as phase0-dataset; no provider instantiated in Fake mode. */
import { createConfiguredLanguageModel, type KernelPrice } from "@devflow/agent";
import { loadWorkerEnvironment } from "../../../apps/worker/src/config/env.js";
import { resolveStageModel } from "../../../apps/worker/src/config/stage-models.js";
import { reviewSettings } from "../../../apps/worker/src/autonomous/review.js";

export function configuredModels() {
  try {
    const environment = loadWorkerEnvironment(process.env);
    const prices = JSON.parse(process.env.DEVFLOW_MODEL_PRICES_JSON ?? "{}") as Record<
      string,
      KernelPrice
    >;
    function binding(stage: "EXECUTE" | "REVIEW") {
      const resolved = resolveStageModel(stage, environment);
      const { contextMaxBytes: _context, ...config } = resolved.config;
      const price = prices[`${resolved.provenance.provider}:${resolved.provenance.model}`];
      if (
        !price ||
        !Number.isFinite(price.inputMicrosPerMillionTokens) ||
        price.inputMicrosPerMillionTokens <= 0 ||
        !Number.isFinite(price.outputMicrosPerMillionTokens) ||
        price.outputMicrosPerMillionTokens <= 0 ||
        (price.cachedInputMicrosPerMillionTokens !== undefined &&
          (!Number.isFinite(price.cachedInputMicrosPerMillionTokens) ||
            price.cachedInputMicrosPerMillionTokens < 0 ||
            price.cachedInputMicrosPerMillionTokens > price.inputMicrosPerMillionTokens))
      )
        throw Error("Missing/invalid price");
      return {
        model: createConfiguredLanguageModel(config),
        price,
        settings: resolved.settings,
        modelName: config.model,
        contextTokens: resolved.contextTokens,
      };
    }
    const solver = binding("EXECUTE"),
      reviewer = binding("REVIEW");
    return {
      solver,
      review: {
        model: reviewer.model,
        price: reviewer.price,
        settings: reviewSettings(reviewer.modelName, reviewer.settings, {
          maxOutputTokens: environment.DEVFLOW_AUTONOMOUS_REVIEW_MAX_OUTPUT,
          reasoningEffort: environment.DEVFLOW_AUTONOMOUS_REVIEW_REASONING,
        }),
        triageSettings: reviewSettings(reviewer.modelName, reviewer.settings, {
          maxOutputTokens: environment.DEVFLOW_AUTONOMOUS_REVIEW_MAX_OUTPUT,
          reasoningEffort: environment.DEVFLOW_AUTONOMOUS_REVIEW_TRIAGE_REASONING,
        }),
        maxTurns: environment.DEVFLOW_AUTONOMOUS_REVIEW_TOOL_TURNS,
        reserve: environment.DEVFLOW_AUTONOMOUS_REVIEW_RESERVE,
      },
      maxAttempts: environment.DEVFLOW_AUTONOMOUS_MAX_ATTEMPTS,
    };
  } catch {
    // Never print environment validation input, request headers, endpoint credentials or SDK causes.
    throw Error(
      "External live model configuration/price invalid; verify the same stage variables used by phase0-dataset",
    );
  }
}
