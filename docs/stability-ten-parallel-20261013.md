# 稳定性更新后的十题并发真实验收

## 冻结与执行协议

- 生产源码：`52886f992a8d5136f3dd870c752ebe10996a9edc`，包版本 **2.4.0**，分支 `codex/stability-autonomy`。
- Runtime digest：`17a3ea7162084af17a66ef0c69b40226f0e8840db328e56ffa22d7fda6b4cab7`。
- E01–E10 每题一次完整流程，从当前公开输入启动，没有注入历史 Plan、补丁或评分反馈；冻结期间未修改生产实现，也未重跑失败题。
- 三个真实 BullMQ Worker 并发，使用同一 PostgreSQL/Redis 服务，但每题独立数据库、队列和 Sandbox。该协议验证并发隔离，不冒充同一数据库多 Worker 竞争实验。
- PRG + `team` 模式。解题角色沿用百炼 `glm-5.3`、thinking/low、8192 输出、32000 上下文；Review 沿用 DeepSeek Pro high、16384 输出、64000 上下文。新增诊断保持默认关闭，不能据此宣称其真实模型效果已验证。
- 每 Run：320000 token、32 步、75 逻辑工具、25 分钟、最多 ¥4；容器 2 CPU、4 GiB、512 PID，禁止网络。Docker 总可用内存约 15.5 GiB，因此采用三 Worker，而非同时启动十个 4 GiB 容器。
- 用户明确授权累计上限 ¥210、本批新增最多 ¥40。预先拆成十份互不重叠的 ¥4 分配，历史未知占用继续保留。
- 十题预检全部 READY；逐题原始审计全部 PASS，140 次 HTTP 全部结算。审计 PASS 表示冻结、账本与验收记录一致，不代表修复成功。

## 结果

**严格通过 3/10：E02 TaskLite、E03 PreferenceCenter、E06 LogStream。**

| 案例                 | Plan / Coding   | 实际补丁 | 公开验证                 | 独立 Issue / 原测试 / 完整性 | Review  | 严格结果 |
| -------------------- | --------------- | -------: | ------------------------ | ---------------------------- | ------- | -------- |
| E01 MiniIndex        | 接收 / 进入     |    786 B | FAIL                     | PASS / FAIL / PASS           | NOT_RUN | FAIL     |
| E02 TaskLite         | 接收 / 进入     |   1412 B | PASS                     | PASS / PASS / PASS           | PASS    | **PASS** |
| E03 PreferenceCenter | 接收 / 进入     |   1657 B | PASS                     | PASS / PASS / PASS           | PASS    | **PASS** |
| E04 CatalogService   | 接收 / 进入     |      0 B | NOT_RUN                  | FAIL / FAIL / PASS           | NOT_RUN | FAIL     |
| E05 ConfigTree       | 接收 / 进入     |    821 B | 有 PASS 记录，收尾未完成 | PASS / PASS / PASS           | NOT_RUN | FAIL     |
| E06 LogStream        | 接收 / 进入     |   1125 B | PASS                     | PASS / PASS / PASS           | PASS    | **PASS** |
| E07 FormStudio       | 未接收 / 未进入 |      0 B | NOT_RUN                  | NOT_RUN / NOT_RUN / NOT_RUN  | NOT_RUN | FAIL     |
| E08 PyPlugin         | 未接收 / 未进入 |      0 B | NOT_RUN                  | NOT_RUN / NOT_RUN / NOT_RUN  | NOT_RUN | FAIL     |
| E09 AccessHub        | 未接收 / 未进入 |      0 B | NOT_RUN                  | NOT_RUN / NOT_RUN / NOT_RUN  | NOT_RUN | FAIL     |
| E10 FlowEngine       | 接收 / 进入     |    411 B | FAIL                     | FAIL / FAIL / PASS           | NOT_RUN | FAIL     |

汇总：Planner 接收 7/10、Coding 7/10、实际补丁 6/10、有公开验证 PASS 记录 4/10、独立补丁三项全通过 4/10、Review 批准 3/10、完整严格通过 3/10。E04 的空补丁评分失败表示基准未修复，不能归因于新增回归。E05 的独立补丁通过不能覆盖未完成的 Workflow/Review。

## 失败链与后续问题

| 案例 | 可核查原因                                                                                                                                                                             | 因果边界与优先方向                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| E01  | 已有补丁通过 Issue 验收，但原测试仍失败；有依据的范围扩展到 Replan 后，`PLANNER:request-and-continuation` 费用报价 ¥3.330120，剩 ¥2.542324，缺 ¥0.787796，实际 Replan 模型 HTTP 未发出 | 尚未完成修复，并受到 Planner 后续报价阻断。本次没有复现旧的最终 ownership 错误；不能据此宣布底层长等待问题永不发生                              |
| E04  | 首轮 Coding 两次读取未增加新证据；第二轮 `replaceText` 默认 EXACT 因 LF/CRLF 匹配数为零，源码未变化，随后两轮无进展直接停机                                                            | 明确有 `MATCH_FILE` 纠正提示，但未获得下一次纠正决策。需要审计可纠正文本匹配错误与无进展计数的衔接，不能自动改写原文或放宽 SHA                  |
| E05  | 合法补丁已有公开 build/typecheck/test PASS，独立三项 PASS；后续 `AUTHORIZATION_HANDOFF_UNRESOLVED: the finish-only decision requested another tool`，未进入 Review                     | 模型仍有调查缺口，但当前候选已可验收。优先审计读取拒绝、finish-only 控制提示、当前 diff 身份与明确提交的交接，不能将补丁成功伪装成严格成功      |
| E07  | 两个 Investigator 被实际委派；一名被预算阻断，另一名提交无效共享证据引用，`TEAM_EVIDENCE_REFERENCE_INVALID` 终止                                                                       | 本次未重现旧 taskId/replyTo 错误，也未使用该错误的纠正信用。应核实证据 ID 的展示、引用与可纠正边界，继续严格拒绝伪造来源                        |
| E08  | Investigator 在保护收尾容量的准入中被拒后为 BLOCKED；Coordinator 请求向它发送消息，`TEAM_MESSAGE_TARGET_UNAVAILABLE` 终止                                                              | 共享预留确实让 Coordinator 再次决策，但关闭接收者后的策略与错误反馈仍缺闭环。不能自动发送给别的 Agent 或恢复其资源                              |
| E09  | Planner 阶段自身输入预检允许，但全 Run 的请求及后续费用报价 ¥3.033876，剩 ¥2.971556，缺 ¥0.062320；没有 Planner HTTP                                                                   | 外层显示 `INSUFFICIENT_EVIDENCE`，底层实际上是资源阻断。Planner 的 continuation 仍以聚合 token 表示，需审计与 Coding 新计价路径的差异及错误映射 |
| E10  | 仅 `status-codec.ts` 形成部分补丁；收尾保存的未完成事项仍包括 serializer 与其余状态转换。下一阶段请求被下游预留边界阻断，公开和独立行为验收未通过                                      | 编辑未完成与资源调度共同影响结果。不能只因存在补丁认为结束，也不能删除必要 Validation/Review 预留制造成功；需按冻结状态复核具体预算边界         |

这些是本轮记录，不是修复实现。冻结实验期间没有扩大重构。E07 的引用错误、E08 的消息目标状态与 E04 的纠正停机也不能仅凭出现时间认定为本轮新代码引入；需要单独做提交间回放。

## 与上一批的有限对照

上一批九题源码为 `3eb17f3`，严格通过 E03/E04（2/9）。本批共有的九题严格通过 E02/E03/E06（3/9），另加 E10 失败；不能直接把 2/9 与 3/10 当作同批成功率提升。

- E02 从 Coding 费用准入阻断推进到严格 PASS；E06 从 Coordinator 阻断推进到严格 PASS。
- E03 保持成功；E04 本次失败，属于必须保留的负向结果，不能用历史 PASS 覆盖。
- E05 从空补丁阻断推进到独立补丁通过，但工作流仍未完成。
- E01 仍为 Issue PASS、原测试 FAIL；本次首要阻断为 Replan 费用，而非后续 ownership 覆盖原因。
- E07/E08 的错误位置变化，尚未构成真实通信闭环通过。

每题只有一次采样，模型输出存在随机性；没有同输入的 single/workflow/team 三模式对照，因此不能把上述变化单独归因于动态协作，也不能声称稳定成功率提高。

## 协作与安全门禁

本批**成功提交的 AgentMessage 为 0**，没有真实 SEND → REPLY/CHALLENGE → 接收者改变行为的完整证据链。确实运行了独立 Investigator 与 Coordinator 委派，但该结果不足以满足此前的真实通信发版门禁。

各题冻结审计、资源不变量与候选完整性记录一致；所有进行独立完整性验收的候选均 PASS。未接受审批外修改，没有通过删除测试或降低评分规则获得通过；评分器输出由宿主隔离，未回传模型。Review 三次均通过，其余未进入 Review，本批没有确认的 Review 误拒。

各题临时数据库已清理，队列和评分 Sandbox 清理由控制器记录；本批没有新增费用未知回执。实验版本仍为 2.4.0，不发布 v3.0。

## 资源与费用

| 指标                     |               数值 |
| ------------------------ | -----------------: |
| 实际模型 HTTP            |                140 |
| 已结算 token             |          1,266,034 |
| 逻辑工具                 |                278 |
| 内部执行                 |              3,058 |
| 宿主物理读取 / 写入      |        2,471 / 429 |
| IO 字节                  |         13,367,616 |
| 各 Run 步数合计          |                143 |
| 三 Worker 批次墙钟       |    18 分 49.760 秒 |
| 本批费用上界             |         ¥11.511171 |
| 累计保守占用             | ¥179.283309 / ¥210 |
| 本批新增未知费用         |                 ¥0 |
| 历史未知占用（继续保留） |          ¥3.171133 |

这些费用来自实际 usage 与冻结的保守费率，不是供应商最终发票。内部执行与宿主文件操作计量不等同于容器内全部磁盘 syscall；不把未观测 IO 当作零开销。

原始请求、响应、候选、账本及独立评分材料保存在 Git 忽略目录：`docs/performance/results/new-dataset-stability-ten-eXX-20261013/`。汇总、冻结身份、分配与新 carry proof 为 `.devflow/v3-experiments/stability-ten-20261013/`。公开报告只保存状态、指标及生产失败原因，不附隐藏评分原文。
