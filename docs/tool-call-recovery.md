# Coding Tool Call Recovery

包版本保持 **2.3.0**。本批只调整通用工具参数错误交接和 Coding 停滞控制，保持 Unified Coding Session、Context Projection Optimizer、Resource Budget Scheduler、模型配置、审批和 Sandbox。

## 校验与纠正

Tool Registry 的 Schema 仍为唯一参数契约。Tool Executor、Runtime 当前动态契约和 Worker 自定义关系查询复用 `toolInputValidationDetails`，保留旧 `fieldErrors`/`formErrors` 并提供：

- `failureOrigin=INPUT_VALIDATION`、`category=INVALID_ARGUMENT`；
- 完整字段路径、预期/实际类型以及当前参数 Schema；
- `recovery.kind=CORRECT_TOOL_ARGUMENTS` 和明确的 JSON 参数结构提示；
- `toolExecuted=false`，表示校验失败没有进入工具的业务操作。

例如 `queryRelations` 的 `paths` 必须是 JSON 数组，`symbols` 是独立的可选数组。字符串化数组和 XML 参数标记继续被拒绝。宿主不解析、替换或猜测模型参数；模型必须显式提交新的合法对象，再经过现有权限和资源检查。未知工具、旧 SHA、授权拒绝及探索额度耗尽不借此取得新权限。

Runtime 的宿主 callback 派发计数不等于 Sandbox IO；Worker 可以已进入自定义 callback，再在 Schema 校验处拒绝。逻辑调用仍计费计数，错误不得冒充源码读取或有效证据。

## 有界恢复与停滞

工具参数纠正复用 `executionRecovery` 的 `PROTOCOL_INVALID`、`pending`、`used`、原工具和参数记录，与已有编辑格式纠正、LENGTH 恢复共享 **一次**信用，不增加 Agent 或新的状态机。

可纠正错误仍增加无进展计数。当两轮边界遇到尚可用的纠正时，只暂缓停滞停止，保留计数并保存待纠正状态。下一次普通预算准入后的决策只提供失败工具和 `finishPhase`，同一决策最多执行一次该工具；有效的原始路径/证据身份仍需保留。其他读搜不重新开放。

合法纠正本身不是进展。只有新的有效源码范围、关系或候选变化才恢复正常探索；重复错误、合法但仍没有新证据的查询在原停滞边界停止。失败的 `finishPhase` 字段也不算进展。有效提交立即交给 Workflow，不追加确认调用。

待纠正状态、已用信用、无进展计数和历史通过原 Session/checkpoint 保存，请求前预占信用。恢复及重新审批不能重置它们。步骤、实际输入、配置输出、时间、工具和费用继续由现有 Scheduler/Run 预检；不足时保留原因及 `requestIssued=false`，不发送模型请求。信用不等于额外预算，也不能绕过新的 PLAN 审批。

参数纠正请求占用信用后，在整个决策结果提交前保留 `pending=true/used=true`。若该窗口中断，恢复输出 `TOOL_PROTOCOL_CORRECTION_INTERRUPTED`，不再次派发或重新开放普通工具；完整提交的纠正结果使用 `pending=false/used=true` 正常继续。没有新增检查点协议或恢复额度。

## 免费验收

回放使用上一轮 E02 保存的请求、SDK 解析后的响应、审批、图和 Coding checkpoint，从原 `noProgressStreak=1` 开始：

```text
原非法 queryRelations
  -> 字段级 Schema 错误（无源码 IO，streak=2，pending 持久化）
  -> 同一 SDK 请求链路中的显式数组纠正
  -> 真实 Worker 关系查询 / Docker 当前源码
  -> 新 SHA 关联实现证据
  -> 有界 finishPhase 交接
```

受控回放使用三次模拟 HTTP、零付费请求；参数错误前无物理源码读取，合法查询后一次物理读取。原历史、消费、批准范围保持连续。原历史期限已经过去，回放明确使用合成新期限并检查它不被 Runtime 延长，不宣称重现历史费用或真实修复成功。

保存的材料证明进入 Runtime 的 `paths` 已是错误字符串，`symbols` 未独立形成；该请求的 Schema 正确，Adapter 仅透传 SDK `call.input`。上一批没有保存原始 Provider 响应体，无法进一步断言错误由模型原文还是 SDK 解析产生。本批唯一真实实验单独保存宿主私有 wire 响应以便核对，不将其回灌模型。

回归覆盖字段类型/数量边界、重复非法输入、合法纠正后的真正进展与无进展、权限拒绝、同批多次纠正、共享 LENGTH 信用、预算不足以及 checkpoint 恢复。旧编辑错误连续失败测试仍验证只发两次请求；失败调用不能通过重置进展计数领取额外轮次。

冻结前工程验收：**997 项通过、31 项跳过**；lint、typecheck、格式、公开文件检查通过。新增 Runtime 恢复回归 16 项通过，工具包 29 项通过，最终源码的原请求 Worker/SDK/Docker 回放通过。

冻结后的唯一一次 E02 真实完整流程严格通过，见[真实验收与资源对账](tool-call-recovery-e02-live-20261009.md)。该次没有重现畸形参数；原错误纠正仍以免费回放和回归为证。回放本身不证明真实修复成功。原始请求、日志、账本、候选及私有评分材料继续排除在 Git 外。
