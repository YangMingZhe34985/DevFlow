import type { TokenUsage } from "@devflow/shared";

import { PricingConfigurationSchema, type PricingConfiguration } from "./contracts.js";

const TOKEN_SCALE = 1_000_000;

export function estimateCostUsd(
  configurationInput: PricingConfiguration,
  provider: string,
  model: string,
  usage: Pick<TokenUsage, "inputTokens" | "outputTokens">,
): string {
  const configuration = PricingConfigurationSchema.parse(configurationInput);
  const entry = configuration.entries.find(
    (candidate) => candidate.provider === provider && candidate.model === model,
  );
  if (entry === undefined) {
    throw new Error(
      `Pricing configuration '${configuration.version}' has no entry for '${provider}/${model}'.`,
    );
  }
  const cost =
    (usage.inputTokens * entry.inputUsdPerMillionTokens +
      usage.outputTokens * entry.outputUsdPerMillionTokens) /
    TOKEN_SCALE;
  return formatUsd(cost);
}

export function addUsd(values: readonly string[]): string {
  return formatUsd(values.reduce((total, value) => total + Number(value), 0));
}

export function averageUsd(total: string, count: number): string {
  return formatUsd(count === 0 ? 0 : Number(total) / count);
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("USD amount must be finite and non-negative.");
  return value.toFixed(8);
}
