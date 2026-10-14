# autonomous 执行模式使用说明（v4）

`executionMode: "autonomous"` 由单个 Agent 使用通用工具自主求解 Issue；宿主负责隔离、计量、独立复验、持久化与交付审批。设计依据见 [v4 方案](../../DevFlow_v4.0_Autonomous_Refactor_Plan.md)，同条件对照结果见 [Phase 0 A1 报告](phase0-A1-report.md)。

## 启用

通过 API 创建 Run 时指定执行模式：

```json
POST /api/v1/runs
{ "taskId": "<task id>", "executionMode": "autonomous" }
```

Web 端在创建 Run 的表单中选择 “Execution mode → autonomous”。

- 与 `team` / `single` 不同，`autonomous` 不需要 `DEVFLOW_TEAM_ENABLED`。
- 默认模式仍是 `workflow`。旧路径没有改动，可以随时切回。
- 执行模式保存在 Run 的 metadata 里，因此不需要数据库迁移。

## 一次 Run 的流程

1. **准备**：创建租约受控的 Docker 沙箱。LOCAL 仓库使用创建 Run 时捕获的快照。
2. **选择检查配置**：
   - benchmark Run 使用冻结配置中的公开检查 profile 和保护路径；
   - 普通 Run 自动发现公开检查（npm scripts、pytest 等），默认只保护 `.git/` 和 `.github/workflows/`，允许 Agent 新增或修改测试。
3. **求解**：Agent 只有四个工具。

   | 工具        | 用途                       |
   | ----------- | -------------------------- |
   | `bash`      | 在沙箱内执行命令，带自限时 |
   | `read_file` | 按行号读取文件             |
   | `edit_file` | 精确替换文本或新建文件     |
   | `submit`    | 结束本次尝试               |

   Agent 自己决定如何探索、复现、修改和测试。

4. **验证与修订**：每次 `submit` 后，宿主独立执行公开检查（build → typecheck → lint → test），并检查保护路径。失败时把检查输出作为反馈送回**同一会话**，最多修订 `DEVFLOW_AUTONOMOUS_MAX_REVISIONS` 次。
5. **交付**：
   - 验证通过：生成 `changes.diff`；GitHub 仓库进入既有的推送 / PR 两级人工审批，发布逻辑与 workflow 模式共用。
   - 验证未通过或没有产生改动：Run 记为 FAILED，但 diff 和完整轨迹都会保留。

## 配置项

以下为 Worker 环境变量，示例见 `.env.example`。

| 变量                                  | 默认值  | 作用                                                             |
| ------------------------------------- | ------- | ---------------------------------------------------------------- |
| `LLM_EXECUTE_*`                       | —       | 求解模型绑定（与 workflow 模式的 Coding 阶段共用）               |
| `DEVFLOW_TIMEOUT_MS`                  | 1500000 | 整个 Run 的绝对期限；恢复后不会重置                              |
| `DEVFLOW_MAX_COST_MICROS`             | 未设置  | Run 费用硬上限；设置时必须为该模型配置价格                       |
| `DEVFLOW_MODEL_PRICES_JSON`           | 未设置  | 模型价格，可含 `cachedInputMicrosPerMillionTokens`（缓存命中价） |
| `DEVFLOW_AUTONOMOUS_MAX_TURNS`        | 100     | 整段对话的轮数上限（含修订和恢复）                               |
| `DEVFLOW_AUTONOMOUS_CONTEXT_TOKENS`   | 100000  | 估算提示超过该值的 80% 时，较早的工具输出会被省略                |
| `DEVFLOW_AUTONOMOUS_MAX_REVISIONS`    | 2       | 宿主验证失败后，最多回到同一会话修订的次数                       |
| `DEVFLOW_AUTONOMOUS_CHECKPOINT_TURNS` | 5       | 每隔多少轮保存一次检查点（工作区 diff + 对话）                   |

关于百炼计费：隐式缓存命中部分按输入单价的 20% 计费（[官方说明](https://help.aliyun.com/zh/model-studio/context-cache)）。配置价格时应同时填写缓存命中价，否则费用上限会按全价计算，比实际账单保守得多。

## 可观测性

### 事件（SSE 同步推送）

| 事件             | 内容                                               |
| ---------------- | -------------------------------------------------- |
| `RUN_STARTED`    | `mode: "autonomous"`；是否为恢复运行               |
| `LLM_REQUEST`    | 每轮发起前的最坏情况费用                           |
| `LLM_RESPONSE`   | Token 用量（含缓存命中）、费用、文本摘要、工具调用 |
| `TOOL_RESULT`    | 工具名称、输入、`ok`、耗时、输出或错误             |
| `TEST_RESULT`    | 每次宿主验证的各项检查结果                         |
| `DIFF_GENERATED` | 修改的文件列表，以及是否通过验证                   |

### Artifact

| 名称                           | 内容                   |
| ------------------------------ | ---------------------- |
| `changes.diff`                 | 最终补丁               |
| `autonomous-transcript.json`   | 完整对话               |
| `autonomous-verification.json` | 最终一次宿主验证的结果 |
| `autonomous-checkpoint.json`   | 用于崩溃恢复的检查点   |

## 恢复与计费

- **中断恢复**：Worker 崩溃或失去租约后，队列会重新调度该 Run。执行器在新沙箱中应用检查点 diff，再从检查点处的对话继续。检查点之后的几轮会重做。
- **计费不会被重置**：花费从该 Run 自己的事件日志重算。已经发出但没有收到回执的请求按最坏情况计入，不记为零。
- **模型绑定校验**：如果求解模型的绑定发生了变化，恢复会被拒绝，避免同一次 Run 混用不同模型。

## 已知限制（Phase 1）

- 还没有独立 Review，计划在 Phase 2 加入带只读工具的 Reviewer。
- 每个 Run 只有一个求解尝试，Phase 2 才会加入多尝试与选择。
- Web 端的流程节点仍按 workflow 的十个阶段展示；autonomous Run 的过程以事件时间线和工具调用为准。
- 测试覆盖：单元测试；Docker 集成测试（修订回路、检查点恢复）；PostgreSQL + RunProcessor 端到端测试。真实模型的门槛评测需要另行授权运行。
