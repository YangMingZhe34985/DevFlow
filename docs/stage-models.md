# Stage model configuration

Copy `.env.example` to `.env`, set the platform credential and restart the Worker after changes. `.env` is ignored by Git. DevFlow supports model capabilities rather than requiring a particular vendor.

| Stage        | Responsibility                                                                                      | Example default in `.env.example`   |
| ------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Localization | Read and search public source, identify candidates and build a bounded static relationship artifact | `LLM_MODEL` (`deepseek-v4.1-flash`) |
| Planner      | Propose a repair direction, intended files, verification and uncertainty                            | `deepseek-v4-pro-0813`              |
| Execute      | Confirm current code and implement the approved change                                              | `glm-5.3`                           |
| Repair       | Check test/review findings, make targeted edits or return source-backed disagreement                | `glm-5.3`                           |
| Review       | Independently assess current source, diff and test evidence; no repository tools                    | `LLM_MODEL`                         |

Localization benefits from reliable search and tool calling; a smaller model can work within its bounded responsibilities. Planner benefits from stronger reasoning. Execute/Repair need reliable code editing and tool calling. Review needs independent reasoning about behavior. The host builds the static graph and manages permissions, revisions and budgets; models do not own these authoritative states.

For each stage, replace `STAGE` with `LOCALIZATION`, `PLANNER`, `EXECUTE`, `REPAIR` or `REVIEW`:

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

Blank stage fields inherit the corresponding global `LLM_*` setting (or the Run's provider/model when supplied). Stage overrides take precedence. A different provider or endpoint requires its own stage API key; the host refuses automatic credential forwarding between providers. Model identifiers, reasoning options and quota availability must be checked with your provider.

The supplied example uses Bailian's compatible endpoint for all stages, with one global credential. Localization disables thinking and reserves 4,096 output tokens; Planner reserves 8,192, Execute/Repair 8,192, Review 4,096. Output settings are counted in the same request preflight as input and recovery reserves. A reasoning-only truncated response is not treated as a completed decision.

Run limits remain independent: `DEVFLOW_MAX_STEPS`, `DEVFLOW_MAX_TOTAL_TOKENS`, `DEVFLOW_TIMEOUT_MS`, and Planner's `DEVFLOW_PLAN_AGENT_*` limits. The static context view is bounded separately from archived history. `DEVFLOW_CONTEXT_COMPRESSION_ENABLED` enables bounded optional summaries with source citations and static fallback. Credentials, permission state and revision authority are never delegated to summaries.
