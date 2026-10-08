# Stage model configuration

Copy `.env.example` to `.env`, set the platform credential and restart the Worker after changes. `.env` is ignored by Git. DevFlow supports model capabilities rather than requiring a particular vendor.

| Stage        | Responsibility                                                                                      | Example default in `.env.example`   |
| ------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Localization | Read and search public source, identify candidates and build a bounded static relationship artifact | `LLM_MODEL` (`deepseek-v4.1-flash`) |
| Planner      | Propose a repair direction, intended files, verification and uncertainty                            | `deepseek-v4-pro-0813`              |
| Execute      | Confirm current code and implement the approved change                                              | `glm-5.3`                           |
| Repair       | Check test/review findings, make targeted edits or return source-backed disagreement                | `glm-5.3`                           |
| Review       | Independently assess current source, diff and test evidence; no repository tools                    | `deepseek-v4-pro-0813`              |

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

The supplied example uses Bailian's compatible endpoint for all stages, with one global credential. Localization disables thinking and reserves 4,096 output tokens; Planner reserves 8,192 and Execute 8,192. Review uses DeepSeek V4 Pro 0813 with thinking enabled and high reasoning effort. Review/Repair reserve 16,384 output tokens and allow 64,000 total context tokens. Output includes reasoning and the final answer; GLM-5.3 ignores `thinking_budget`. Output settings are counted in the same request preflight as input and recovery reserves. A reasoning-only truncated response is not treated as a completed decision. See [Bailian's compatible API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions).

Normal Review requests use these configured reasoning settings. Review-only semantic recovery after `LENGTH` keeps thinking enabled and uses `low`, a compact current evidence view and the same output cap. The stage wrapper preserves that request override; normal requests remain high. The supported DeepSeek V4 Pro 0813 efforts are low/high/max, with no medium setting. Only context-free format conversion uses `none`. Both recoveries share two persisted credits per workflow, at most one per decision. Repair's tool-calling recovery is separate. See [Bailian DeepSeek parameters](https://help.aliyun.com/zh/model-studio/deepseek-api) and [validation](validation-v2.md); historical no-thinking recovery measurements remain historical results.

Run limits remain independent: `DEVFLOW_MAX_STEPS`, `DEVFLOW_MAX_TOTAL_TOKENS`, `DEVFLOW_TIMEOUT_MS`, and Planner's `DEVFLOW_PLAN_AGENT_*` limits. The static context view is bounded separately from archived history. `DEVFLOW_CONTEXT_COMPRESSION_ENABLED` enables bounded optional summaries with source citations and static fallback. Credentials, permission state and revision authority are never delegated to summaries.

New tasks default to a 25-minute total workflow limit. Explicit task limits take precedence; changing configuration or resuming a task does not extend its saved absolute deadline. Review request deadlines and conservative time reserves are configured separately:

```dotenv
DEVFLOW_TIMEOUT_MS=1500000
DEVFLOW_REVIEW_REQUEST_TIMEOUT_MS=240000
DEVFLOW_REVIEW_RECOVERY_TIMEOUT_MS=210000
DEVFLOW_FINALIZE_TIMEOUT_MS=30000
```

Normal Review reserves its request, one still-available recovery and candidate finalization (480 seconds by default). Once both workflow recovery credits are consumed, it reserves 270 seconds. Execute/Repair close exploration before consuming this downstream reserve. Source supplements have a 120-second host deadline; probe operations reserve their actual deadline plus the subsequent judgment. These are deadlines, not guarantees of model completion. Insufficient time prevents dispatch and records the shortfall; a request timeout leaves Review incomplete. A separate bounded finalization signal saves the candidate and pending findings after cancellation. Unconfirmed request costs remain reserved at their upper bound.

### Localization request budget

The host derives the Localization lease from current serialized task/evidence, configured stage outputs and downstream planning/execution/Repair/Review reservations. Unknown envelope/evidence growth is an explicit estimate, rechecked at each boundary. The input plus configured output must fit both the stage balance and configured context window. Insufficient capacity stops before dispatch; the host does not lower the output ceiling to make a request fit. Up to four Localization requests, including recovery, share the lease. Consumption journals survive task interruption; uncertain interrupted state is blocked rather than restarted with fresh allowance.

Localization 的纯说明字段不设细碎字符门槛；整份序列化输出最大字节为配置输出 token 的八倍（大小保护，非精确 token 换算），实际计费与 token 额度仍采用提供方使用记录。配置输出上限保持原值。格式修复处理 JSON/结构错误，完整长说明无需额外无损转换；LENGTH 回复即使可解析也不能作为完整决策。
