# DevFlow P6–P9 Development

## Goal

在 P1–P5 稳定通过的基础上完成 P6–P9：UI / SSE / Approval / Repair Loop，形成可交互的完整 Agent 工作流。

## Tasks

* 实现基础 Web UI，优先完成 **Run Detail**：状态、步骤、工具调用、事件、指标、diff、approval 等；暂不进行无关视觉包装。
* 基于持久化 Event 实现 SSE 实时推送，支持断线重连、按 sequence 重放，避免事件丢失或重复。
* 实现 Approval Workflow：Agent 先生成计划并进入等待状态；批准后继续执行，拒绝后根据反馈重新规划。
* 实现 test → repair loop：测试失败后允许 Agent 分析并修复，受最大修复次数限制。
* Repair 完成后执行独立 review，review 与实现/修复流程保持职责分离。
* 复用现有 API / Queue / Worker / Runtime / Sandbox / Persistence，不建立平行执行链路。

## Acceptance

增加 P6–P9 自动化及集成测试，并提供手工验收指南，至少验证：

* UI 可创建/查看 Run，并正确展示完整执行过程与最终结果。
* SSE 实时事件、断线重连和历史 replay 正确，无丢失/重复。
* Run 必须经过 `PLAN → WAITING_APPROVAL → APPROVED → EXECUTION`；未批准不得执行代码。
* Reject 后能够重新规划，并再次进入审批。
* 测试失败触发 repair loop；成功后退出，超过最大次数正确失败。
* 独立 review 能产生并持久化 review 结果。
* 浏览器端完成一次真实 **Task → Plan → Approval → Execute → Test/Repair → Review → Result** E2E 验收。
* P1–P9 全部测试通过，且无数据库、Queue、Worker、Sandbox 生命周期回归。

完成后生成简洁的 **P6–P9 手工验收指南**，重点描述浏览器端 E2E 验收流程与预期结果。
