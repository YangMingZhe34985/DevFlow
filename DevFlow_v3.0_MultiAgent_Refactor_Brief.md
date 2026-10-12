# DevFlow v3.0 多 Agent 协作架构重构任务书

> **用途：** 直接交给 Codex，要求其审计仓库当前源码、论证并选择可行架构、制定分阶段计划，随后实际实现、测试和报告结果。  
> **目标：** 将 DevFlow 从“以固定 Workflow 驱动多个 Agent 角色的工程系统”，升级为“在可信 Workflow 边界内具备动态委派、独立会话、Agent 间证据协作和自适应资源分配的多 Agent 软件工程系统”。  
> **重要前提：** `project-study-guide-v2.3.1.md` 等旧报告只用于了解设计背景。**以当前工作树实际代码和可复现测试为准**，不要直接假设 v2.3.1 就是当前状态。

## 一、角色与工作方式

你是一位资深 Agent 系统架构师、TypeScript/NestJS 工程师和软件工程评测研究者。你需要**先审计、再设计、再实现、再验证**，不能只生成规划文档就宣布任务结束。

1. 首先查看仓库当前分支、HEAD、未提交变更及项目脚本。保留现有工作成果；不得擅自 `reset --hard`、清空未提交修改、强推、删除关键实现或改写历史。
2. 调研现有代码、数据库模型、运行入口、测试与已有文档；将“已实现、部分实现、仅文档声明”逐一分开。
3. 至少比较两种可行的多 Agent 协作架构，评价复杂度、资源消耗、权限、恢复、与现有代码的兼容性，明确推荐方案。
4. 形成有任务依赖、文件范围、可执行验收和回退策略的实施计划，然后**按计划继续落地代码**；不要把“写出方案”当作最终交付。
5. 分阶段执行测试、修正真实缺陷、沉淀设计与实验记录。对无法完成的项目如实记录原因和残余风险，不得伪造测试通过或修复成绩。
6. 若发现对外发布、不可逆迁移、凭据暴露或大规模破坏性操作等风险，停止相应高风险动作并说明需要的批准；不应因此停止其他可安全推进的工作。

## 二、现有架构背景与重构动机

根据既有 v2.3.1 报告，生产路径大体为：Web/API → BullMQ/Worker → `ApprovalWorkflowRunExecutor` → Localization → Planner → PLAN Approval → Unified Coding Session → Final Validation → Independent Review → Diff/GitHub 交付；旁路有 Resource Budget Scheduler、PostgreSQL/Prisma、Artifact/Event、Docker Sandbox、Source Cache 与关系图。

**必须以源码复核上述描述。** 优先检查：

- `apps/worker/src/runs/approval-workflow-run-executor.ts`、`run.processor.ts`、`run-recovery.ts`；
- `apps/worker/src/localization/` 与 `apps/worker/src/runs/plan-agent.ts`、`plan-proposal.ts`；
- `apps/worker/src/runs/coding-session.ts`、`packages/agent/src/runtime.ts`、`coding-session.ts`、`state.ts`；
- `packages/tools/`、`packages/sandbox/`、`packages/workflow/`；
- `resource-budget-scheduler.ts`、`resource-budget-runtime.ts`、`context-projection.ts`；
- `packages/database/prisma/schema.prisma`、Prisma Adapter、Approval、Event、Artifact、GitHub Publisher 与 Eval 测试。

现有系统的**工程优势应当保留**：固定源码基线、严格 Tool Policy、Sandbox、人工审批、确定性验证、独立 Review、Lease/CAS、Checkpoint、资源账本和真实 Benchmark。重构重点是提高 Agent **自主分工与协作决策能力**，不是废弃 Workflow，也不是把所有安全上限改为无限。

## 三、v3.0 目标与非目标

### 必达目标

1. **动态委派：** Coordinator/Team Lead 能根据 Issue、仓库证据和最新反馈决定是否需要新建调查子任务、分配给哪个 Agent、是否继续或停止某个方向；不要求每个 Run 固定启动全部角色。
2. **独立 Agent Session：** 子 Agent 拥有独立身份、任务、模型上下文、Tool 能力、预算归属和恢复状态；不只是一次附加角色 Prompt。
3. **真实协作：** 至少支持 Agent 间请求补证、回复证据、提出反证或挑战、报告阻塞、上报任务结果。其他 Agent 的新证据必须能实质性改变某个 Agent 的后续行动。
4. **可信共享：** 通过任务板和共享 Evidence Store 交换带 SHA/版本/来源的证据；分清源码观察、模型解释和未证实假设。不广播所有 Agent 的完整聊天历史。
5. **自适应资源分配：** Coordinator 可以提出子任务和局部额度，宿主基于 Run 级硬预算、任务价值、必要下游路径执行 `quote/reserve/admit/settle`；禁止通过新建子 Agent、重试或恢复刷新预算。
6. **执行闭环：** 协作调查成果能进入 PlanProposal/Approval/Coding；Coding、Public Validation、Reviewer 可以反馈证据缺失或修改范围冲突，触发受控调查和合法 Replan。
7. **可恢复且可评测：** 支持并发子任务、消息去重、取消、Lease 过期、崩溃恢复、候选源码身份校验，并能与旧版做同预算对照实验。

### 不作为首版强制目标

- 不强制多个 Coding Agent 并行改同一个工作树；优先采用**并行只读调查 + 单写者 Coding + 独立 Review**。
- 不要求所有角色使用不同模型或进程；Agent 身份与 Worker 进程、模型供应商必须解耦。
- 不为了“多 Agent”直接替换 BullMQ、Prisma、Docker、现有 Agent Runtime 或引入另一套重复的 Workflow 状态机。
- 不把多 Agent 数量、模型调用次数或对话次数当作修复质量指标。
- 不要求同时实现大型 PRG/Repository Atlas 重构；现有 Localization 与关系图先作为 Investigator 的可复用工具，新的检索算法应作为独立实验变量。

## 四、待调研并设计的关键架构

### 4.1 Coordinator 与 Task Board

设计一个**有界决策循环**：观察原始 Task、候选、证据、任务板和剩余资源 → 选择 `delegate / request_evidence / challenge / revise_plan / propose_plan / stop` 等行动 → 宿主校验权限与预算 → 派发子任务 → 收集结果、修订假设与任务依赖。

Task Board 应至少表达任务身份、父子依赖、调查目标、允许的工具权限、共享证据引用、状态、预算归属、结果与取消原因。子任务应支持重复派发识别和有界并发，避免互相等待的死锁或无意义群聊。

### 4.2 Agent 实例与消息协议

提出并验证最小数据契约（字段与存储方式应由源码调研确定）：

- `AgentInstance`：`agentId/runId/role/sessionId/taskId/status/toolPolicy/budgetIdentity/checkpointIdentity`；
- `AgentTask`：`taskId/parentTaskId/goal/dependencies/evidenceRefs/status/operationIdentity`；
- `AgentMessage`：`messageId/from/to/type/taskId/evidenceRefs/replyTo/idempotencyKey`；
- `EvidenceRef`：仓库视图、路径、行范围、完整 SHA、观察/解释/假设的类别及来源。

至少支持 `REQUEST_EVIDENCE`、`EVIDENCE_RESULT`、`CHALLENGE`、`BLOCKER`、`TASK_RESULT`、`SCOPE_CHANGE_REQUEST`。消息由宿主认证发送者并检查权限；消息内容和仓库文件都视为不可信输入，不能变成系统指令。

### 4.3 专家 Agent 与交互策略

第一版建议提供：

- **Coordinator**：动态拆分、委派、聚合证据、提出方案，不授予写权限或验证权；
- **Investigator**：按任务使用现有索引/关系图、搜索与只读源码工具，提出候选和反证；允许按不同调查假设同时启动多个实例；
- **Reproduction Specialist（可选）**：设计可公开执行的区分性测试/复现建议，真正执行仍受可信宿主控制；
- **Coding Agent**：沿用 Unified Coding Session，在获批写入范围内修改并接收反馈；
- **Independent Reviewer**：独立判断，不因其他 Agent 达成共识而自动 PASS。

比较 **Manager-as-tools 的轻量子 Agent 方案**与**持久化任务/消息驱动的团队方案**，必要时采用渐进混合方案。以最小改造获得真实协作能力为优先，不预设必须引入某个外部框架。

### 4.4 权威边界与候选工作区

- 原始 Issue 是任务依据；模型生成的假设、Plan 或消息不能变成新的安全权限。
- PLAN、范围扩展与 GitHub 发布仍需原有 Approval；Reviewer 不得自批。
- 不让多个 Agent 同时写同一可变 Sandbox；只读调查可在固定快照或带身份的候选视图上并行，不能混用不同源码版本。
- Tool 白名单必须在实际 Executor 调用边界执行校验，而非仅在模型可见 Schema 层筛选。
- 多 Agent 的全部调用和内部 IO 必须统一计入原 Run 账本，未知消费不能记作零；不可因重新规划或恢复延长期限。
- Worker 失去 Lease、消息重复、子 Agent 取消及进程崩溃时，不得留下可以继续提交权威结果的陈旧执行者。

### 4.5 Context 与可观测性

复用 `ContextEvidenceStore`、CurrentSourceCache、关系图、Context Projection 及既有 Artifact/Event。独立 Agent 只接收必要任务和相关证据，支持有权限且计预算的证据恢复。持久化 Agent 创建、委派、通信、挑战、关键证据改变、预算预约/结算、提交、阻断、取消、恢复事件，形成可重放的协作轨迹。

## 五、实施顺序（要求实际完成，不只输出方案）

**Phase 0 — 审计和冻结基线**

- 输出源码现状、已有能力、未实现路径、风险/依赖与测试清单；保存当前 HEAD、脏工作树状态、模型/预算/数据集条件。
- 创建必要的重构设计文档，给出至少两种方案的取舍、迁移范围、兼容和回退方案。

**Phase 1 — 最小多 Agent 纵向闭环**

- 引入独立 Agent 身份、受控子任务/任务板和 Coordinator 入口；允许根据不同 Issue 动态选择 0/1/多个 Investigator。
- 最少支持两个只读调查子 Agent，拥有独立上下文，结果回传 Coordinator；保留旧单 Agent 路径作为可切换对照。
- 用 Fake Model 集成测试证明**模型输出能改变实际委派目标和执行次序**，而非固定流水线。

**Phase 2 — 持久协作与资源调度**

- 加入 Agent 消息及 Evidence 引用、挑战/补证、任务取消与依赖状态；支持新证据让另一 Agent 改变下一步调查动作。
- 接入 Run-wide Budget Scheduler，完成多子任务并发预约、幂等结算、重复消息处理、工具权限和上下文投影。

**Phase 3 — 融入生产修复链路**

- 将团队结论接入当前 Planner / Approval / Unified Coding / Final Validation / Review，不绕过现有安全边界。
- Coding、测试诊断或 Reviewer 可以发出证据/范围冲突请求；实际 Replan 必须由宿主核实，按原有审批与资源规则继续。
- 审批等待或 Sandbox 重建后，恢复候选 SHA、Agent Session、任务板与剩余额度；不重复执行未知外部动作。

**Phase 4 — 工程稳定性和对照评测**

- 完成单元、Fake Model、数据库/队列集成、Docker Sandbox、审批、取消/恢复和 E2E 回归。
- 比较：A）旧版/强单 Agent，B）固定多角色流水线，C）动态多 Agent。固定数据集、基线、模型、总预算、工具权限、候选验收标准和冷/热缓存条件。
- 逐项报告严格 Issue 修复率、定位召回、墙钟、Token、模型调用、逻辑工具与真实 IO、费用、协作增益及失败分类。不能以更多 Agent 次数或更早停机冒称效果提升。

每阶段先交付可运行的最小纵向闭环和测试，再推进下一阶段；若风险或复杂度明显超过预计，记录具体问题并调整阶段方案，而不是无限扩大重构范围。

## 六、必须验证的验收场景

1. 同一 Issue 在不同证据条件下，Coordinator 能选择不同的子任务和工具调查路径；不是把固定角色 Prompt 按序执行。
2. Investigator A 的新证据或 `CHALLENGE` 能让 Investigator B 或 Coordinator 修正原计划/假设；记录完整消息因果链。
3. 明确小任务不必强制产生多个 Agent；复杂任务允许两个只读调查子任务并行，不能重复申请同一额度。
4. 没有 PLAN Approval 时，所有调查结论均不能扩大 Coding 写入范围；Reviewer 或 Coordinator 不能伪造 Approval / PASS。
5. 过期 SHA、错误版本 Evidence、非法 Tool、提示注入、越权读取与写入被拒绝，不能通过 Agent 转发绕过 Policy。
6. 子 Agent 失败、消息重复、Worker 崩溃或取消后，任务不会重复扣费/执行或无限等待；恢复沿用同一 Run 预算、身份和截止时间。
7. Public Validation 的 FAIL/NOT_RUN/NOT_CONFIGURED、Review 的 PASS/FAIL/NEEDS_EVIDENCE 保留原有严格语义；模型声明不能代替验证结果。
8. 多个不同 Run 可以在资源允许下并行执行；同一个 Run 的陈旧 Worker 无法提交完成；共享索引或 Evidence 不得跨越仓库访问边界。
9. 旧模式通过功能开关可回退；现有 API、数据库、SSE、CLI 和 GitHub 发布路径中受影响的部分有针对性回归测试。
10. 如果真实 Issue 修复率没有提升，必须保留真实负结果和性能代价，不能把“多 Agent 架构已实现”写成“修复能力已经提高”。

## 七、工程约束与代码质量

- 遵守仓库现有 TypeScript、Zod、Prisma 和模块边界；避免重复实现数据库状态机、缓存、日志、预算系统。
- 如必须变更数据库 Schema，提供迁移、回退或兼容读取策略，并验证旧 Run/Artifact 的恢复语义。
- 不无理由引入 LangGraph、AutoGen 等新框架；若引入，必须证明与现有 Runtime 和持久化体系的增益及迁移成本。
- 控制运行时并发、任务数、模型调用、消息数、Token、时间和费用的硬上限；硬上限是可信执行约束，不应为“更自主”而取消。
- 优先通过可配置特性开关启用团队模式，避免直接破坏旧版；测试新旧模式的正确性。
- 对不可信仓库、Issue、Agent 消息和 Tool 输出做边界隔离；不得泄漏 `.env`、Provider Key、GitHub Token 或隐藏评测答案。
- 不因为某项单测失败就放弃其他相关验证；记录每项 PASS/FAIL/SKIPPED/NOT_RUN 和实际命令。
- 如开发过程中发现真实 Bug，可在任务边界内进行最小修复，但不要顺手重构无关模块。

## 八、最终交付要求

在仓库内按照既有文档结构保存（路径可根据实际仓库规范调整）：

- **架构审计报告**：当前源代码、缺口、调用链、风险、实际与文档不一致的地方。
- **v3.0 RFC 与实施计划**：对比方案、选择理由、模块接口、数据契约、状态转移、预算/权限、阶段任务和回退方案。
- **已提交到工作树的实现代码及测试**：不能只有 TODO、架构图或 Prompt；是否提交 Git commit 依当前仓库约定，不得改写或污染用户已有修改。
- **阶段性验收记录**：构建、类型检查、Lint、单元、集成、E2E 与中断恢复的真实结果。
- **对照实验与成本报告**：同基线、同资源条件下的单 Agent、固定流水线、动态团队结果；未运行的用 NOT_RUN 标识。
- **开发者使用说明**：如何启用/回退、多 Agent 事件如何查看、如何配置预算与模型、已知限制。

最终回复应依次汇报：① 完成的源码审计；② 采用的协作架构及理由；③ 实际落地文件与功能；④ 验证/实验结果；⑤ 尚未解决的风险与后续研究方向。**禁止仅以“我已经设计好方案”作为完成声明。**

---

**核心验收原则：** v3.0 不以“拥有几个 Agent 角色”为成功，而以**存在可复现的动态委派、独立状态、真实证据协作、合法的修改/验证闭环，以及在固定预算下可量化的任务效果**为成功。安全、正确性和资源约束仍由可信宿主保证。
