# autonomous 执行模式使用说明（v4）

`executionMode: "autonomous"` 由单个 Agent 使用通用工具自主求解 Issue；宿主负责隔离、计量、独立复验、持久化与交付审批。演进过程和评测结果见 [v4 进度](PROGRESS.md)。

## 启用

通过 API 创建 Run：

```json
POST /api/v1/runs
{ "taskId": "<task id>" }
```

Web 端创建 Run 时无需选择执行模式。

- 自 Phase 4 起，autonomous 是唯一的执行模式，`executionMode` 可省略；API 只接受 `"autonomous"`。
- workflow / team / single 模式已经退役。这些模式下的历史 Run 仍可读取，但 Worker 拒绝执行；它们已经批准的 GitHub 推送和 PR 仍可完成。
- 执行模式保存在 Run 的 metadata 里，因此不需要数据库迁移。

## 一次 Run 的流程

1. **准备**：创建租约受控的 Docker 沙箱。LOCAL 仓库使用创建 Run 时捕获的快照。
2. **选择检查配置**：自动发现公开检查（npm scripts、pytest 等）；只保护 `.git/` 和 `.github/workflows/`，允许 Agent 新增或修改测试。
3. **求解**：Agent 只有四个工具。

   | 工具        | 用途                       |
   | ----------- | -------------------------- |
   | `bash`      | 在沙箱内执行命令，带自限时 |
   | `read_file` | 按行号读取文件             |
   | `edit_file` | 精确替换文本或新建文件     |
   | `submit`    | 结束本次尝试               |

   Agent 自己决定如何探索、复现、修改和测试。

4. **验证、分层审查与修订**：每次 `submit` 后，宿主独立执行公开检查（build → typecheck → lint → test），并检查保护路径。通过后默认启动两层 Reviewer：
   - **第 1 层**：一次模型调用，无工具、无 Agent 循环，输入 Issue、求解总结、候选 diff、每项验证的类型/状态/退出码/末尾 1500 字符，以及改动上下文。宿主通过一次 `sandbox.exec` 读取每个 hunk 前后各 60 行，合并重叠/相邻区间并标注文件与行号；总量最多 40,000 UTF-8 字节，超限优先保留靠近改动的行并注明截断。结构化输出解析失败时原请求最多重试一次，再失败为 NEEDS_EVIDENCE。
   - 第 1 层 PASS 直接结束；FAIL 必须有 blocking finding，引用所给上下文中确实存在的文件/行号并描述错误行为，否则降为 CONCERNS。有效 FAIL 直接反馈修订。
   - **第 2 层**：只在 CONCERNS 时启动，仅核查最多三个具体疑点，携带已有上下文，提供 `bash`、`read_file`、`submit_review`，最多 8 轮。确认疑点判 FAIL，全部排除判 PASS，未解决判 NEEDS_EVIDENCE。参数错误返回工具错误供模型重试。宿主通过 git status、工作区/暂存区 diff 和文件摘要检查修改，发现修改就恢复审查前快照、丢弃结论。
   - 宿主验证失败，或 Review 存在有证据的 blocking finding：反馈回求解 Agent 的**同一会话**，共用 `DEVFLOW_AUTONOMOUS_MAX_REVISIONS` 计数；修订后重新验证和审查。
   - 建议不阻断；Reviewer 未提交、费用/轮数耗尽或改动工作区：`NEEDS_EVIDENCE`，不触发修订。
5. **自适应多尝试与选择**：仅在最终宿主验证失败或 Review 为 FAIL 时，检查剩余费用、轮数和绝对期限，最多追加到 `DEVFLOW_AUTONOMOUS_MAX_ATTEMPTS`。每次使用新沙箱、新会话，只接收上次的文件列表、未解决检查/审查问题和 Agent 总结。按“宿主通过且 Review PASS → 宿主通过且 NEEDS_EVIDENCE → 宿主通过 → 其余”排序；同级选择增删行数更少的候选，再平局选更早的尝试。
6. **交付**：只有所选候选生成 `changes.diff` 和最终验证 Artifact，进入 GitHub 推送 / PR 两级人工审批。
   - 宿主通过且 Review PASS：SUCCEEDED；Review 关闭时沿用宿主判定。
   - Review NEEDS_EVIDENCE：SUCCEEDED，summary 显著标注“未经独立审查确认”，交付仍需人工 diff 审批。
   - 宿主验证失败、最终 Review FAIL 或没有改动：FAILED，保留所选 diff 和各次轨迹。summary 写明选择的尝试序号和审查结论。

## 配置项

以下为 Worker 环境变量，示例见 `.env.example`。

| 变量                                         | 默认值   | 作用                                                                      |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `LLM_EXECUTE_*`                              | —        | 求解模型绑定                                                              |
| `LLM_REVIEW_*`                               | 现有配置 | 独立 Reviewer 模型，可与求解模型分别配置                                  |
| `DEVFLOW_TIMEOUT_MS`                         | 1500000  | 整个 Run 的绝对期限；恢复后不会重置                                       |
| `DEVFLOW_MAX_COST_MICROS`                    | 未设置   | Run 费用硬上限；设置时必须为该模型配置价格                                |
| `DEVFLOW_MODEL_PRICES_JSON`                  | 未设置   | 模型价格，可含 `cachedInputMicrosPerMillionTokens`（缓存命中价）          |
| `DEVFLOW_AUTONOMOUS_MAX_TURNS`               | 100      | 整个 Run 的轮数上限（所有尝试、Review、修订和恢复累计）                   |
| `DEVFLOW_AUTONOMOUS_CONTEXT_TOKENS`          | 100000   | 估算提示超过该值的 80% 时，较早的工具输出会被省略                         |
| `DEVFLOW_AUTONOMOUS_MAX_REVISIONS`           | 2        | 宿主验证失败后，最多回到同一会话修订的次数                                |
| `DEVFLOW_AUTONOMOUS_CHECKPOINT_TURNS`        | 5        | 每隔多少轮保存一次检查点（工作区 diff + 对话）                            |
| `DEVFLOW_AUTONOMOUS_REVIEW`                  | 1        | 1 开启独立审查；0 关闭                                                    |
| `DEVFLOW_AUTONOMOUS_REVIEW_TOOL_TURNS`       | 8        | 第 2 层轮数上限，范围 1–8；审查轮数独立于求解轮数，费用仍受审查上限约束   |
| `DEVFLOW_AUTONOMOUS_REVIEW_MAX_OUTPUT`       | 4096     | 两层审查的输出上限，覆盖 REVIEW 绑定                                      |
| `DEVFLOW_AUTONOMOUS_REVIEW_REASONING`        | medium   | 第 2 层（工具核查）的思考强度；模型不支持时降到最接近的较低档位           |
| `DEVFLOW_AUTONOMOUS_REVIEW_TRIAGE_REASONING` | none     | 第 1 层（单次结论）的思考强度，默认关闭思考；不支持 none 的模型降到最低档 |
| `DEVFLOW_AUTONOMOUS_REVIEW_RESERVE`          | 0.15     | Review 累计最多使用总费用上限的此比例；求解独享其余比例                   |
| `DEVFLOW_AUTONOMOUS_MAX_ATTEMPTS`            | 2        | 失败时可追加的尝试总数（含首次）；设为 1 禁用追加                         |

关于百炼计费：隐式缓存命中部分按输入单价的 20% 计费（[官方说明](https://help.aliyun.com/zh/model-studio/context-cache)）。配置价格时应同时填写缓存命中价，否则费用上限会按全价计算，比实际账单保守得多。

## 可观测性

### 事件（SSE 同步推送）

| 事件                  | 内容                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `RUN_STARTED`         | `mode: "autonomous"`；是否为恢复运行                                                                           |
| `LLM_REQUEST`         | 每轮发起前的最坏情况费用                                                                                       |
| `LLM_RESPONSE`        | Token 用量（含缓存命中）、费用、文本摘要、工具调用                                                             |
| `TOOL_RESULT`         | 工具名称、输入、`ok`、耗时、输出或错误                                                                         |
| `TEST_RESULT`         | 每次宿主验证的各项检查结果                                                                                     |
| `REVIEW_STARTED`      | 尝试序号、`at` ISO 时间戳、`tier`（1/2）和启动时累计用量                                                       |
| `REVIEW_RESULT`       | 同上时间/层级，verdict、findings、summary、每层 usage、stopReason；`review` 含 tier、concerns 数量、costMicros |
| `WORKFLOW_CHECKPOINT` | 每次尝试的 `{attempt, outcome}`；仍承载恢复/模型错误记录                                                       |
| `DIFF_GENERATED`      | 修改的文件列表，以及是否通过验证                                                                               |

### Artifact

| 名称                                   | 内容                                                      |
| -------------------------------------- | --------------------------------------------------------- |
| `changes.diff`                         | 最终补丁                                                  |
| `autonomous-transcript.json`           | 完整对话                                                  |
| `autonomous-transcript-attempt-N.json` | 每次完整对话、累计用量和候选结果，恢复时读取已结束尝试    |
| `autonomous-review-attempt-N.json`     | `REVIEW_REPORT`，每次审查结论与用量；同名可有多个修订版本 |
| `autonomous-verification.json`         | 最终一次宿主验证的结果                                    |
| `autonomous-checkpoint.json`           | 用于崩溃恢复的检查点                                      |

## 恢复与计费

- **中断恢复**：检查点保存尝试序号和已用修订次数。Worker 崩溃或失去租约后，在新沙箱中应用当前尝试的检查点 diff、续跑其会话；已结束尝试从各自 Artifact 读取，绝不重跑。提交后的检查点直接继续宿主验证；Review 中断时重新开展当前候选的审查，先前用量继续累计。检查点后的求解轮可能重做。
- **计费不会被重置**：花费从该 Run 自己的事件日志重算。已经发出但没有收到回执的请求按最坏情况计入，不记为零。
- **模型绑定校验**：求解和 Reviewer 的绑定均纳入检查点身份；恢复时配置变化会被拒绝。
- **费用切片**：Review 开启且配置 Run 费用上限时，求解累计最多使用 `cap × (1 - reserve)`，两层审查（含格式重试、修订后重审、后续尝试与恢复前花费）累计最多使用 `reviewCeiling = floor(cap × reserve)`，同时不超过 Run 剩余额度。求解额度检查从总账扣除审查已花费用，审查不会挤占修订额度。每次模型请求按输入估算加完整输出上限报价，无法容纳下一请求即 NEEDS_EVIDENCE，summary 为 `review budget exhausted`。已确认与未确认费用均计入。关闭审查时沿用完整 Run 预算。配置上限时两个模型均需提供价格；未配置上限时只有轮数和期限限制。
- **模型参数**：两层共用 REVIEW 模型及新的输出/思考覆盖值。GLM 5.3 仅支持 low/high/max，DeepSeek v4 支持 none/low/high/max；不支持的覆盖值（包括默认 medium）降到模型支持的最近一档。旧 `DEVFLOW_AUTONOMOUS_REVIEW_MAX_TURNS` 已由 `DEVFLOW_AUTONOMOUS_REVIEW_TOOL_TURNS` 替代。
- **结果口径**：runner 的轨迹在每层开始/结束记录 `at` 和 `tier`，结果 JSON 的 `review` 包含最终层级、疑点数和 Run 累计审查 `costMicros`（包含未确认费用）；各层事件的费用为该层本次用量。

## 已知限制

- bash 的只读约定由提示词和审查后的工作区校验保证；测试产生的 git ignored 构建/缓存文件不参与结论判定。快照包含这些文件，回滚时一并恢复。
- 分层审查尚未进行付费模型评测，Fake Model 只能证明链路行为，不能证明真实缺陷检出率或费用目标已达到。
- 15% 是比例封顶，不是固定 ¥0.2；例如 Run 上限 ¥4 时审查上限为 ¥0.6。首次审查的长输入未必命中缓存，15–30K Token 的单次费用也未必低于 ¥0.2。应根据后续受控评测配置 reserve 与 Run 上限。
- 测试覆盖：单元测试；Docker 集成测试（修订回路、检查点恢复）；PostgreSQL + RunProcessor 端到端测试。真实模型的门槛评测需要另行授权运行。
