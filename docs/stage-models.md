# Model configuration

Copy `.env.example` to `.env`, set the platform credential and restart the Worker after changes. `.env` is ignored by Git. DevFlow depends on model capabilities, not on a particular vendor.

## Bindings

| Binding   | Role                                                              | Example default in `.env.example` |
| --------- | ----------------------------------------------------------------- | --------------------------------- |
| `EXECUTE` | The autonomous solver: explores, edits, tests and submits         | `glm-5.3`                         |
| `REVIEW`  | The independent reviewer (tier 1 triage and tier 2 investigation) | `deepseek-v4-pro-0813`            |

The solver needs reliable tool calling, editing and diagnostic interpretation. The reviewer needs independent reasoning about behavior. The host owns permissions, verification and budgets; models do not hold this authoritative state.

Replace `STAGE` with `EXECUTE` or `REVIEW`:

```dotenv
LLM_STAGE_PROVIDER=openai-compatible
LLM_STAGE_MODEL=your-model-id
LLM_STAGE_BASE_URL=https://your-provider.example/v1
LLM_STAGE_API_KEY=
LLM_STAGE_PROVIDER_NAME=your-provider
LLM_STAGE_STRUCTURED_OUTPUT_MODE=json-object
LLM_STAGE_REASONING_EFFORT=low
LLM_STAGE_ENABLE_THINKING=true
LLM_STAGE_MAX_OUTPUT_TOKENS=8192
LLM_STAGE_CONTEXT_TOKENS=32000
```

Blank fields inherit the global `LLM_*` setting (or the Run's provider/model when supplied); stage values take precedence. A different provider or endpoint requires its own stage API key, because the host never forwards credentials between providers. Check model identifiers, reasoning options and quota with your provider.

Output limits include reasoning and the final answer. GLM-5.3 requires thinking and JSON-object structured output, and supports only low/high/max reasoning. DeepSeek v4 supports none/low/high/max. Unsupported combinations are rejected before any request is sent. See [Bailian's compatible API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions) and [DeepSeek parameters](https://help.aliyun.com/zh/model-studio/deepseek-api).

## Review overrides

The reviewer uses the `REVIEW` binding, with output and reasoning overridden per tier:

```dotenv
DEVFLOW_AUTONOMOUS_REVIEW_MAX_OUTPUT=4096
DEVFLOW_AUTONOMOUS_REVIEW_REASONING=medium        # tier 2
DEVFLOW_AUTONOMOUS_REVIEW_TRIAGE_REASONING=none   # tier 1: one structured verdict
```

A level the model does not support steps down to the nearest supported one, so `medium` becomes `low` on GLM-5.3 and DeepSeek v4. Tier 1 runs with thinking off where the model allows it; with reasoning on, a single verdict spent thousands of output tokens on reasoning. See [autonomous mode](v4/autonomous-mode.md) for the full flow.

## Prices and limits

`DEVFLOW_MODEL_PRICES_JSON` supplies token rates for each active transport `provider:model`, for example `openai-compatible:glm-5.3` (the `LLM_PROVIDER_NAME` display label is not part of the key). Each value has integer `inputMicrosPerMillionTokens` and `outputMicrosPerMillionTokens`, and optionally `cachedInputMicrosPerMillionTokens` for provider prompt-cache hits. Rates and `DEVFLOW_MAX_COST_MICROS` share one currency in millionths. Missing rates are unpriced, not free. The example leaves prices blank and assumes no vendor rate.

Each Run has hard limits that apply across all attempts and revisions:

| Setting                             | Meaning                                               |
| ----------------------------------- | ----------------------------------------------------- |
| `DEVFLOW_MAX_COST_MICROS`           | Cost cap; unconfirmed calls count at their worst case |
| `DEVFLOW_TIMEOUT_MS`                | Absolute deadline (default 25 minutes)                |
| `DEVFLOW_AUTONOMOUS_MAX_TURNS`      | Solver turns                                          |
| `DEVFLOW_AUTONOMOUS_MAX_ATTEMPTS`   | Fresh-sandbox attempts                                |
| `DEVFLOW_AUTONOMOUS_REVIEW_RESERVE` | Share of the cost cap reserved for review (0.15)      |

Resuming a Run never extends its saved deadline or resets its consumption.
