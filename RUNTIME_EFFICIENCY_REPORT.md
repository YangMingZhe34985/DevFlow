# DevFlow Agent Runtime / Workflow 效率重构交付报告

> 状态说明：本文记录当前工作区中的实现与验收口径。本文不伪造真实模型性能数据；在完成同环境的 before baseline 与 after candidate 采样前，所有性能数值均保持为空。尤其不能把 Fake Model、单元测试或类型检查结果替代 `qwen3.8-flash` 的 live benchmark。

## 1. 结论

本次重构保留了现有 Worker、BullMQ、Prisma、SSE、Approval、Sandbox、GitHub、Repair、Review 与 Benchmark 主链路，没有引入 LangGraph，也没有通过跳过 Test 或 Review 来制造性能改善。核心变化是把原先“多个阶段重复启动同一种通用 Agent”的执行方式，收敛为：

1. 明确的 PLAN、EXECUTE、TEST、REPAIR、REVIEW 阶段职责；
2. EXECUTE 与所有 REPAIR 共用的 Run 级步骤预算，以及模型调用、工具调用、Token 和绝对截止时间预算；
3. stage-local、硬上限的模型上下文，而不是重放完整历史；
4. 原生结构化输出、一次轻量 format repair 和 fail-closed 错误；
5. 带 workspace revision 的只读工具缓存、批量工具和有限并发；
6. 可持久化的阶段指标、失败指标和可复现效率基准报告。

这次改动首先解决的是调用失控、上下文膨胀、阶段职责重叠，以及 Review 失败信息丢失问题。实际是否达到“简单单文件场景四项中位数均不高于 baseline 的 50%”仍须由同一环境中的 live before/after 报告证明。

## 2. 根因

### 2.1 `maxSteps` 被按阶段重复使用

旧流程在 IMPLEMENTATION、TEST_REPAIR 和 REVIEW_REPAIR 中分别给 Agent 一份新的 `maxSteps`。以默认值计算，一次 Run 理论上可能累计到约 125 个 Agent step；模型层重试继续放大后，请求量可能达到约 375 次。`maxSteps` 因而不是 Run 级硬上限，无法阻止简单任务在多个修复回路中持续消耗。

### 2.2 `purpose` 没有形成真正的阶段策略

旧 Execute 与两类 Repair 共用相近 Prompt、完整工具集和历史上下文。Execute 可以自行运行测试，而 Workflow 随后还会执行确定性测试，造成重复验证；Repair 也可能重新浏览全仓库，而不是围绕当前失败证据做定向修复。

### 2.3 每轮重发完整历史与大体积工具结果

历史消息、文件内容、命令输出和 Diff 会不断进入下一轮请求。大文件或命令输出可达到 MB 级，既增加 Token 与延迟，也让模型更难聚焦最新证据。旧实现没有 workspace-aware 读取缓存、上下文投影或稳定的重复调用检测。

### 2.4 Review 的“正常停止”被误判为泛化失败

失败 Run 的第二次 Review 可以以 `STOP` 正常结束，但文本并不一定满足 JSON 语法或 Zod schema。旧统一 `catch` 丢失了 `EMPTY_OUTPUT`、JSON 语法错误、schema issues、输出 hash 和已累计 metrics，难以区分模型传输格式问题与语义 Review 失败。

### 2.5 已有 provider 能力没有进入模型端口

Review 主要依赖 Prompt 中的伪 JSON 示例，而模型适配器没有暴露严格结构化输出能力。对支持 JSON Schema 的 `qwen3.8-flash` 而言，这等于放弃了 provider 原生约束；同时未按阶段调整 reasoning，也让 Plan/Review 的格式任务承担了不必要的 thinking 成本和兼容风险。

## 3. 修改前后流程

### 修改前

```text
PLAN
  -> 通用 IMPLEMENTATION Agent（独立 maxSteps，可自行测试）
  -> Workflow TEST
       -> 通用 TEST_REPAIR Agent（重新获得 maxSteps、完整工具和历史）
       -> TEST ...
  -> 文本 Review + 手工 JSON 解析
       -> 通用 REVIEW_REPAIR Agent（再次获得 maxSteps）
       -> TEST；失败时可能直接终止
  -> Diff / Result
```

主要问题是每进入一个 Agent 阶段就重置局部限制，且 Execute、Repair、Review 的输入与能力边界不清晰。

### 修改后

```text
PLAN（严格 schema，reasoning=none）
  -> Approval
  -> EXECUTE（按 complexity / estimatedSteps / 实时剩余量分配，reasoning=low）
       -> 只定位并做最小修改；不提供 runCommand
       -> 修改成功后可在同一响应调用 finishPhase
  -> TEST（Workflow 确定性执行；命令探测只做一次并缓存）
       -> 失败：REPAIR（按复杂度与剩余 repair cycles 动态分配，reasoning=medium）
       -> 再次进入同一 TEST -> REPAIR 路径
  -> REVIEW（无仓库工具，bounded evidence，严格 schema，reasoning=none）
       -> FAIL：REVIEW_REPAIR
       -> TEST；若失败，重新进入统一 TEST -> REPAIR，而非立即终止
       -> 再 REVIEW
  -> DIFF / RESULT
```

PLAN、EXECUTE、所有 REPAIR、REVIEW 的模型调用与指标都进入同一 Run 账本。TEST 不再由模型自由决定，而由 Workflow 执行。若无法识别测试命令，状态记录为 `SKIPPED`，允许进入 Review，但最终摘要必须明确说明自动测试未执行，不能伪装为 `PASSED`。

## 4. Prompt、调度与状态转换

阶段策略集中在 `apps/worker/src/runs/workflow-stage-policy.ts`：

- 公共安全约束与阶段 Prompt 分离；仓库内容、Task、测试输出和 Review findings 都被视为不可信数据，不能覆盖系统角色。
- IMPLEMENTATION 只负责定位和最小修改；TEST_REPAIR 只围绕当前失败证据；REVIEW_REPAIR 只修复独立 Review findings。
- IMPLEMENTATION 可使用定位、读写和 Git 证据工具；REPAIR 使用更窄的定向工具集。两者都不暴露通用 `runCommand`。
- REVIEW 不获得任何仓库工具，只接收经过边界控制的 Task、Plan、Test 和 Diff 证据。
- `finishPhase` 是控制动作：模型可在同一 tool-call batch 的最后声明阶段已完成，避免再消耗一轮模型调用来输出“完成”。它计入逻辑 `toolCalls`，但不是外部工具执行。
- 状态持久化可携带 `expectedStage`，Prisma 更新用 `status + expectedStage` 做 CAS，并继续经过现有 transition reducer 校验，降低并发/恢复时写入过期阶段的风险。
- CHECKPOINT 事件记录测试命令、attempt、预算快照、test fingerprint、diff fingerprint 和 progress fingerprint，便于恢复与审计。

## 5. Structured Output

### 5.1 模型端口

`ModelRequest` 新增：

- `output`: 名称、描述和 Zod schema；
- `settings.reasoningEffort`: 阶段级 reasoning 配置。

`ModelResponse` 新增结构化成功值或明确失败：

- `EMPTY_OUTPUT`；
- `INVALID_JSON`；
- `SCHEMA_MISMATCH`。

响应保留 usage、reasoning tokens、finish reason、latency、原始输出长度/hash，以及可用的 Zod issues。这样 `STOP` 不再自动等于“有效 Review”。

### 5.2 Provider 策略

- Vercel AI SDK 7 使用 `Output.object({ schema })`。
- `LLM_STRUCTURED_OUTPUT_MODE=auto` 时，已知支持的 Bailian Qwen 模型（包括当前 `qwen3.8-flash`）使用严格 JSON Schema；能力未确认的 OpenAI-compatible 模型使用 `json_object + Zod`。
- 可用 `json-schema` 或 `json-object` 显式覆盖自动判断。
- `LLM_REASONING_PROFILE=efficient` 时，Plan、Review 和 format repair 使用 `none`，Execute 使用 `low`，Repair 使用 `medium`；`provider-default` 不发送阶段覆盖值。
- Bailian 严格结构化请求关闭 thinking，避免结构化输出与 thinking 内容相互干扰。

### 5.3 Plan / Review 契约与一次格式修复

Review 传输 schema 固定为：

```text
verdict: PASS | FAIL
summary: string
issues: [{ severity: low | medium | high, message: string }]
```

所有字段必填，随后映射回现有 `approved / findings` Artifact，因此 API、历史 Event 与 Web 契约保持兼容。Plan 使用同一结构化 helper，避免另留一条脆弱的文本 JSON 路径。

解析不再剥离 code fence，也不再从任意文本中截取首尾花括号。首次非空输出出现语法或 schema 错误时，只允许一次 format repair：

- 输入仅包含原始输出（最多 32 KiB）与规范化校验错误；
- 不携带 Task、Plan、Test、Diff 或仓库上下文；
- 不重新做语义 Review；
- 不占用 `maxReviewRetries`，但计入模型调用、Token、延迟与 `formatRepairCalls`。

空输出直接失败；第二次格式仍失败时 fail closed，返回 `MODEL_OUTPUT_INVALID`，保留每次尝试的 finish reason、输出长度/hash、具体错误与累计 metrics，绝不默认 PASS。

## 6. Context、Tool 与收敛控制

### 6.1 Stage-local context

- 单次模型消息投影硬上限为 192 KiB；
- 单个 Tool 结果进入模型上下文时最多 32 KiB；
- 最多保留最近两个 action/result 组；
- Repair evidence 最多 160 KiB，只包含当前 Diff/摘要、changed files、失败命令结果和最多 8 个相关文件最新版；
- Review evidence 最多 176 KiB，不带工具；
- 小仓库可做有界预载，大仓库要求定向批读或搜索；
- Event 仍负责审计，Event payload 与下一次模型输入不再等同。

### 6.2 Tool 元数据、缓存与批处理

每个 Tool 可声明 `readOnly`、`parallelSafe`、`mutatesWorkspace`。只读缓存 key 为规范化的 `{tool,input,workspaceRevision}`；成功写入后 revision 递增并清空旧读取缓存。

新增或增强的工具包括：

- `batchReadFiles`：最多 12 个路径，每文件最多 64 KiB，总计最多 256 KiB，逐文件返回 hash、truncated 或 error；
- `batchSearchCode`：最多 8 个查询，每查询最多 30 条，总计最多 160 条/200 KiB；
- `gitDiffSummary`：只返回 changed-file list 和紧凑 diff 统计；
- 测试命令抽象：Sandbox 初始化后的第一次探测结果在该 Workflow 内缓存。

同一模型响应中的只读且 `parallelSafe` 调用最多并发 4 个，结果仍按原调用顺序回传。写操作保持串行；这里没有引入并行任务 DAG。

### 6.3 无进展检测

首次出现重复工具调用、无 Diff 变化或相同测试结果时，系统复用缓存并注入收敛警告，要求下一轮采用定向策略。连续第二次无进展时返回 `AGENT_STALLED`。Repair 还组合 Diff 与 Test fingerprint；连续相同进度不会继续耗尽全部重试配额。

## 7. Run 级预算

预算实现位于 `apps/worker/src/runs/workflow-budget.ts`。PLAN 在原有一次结构化输出中同时返回 `complexity`、`estimatedSteps` 与 `confidence`，不新增独立 estimator 模型调用。

`softLimit = min(hardLimit, estimatedSteps + adaptiveMargin)`，默认 margin 为 SIMPLE 4、MEDIUM 8、COMPLEX 15，并会根据低 confidence 适度放宽。`Run.maxSteps` 始终是全链路硬上限；PLAN、EXECUTE、REPAIR 与 REVIEW 的 step 共用同一计数器。

| 预算         | 默认值/规则                                                             |
| ------------ | ----------------------------------------------------------------------- |
| Agent steps  | `hardLimit = Run.maxSteps`，所有 Agent 阶段全局共用                     |
| EXECUTE 阶段 | 按 complexity、soft/active limit、剩余步数和 Repair/Review 预留动态分配 |
| REPAIR 阶段  | 按 complexity 期望修复轮次均分当前 repair pool，未用配额可重新分配      |
| Review 预留  | 保留 1 次正常 Review 与 1 次格式修复；有修复机会时额外硬保留 1 step     |
| Model calls  | `maxSteps + 2 * (maxReviewRetries + 2)`                                 |
| Tool calls   | `max(12, 3 * maxSteps)`                                                 |
| Total tokens | `250000`                                                                |
| Timeout      | 一个 Run 共用 `DEVFLOW_TIMEOUT_MS` 的绝对 deadline                      |

当 diff fingerprint 持续变化或定向探索有进展时，控制器可先回收未用软预留，再在 hard limit 内小幅扩展 active limit。重复 tool call、未变 diff 或相同测试失败不会获得无限扩展，并会分别收敛为 `ESTIMATED_BUDGET_EXCEEDED`、`MAX_STEPS_EXCEEDED` 或 `NO_PROGRESS`。

模型 provider 内部 retry 也进入调用账本。任一预算超限返回 `EXECUTION_BUDGET_EXCEEDED`，details 至少包含 `stage`、`budgetType`、`limit` 和 `observed`。

可配置项：

```dotenv
LLM_STRUCTURED_OUTPUT_MODE=auto
LLM_REASONING_PROFILE=efficient
DEVFLOW_MAX_MODEL_CALLS=
DEVFLOW_MAX_TOOL_CALLS=
DEVFLOW_MAX_TOTAL_TOKENS=250000
```

模型/工具预算留空时按每个 Run 的 `maxSteps` 推导；阶段不能通过重新进入 Repair 获得新的完整 timeout。

## 8. StageMetrics 与持久化

`Run.metricsDetail` 以可选 JSON 字段持久化完整指标；失败路径也保存已产生的数据。兼容的顶层 metrics 继续存在，阶段指标按以下五类记录：

```text
PLAN | EXECUTE | TEST | REPAIR | REVIEW
```

每个 `StageMetrics` 包含：

| 字段                | 含义                                         |
| ------------------- | -------------------------------------------- |
| `steps`             | Agent step 数                                |
| `attempts`          | 阶段进入/尝试次数                            |
| `modelCalls`        | 模型尝试次数（包含相关 retry/format repair） |
| `toolCalls`         | 模型或 Workflow 发起的逻辑工具调用           |
| `toolExecutions`    | 实际执行次数；缓存命中与控制动作不重复计入   |
| `cacheHits`         | 工具上下文缓存命中数                         |
| `tokenUsage`        | input/output/total/reasoning tokens          |
| `reasoningTokens`   | 便于兼容查询的阶段 reasoning 汇总            |
| `modelLatencyMs`    | 模型耗时                                     |
| `toolLatencyMs`     | 工具耗时                                     |
| `wallLatencyMs`     | 阶段墙钟耗时                                 |
| `formatRepairCalls` | 结构化格式修复调用数                         |

兼容顶层 `steps`、`modelCalls`、`toolCalls`、`toolExecutions`、`cacheHits`、Token 与模型/工具 latency 均由阶段工作量汇总，不再在不同失败出口各自拼装。`control` 另记录 duplicate tool calls、context cache hits、structured output failures/repair attempts 和 stalled detections。

新增稳定错误码：

```text
MODEL_OUTPUT_INVALID
AGENT_STALLED
EXECUTION_BUDGET_EXCEEDED
```

## 9. 为什么没有采用 LangGraph.js

当前瓶颈不是“缺少图框架”，而是阶段职责不清、预算按阶段重置、上下文无限增长、工具重复和 Review 输出契约不严格。LangGraph 本身不会自动减少模型调用、Token 或工具执行。

引入 LangGraph 还会在现有 Prisma 状态、BullMQ 调度、SSE 事件、Approval gate、Sandbox 生命周期和 checkpoint 之外形成第二套状态/恢复语义，增加迁移与一致性成本。本次选择保留 Worker 编排器，只抽出纯阶段策略、预算账本、上下文投影、进度控制和 transition CAS；如果未来确实需要跨 Run 的复杂分支、人工节点编排或图级可视化，再以已有指标证明收益后评估图框架。

## 10. `benchmark:efficiency` 使用方式

### 10.1 前置条件

基准通过真实 DevFlow 队列执行，不是进程内 mock。运行前需要：

- PostgreSQL、Redis、API 与正常 Worker 已启动；
- benchmark 命令与 Worker 使用同一 `DATABASE_URL`、`REDIS_URL`、`RUN_QUEUE_NAME`；
- Sandbox 镜像已构建且可用；
- live 模型凭据、网络与模型配置可用；
- suite 至少包含 ID 为 `simple-single-file` 的案例，才能执行 50% 效率断言。

默认单并发、1 次 warm-up、5 次正式采样。每份报告保留全部 `rawSamples`，并对每个 case 计算 median/min/max。

### 10.2 记录 baseline

```text
npm run benchmark:efficiency -- \
  --suite <suite.json> \
  --profile <profile.json> \
  --pricing <pricing.json> \
  --record-baseline <before.json>
```

若还希望复制一份常规输出，可同时加 `--output <report.json>`。`--repeats <1-100>` 与 `--warmup <0-20>` 可覆盖默认采样次数。

### 10.3 运行 candidate、比较并作为门禁

```text
npm run benchmark:efficiency -- \
  --suite <suite.json> \
  --profile <profile.json> \
  --pricing <pricing.json> \
  --baseline <before.json> \
  --output <after.json> \
  --assert
```

`--assert` 只有在提供 `--baseline` 时合法。比较失败或 expected outcome 不完全匹配时，命令返回非零退出码。

### 10.4 可复现性与拒绝错误比较

报告记录：

- suite ID/version/digest；
- profile、pricing、model、runtime、tools digest；
- Git SHA、dirty 标记与 dirty digest；
- Prompt、runtime、tools 与 structured-output schema 版本；
- Sandbox image、case limits 与 digest；
- Node、OS、架构、OS release 与匿名 host digest；
- 每次原始样本。

比较前会拒绝 suite、profile、pricing、model、runtime、tools、Sandbox 或平台 provenance 不一致的报告，避免把不同模型、不同限额、不同机器或不同测试集合误当成代码优化。Git SHA 与 dirty digest 被记录用于审计；before/after 本来就可能来自不同代码状态，因此不要求二者相等。

自动断言包括：

1. candidate 的总体成功率和 expected-outcome match rate 不低于 baseline；
2. candidate 所有 expected outcomes 均匹配；
3. `simple-single-file` 的 `modelCalls`、`toolCalls`、`totalTokens`、`totalLatencyMs` 中位数分别不高于 baseline 的 50%。

## 11. Before / After 结果表

下表是交付格式，不是测试结果。只有 `<before.json>` 与 `<after.json>` 均由相同可比环境生成并通过 provenance 校验后，才可填入数值。

| 场景                   | 指标                                             | Before median | After median | After / Before |                门槛 | 结果   |
| ---------------------- | ------------------------------------------------ | ------------: | -----------: | -------------: | ------------------: | ------ |
| 单文件 `<200 LOC`      | modelCalls                                       |        待采样 |       待采样 |         待计算 |            `<= 50%` | 未验收 |
| 单文件 `<200 LOC`      | toolCalls                                        |        待采样 |       待采样 |         待计算 |            `<= 50%` | 未验收 |
| 单文件 `<200 LOC`      | totalTokens                                      |        待采样 |       待采样 |         待计算 |            `<= 50%` | 未验收 |
| 单文件 `<200 LOC`      | totalLatencyMs                                   |        待采样 |       待采样 |         待计算 |            `<= 50%` | 未验收 |
| 单文件 `<200 LOC`      | successRate                                      |        待采样 |       待采样 |         待计算 |        不下降且 5/5 | 未验收 |
| 小型多文件             | successRate / expected outcome                   |        待采样 |       待采样 |         待计算 |              不下降 | 未验收 |
| 一次失败后 Repair 成功 | repairAttempts / calls / tokens / latency        |        待采样 |       待采样 |         待计算 |        成功且不失控 | 未验收 |
| Review                 | schema-valid / reviewRetries / formatRepairCalls |        待采样 |       待采样 |         待计算 | live contract 10/10 | 未验收 |

建议同时从 after 报告或对应 Run 的 `metricsDetail` 摘录阶段分解：

| Stage   | attempts |  steps | modelCalls | toolCalls | executions | cacheHits | totalTokens | reasoningTokens | model ms | tool ms | wall ms | format repair |
| ------- | -------: | -----: | ---------: | --------: | ---------: | --------: | ----------: | --------------: | -------: | ------: | ------: | ------------: |
| PLAN    |   待采样 | 待采样 |     待采样 |    待采样 |     待采样 |    待采样 |      待采样 |          待采样 |   待采样 |  待采样 |  待采样 |        待采样 |
| EXECUTE |   待采样 | 待采样 |     待采样 |    待采样 |     待采样 |    待采样 |      待采样 |          待采样 |   待采样 |  待采样 |  待采样 |        待采样 |
| TEST    |   待采样 | 待采样 |     待采样 |    待采样 |     待采样 |    待采样 |      待采样 |          待采样 |   待采样 |  待采样 |  待采样 |        待采样 |
| REPAIR  |   待采样 | 待采样 |     待采样 |    待采样 |     待采样 |    待采样 |      待采样 |          待采样 |   待采样 |  待采样 |  待采样 |        待采样 |
| REVIEW  |   待采样 | 待采样 |     待采样 |    待采样 |     待采样 |    待采样 |      待采样 |          待采样 |   待采样 |  待采样 |  待采样 |        待采样 |

## 12. 验收命令

2026-09-20 已按顺序执行并全部通过：

```text
npm run build
npm run test:p1
npm run test:p2
npm run test:p3
npm run test:p5
npm run test:p9
npm run test:p10
npm run test:p11
npm run test:e2e
```

补充执行的 `npm run lint`、`npm run typecheck` 与 `npm run test` 也全部通过；全量 Vitest 结果为 256 passed、15 skipped（需要独立条件的套件按现有配置跳过）。

除此之外，live 验收还应覆盖：

- `qwen3.8-flash` Review contract 连续 10 次，要求 10/10 schema-valid；
- malformed fixture 恰好只触发一次 format repair，修复请求不得含 Task/Plan/Test/Diff；
- 简单单文件场景 5/5 成功，实际执行 TEST 与 REVIEW，无 `MAX_STEPS`、JSON parse failure 或明显重复调用；
- before/after provenance 可比，且四项中位数门禁全部通过。

## 13. 尚未完成的 live 证据与剩余限制

### 尚未执行/不能回填的内容

- 当前没有可确认来自“重构前、同模型、同机器、同 suite/profile/pricing/Sandbox”的 `<before.json>`。由于工作区已经包含重构代码，不能把现在重新运行的结果冒充重构前 baseline，也不能根据理论调用上限反推实测中位数。
- 本报告生成时尚未执行需要真实 `qwen3.8-flash`、网络、数据库、Redis、运行中 API/Worker 和 Sandbox 镜像的 live baseline/candidate。因此第 11 节保持“待采样”。
- 单元测试与 Fake Model 可以证明调度、schema、预算和错误路径的确定性，但不能证明真实模型的成功率、Token 或延迟改善。

### 剩余边界

- `auto` 只能对已知 provider/model 开启严格 JSON Schema；未知 OpenAI-compatible 模型会降级为 `json_object + Zod`，其实际兼容性仍取决于 provider。
- 无法探测测试命令时仍可 Review，但结果只具备静态 Review 证据，最终摘要会显式标记 `SKIPPED`。
- 上下文限制依赖截断和最近证据选择；特别大的生成文件、二进制文件或跨 8 个以上相关文件的修复仍可能需要多轮定向读取。
- 只读并发上限为 4，写入仍严格串行；本次没有实现跨任务并行或图式编排。
- 工具缓存按 workspace revision 自动失效，可避免同一阶段内重复读取；它不是跨 Run 的持久化内容缓存。
- 性能门禁严格依赖可比 provenance。环境或 profile 改动后应重新建立 baseline，而不是绕过校验。

当前可以确认架构与可观测性重构已经落到代码契约中，且完整本地构建、集成与 E2E 验收通过；在补齐可信的 pre-refactor baseline 与 live candidate 前，仍不能确认“真实模型四项指标已下降 50%”。
