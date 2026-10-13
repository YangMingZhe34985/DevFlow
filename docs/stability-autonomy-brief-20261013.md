# DevFlow 下一轮大更新任务书：稳定性修复与 Agent 自主决策升级

> **使用方法：** 将本文件交给 Codex，并明确要求审计当前仓库、保存计划、按阶段实际改代码和验证。  
> **基线：** 用户提供的 2026-10-13 E01–E09 三 Worker 真实验收报告；当时冻结版本 `3eb17f3c71207135be62b72432d3e8478d312f33`（版本标记 2.4.0，分支 `codex/v3-multi-agent`），生产 Runtime digest `035a783855890c2fca67f4f55b1fd9413d0a747b24500ed1f0a2ca5ae8feb05a`。  
> **重要：** 这些是报告的历史证据，不保证等于当前工作树。开发时以最新仓库代码、实际状态及可复现测试为准。新实验必须固定并记录新 runtime/数据/配置，不得把不同版本直接横向混算。  
> **升级原则：** **Agent 决定采用什么解决策略；可信 Workflow 负责权限、预算、源码身份、最终验证和交付。** 不能以放宽安全限制代替自主性。

## 一、任务目标与工程底线

本轮仅有两条主线：

**A. 稳定性与真实成功路径（先完成）**：修复 E01–E09 中已经暴露的预算准入、消息错误恢复、Worker/Sandbox 所有权与高 IO，以及有实质补丁但回归失败等问题；提高合法 Run 到达首补丁、最终验证和 Review 的可达性。

**B. Agent 自主性（在稳定底座上实现）**：让 Coordinator / Investigator / Coding 根据新证据，自主决定是否委派、是否进一步补证、是否发起受限诊断、何时停止探索、是否请求重新规划、何时提交候选。允许动态协作和消息修正，不把每一轮业务行动硬编码成固定序列。最终验收、写入审批、工具授权、资源硬上限和可恢复性仍由宿主掌握。

**不追求**：无限工具调用；删除下游验证 reserve；Agent 自己决定跳过最终测试和独立 Review；无审批扩大 EDIT 范围；多个 Coding Agent 无隔离地同时改同一工作树；一口气重写现有 BullMQ/Prisma/Sandbox/Runtime；只通过增加 Agent 数量来“证明”协作。

## 二、问题基线和因果边界（不得粉饰）

九题同批：严格通过 **2/9（E03、E04）**；Planner 接收 6/9、Coding 6/9、形成实际补丁 3/9、正式验证通过 2/9。共 104 次已结算 HTTP、861,618 tokens、193 次逻辑工具、2,902 次内部执行、2,407 次物理读、406 次物理写。本批 **没有成功提交的 AgentMessage**，不能宣称 Agent 间反证改变他人行动已被真实证明；三 Worker 并发隔离实验也不等同于共享同一个数据库/队列的生产并发证明。

| 编号 | 已知观测                                                     | 必须核实的问题                                               | 不允许的捷径                                   |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------- |
| P-01 | E06/E08 Coordinator 决策准入被拒：分别缺 2964/5139 tokens 和 ¥0.117043/¥0.131621 | 真实序列化请求、共享下游预约、累积 Evidence Projection、顺序/互斥分支核算、请求与 continuation 是否重复报价 | 删除必要 reserve、抬高配额掩盖问题             |
| P-02 | E02/E05/E09 在 PLAN 后的 Coding `EXECUTE:request-and-continuation` 阻断，费用缺口 ¥0.185944/¥0.308752/¥0.176608 | 后续 Coding Path 的预留是否按最小可信必要路径计算；缓存、动态输入、互斥路径和报价身份是否正确 | 把已拒绝请求伪称模型失败或修改模型限额换结果   |
| P-03 | E07 `TEAM_REPLY_ID_INVALID`：模型把 taskId 填到 replyTo，消息未提交 | Tool Schema 描述、引用校验返回、合法的有界参数纠正、实际回复因果链 | 宿主偷偷把 taskId 改写为 messageId             |
| P-04 | E01 Replan/第二次审批后，约 13 分 29 秒无新 LLM/Tool 回执，最终 `SANDBOX_LOST_OWNERSHIP`；该题 675 次物理读、718 次内部执行 | 阶段耗时、Snapshot/Graph/IO/恢复准备/DB/Lease 续租、dispatchRevision=2 的 owner 与容器身份 | 在未测量情况下断言根因是模型慢、缓存差或多写者 |
| P-05 | E01 实际修改：独立 Issue PASS，但原测试 FAIL，Review 未运行  | 公开失败的具体回归、Replan 前后补丁语义、Coding 能否处理真实修复反馈 | 用 Issue PASS 冒充严格 PASS                    |

E02/E05/E09 的空补丁评分拒收不是“修改引入回归”的证据；E06/E08 未生成 Planner 最终提案不证明 Localization 错误；E04 `EXACT` 因 LF/CRLF 不匹配后改用 `MATCH_FILE` 最终成功，是现有纠正链正常案例，应保留回归测试。

## 三、阶段实施顺序

### Phase 0 — 保护基线、审计和仪表化

1. 首先检查分支、HEAD、脏工作树、数据库迁移和执行开关；不得 reset-hard、强推或覆盖用户已有修改。另建可回退开发分支，保持 E01–E09 原始报告与冻结输入不变。
2. 找到确切的 `Coordinator → Budget → Planner → Coding → Test → Review` 生产调用路径、Agent 通信工具校验、Lease/RunRecovery、CodingSession/Checkpoint/上下文 Projection、PRG/SourceCache 的实际实现。
3. 使用现有忽略目录中的原始 trace 与账本核对上述观测；若原产物不可访问，应标注“未能验证”，不补造细节。
4. 为每次请求/操作增加有界、非敏感诊断：请求指纹与估算/实际 Token、quote 各分支与 reserve ID、拒绝时缺口；阶段/工具/内部 IO span；续租/claim/容器恢复事件；AgentMessage validation 原因和 correction 轨迹。避免日志写入凭据、隐藏评分答案或无界源码。
5. 优先构造确定性 Fake Model / Mock Scheduler 复现，不直接先做高费用 live 采样。

**交付**：审计说明、失败因果假设、可复现的针对性测试、可回退的实施计划。

### Phase 1 — 先修 Scheduler（P-01/P-02，首要门禁）

- 审计 `quote → reserve → admit → settle`：按实际待派发操作核算成本；排查 `request-and-continuation` 是否将真正互斥或条件性操作累加为必需成本；同一操作不能重复预约；下游 Build/Typecheck/Lint/Test/Review 的**真实必要路径**仍保留。
- 清晰区分每项操作的 REQUIRED/OPTIONAL、SEQUENCE/EXCLUSIVE、已完成/已缓存/待执行和未知回执。不因本轮模型需要较少而假设后续修复免费，也不把可能发生的最坏分支统一计为必需。
- 对费用 ¥4、Run 320K Token、32 步、75 逻辑工具、25 分钟的旧边界做相同配置的测试；预算不足时仍 fail closed，并产出可解释的 quote breakdown 与 `requestIssued=false`。
- 检查三 Worker 额度预留不能超售，未知 Provider 账单不能“重试清零”。

**验收**：E02/E05/E09 和 E06/E08 的冻结失败请求均得到可追溯结论——若现实必要资源足够，就能派发；若不足，证明不足来自哪个必需节点，且拒绝不扣假账。不能通过直接增配额或删除验证解决。

### Phase 2 — Agent 通信可纠正与真实消息协作（P-03）

- `replyTo` 的 Schema 与模型可见说明明确表示其为 **messageId**，`taskId` 独立；非法 ID 保持严格拒绝。
- 返回字段级错误（字段、期望 ID 类型、实际引用、可用合法结构），使用原有一次有界纠正信用引导 Agent 显式重试；防止自动替换、无限重试、相同坏参数无进展。
- 保证 Message ID、sender、receiver、task、replyTo、证据引用和 idempotency，恢复/重投不会二次发送或二次计费。
- 构造含 Investigator A 发证据、B 收消息后改变下一步 Tool 查询，Coordinator 得知结果并调整下一任务的真实跨 Agent 闭环；不仅测试“创建了两个 Investigator”。

**验收**：重放 E07 类错误能够有界纠正并落盘一条有效消息，且相应接收 Agent 的决策因消息发生可验证变化；同时覆盖错误引用、重复投递、过期消息、无权限发送等负例。

### Phase 3 — 所有权、恢复与 IO（P-04）

- 对 E01 的 13:29 静默区间做分段真实耗时审计：Checkpoint/SourceCache/PRG/Snapshot/Container prepare、Repo IO、DB CAS/连接、Lease heartbeat/事件循环阻塞。禁止把单个 span 的 inclusive 耗时相加当墙钟。
- 确认审批后 dispatchRevision=2 的 owner、lease、sandbox identity、segment 与 session checkpoint 语义；长 CPU/IO 操作不能使续租永久无法执行，也不能允许 stale owner 修改新容器。
- 对 675 次读和 718 次内部执行按原因分类：缓存未命中、重复调查、关系图扩展、Workspace 恢复、测试诊断；仅在明确重复源头后做增量缓存或批量处理。
- 恢复不得自动重复可能已经发生的副作用；丢失 ownership 时 fail closed 并可审计。

**验收**：具备含延迟/断连/恢复/审批的集成回归测试，owner 失效后旧执行者不能提交；正常续租不会因已定位的宿主阻塞意外丢失；若尚不能恢复 E01，必须定位并记录具体 root cause 和残余风险。

### Phase 4 — Coding 修复与回归完整性（P-05）

- 分析 E01 真正的测试失败与候选 Diff，明确是行为破坏、未完成改动还是错误恢复。
- 保留 `Issue acceptance + original regression + integrity + required Workflow validation + Review` 的严格通过要求；将真实失败证据反馈原 Coding Session，必要时提出合法 Replan。
- 不能通过屏蔽原测试、修改评分器或使用隐藏答案提高 PASS。

**验收**：复现并解释 E01 的可观察失败；新增最小回归测试和可信修复（若发生在平台代码）；如属于该 Issue 候选质量，改进 Coding/反馈算法并以同基线评测验证，不可为 E01 特判历史补丁。

### Phase 5 — 扩展 Agent 策略自主性（在稳定底座上开展）

**核心设计：Decision Proposal 与 Trusted Execution 分离。** 在现有 Coordinator、Investigator、Coding Session 中接入统一或兼容的受控动作：

- `DELEGATE_INVESTIGATION`：是否新建、取消或继续一个调查 Agent（可以是 0/1/N，N 受并发硬上限控制）。
- `REQUEST_EVIDENCE` / `SEND_MESSAGE` / `CHALLENGE`：补读、查询关系、交换证据与反证。
- `RUN_DIAGNOSTIC`：主动要求执行已有公开且受限的诊断/局部测试，**不取代最终必跑的 Workflow Validation**。命令/路径/网络/资源由 Sandbox Policy 和可信测试接口审核。
- `PROPOSE_PLAN` / `REQUEST_REPLAN`：需要更多目标时提出有证据支持的范围修订；写入继续受人工审批。
- `CONTINUE_CODING` / `SUBMIT_CANDIDATE` / `STOP_INVESTIGATION`：模型根据观察选择，宿主检查 Diff、授权、候选身份和预算，再确定是否进入强制验证与独立 Review。

使协作策略不再仅为固定阶段切换：Coding 发现关键证据缺口时可请求 Investigator 协助；Reviewer 给出 NEEDS_EVIDENCE 时可触发有界补证；Coding 可以在正式交接前申请局部诊断；Coordinator 根据新增证据调整任务板。可选步骤由 Agent 自主选择，必须阶段及安全门禁仍由宿主执行。

- **Agent 可以提议预算追加**，不得增加原 Run 硬上限；Scheduler 在证据确有进展、当前请求与下游必须工作可负担时分配有限额度。停止条件结合真实无进展、重复操作、未知账单和总时间，不能仅靠模型口头“需要更多”。
- Tool 白名单除了模型可见 Descriptor 之外，在 Executor 边界仍须检查；新的自主工具不能绕过已有 Policy。
- 一个 Sandbox 同时只允许一个可写 Coding Agent；并行 Investigator 只读共享固定/有版本的源码快照，不能跨版本传播未核实证据。
- Task/Run/AgentSession/AgentMessage/Artifact 每次因果关联必须可回放；不会因为额外 Agent 或 Replan 给 Run 新预算/期限。

**验收**：在相同 Issue 的不同观察条件下，实际行动路线会改变；新增的 Tool/Agent/诊断是由模型基于证据选择，而不是事先固定顺序；所有负例仍保持越权与错误状态拒绝。

## 四、功能开关与迭代策略

建议按现有项目约定设计独立可回退开关，例如（具体命名以源码审计为准）：

- `DEVFLOW_BUDGET_QUOTE_V2`（预算报价更正）
- `DEVFLOW_AGENT_MESSAGE_RECOVERY`（消息纠正）
- `DEVFLOW_COORDINATOR_DYNAMIC_ACTIONS`（动态策略动作）
- `DEVFLOW_AGENT_DIAGNOSTICS`（主动受限诊断）

可靠性与安全 Bug 不必永久提供旧缺陷路径；针对可能改变模型行为与修复质量的算法策略保留关停/回退路径。不要因为“需要回退”就允许绕开安全校验。

## 五、测试与 Benchmark 设计

### A. 低成本工程验证（优先）

1. Scheduler 属性测试：顺序/互斥分支报价、cache、真实请求体与估算差异、多个 Worker 并发 reserve、未知回执、续配额、请求未派发无费用。
2. Fake Agent 测试：Coordinator 选择不委派、委派两个、取消失效子任务、接收反证后改变搜索方向；Coding 请求额外调查和受限局部测试。
3. AgentMessage 测试：E07 错误字段纠正、replyTo 因果合法、消息去重/恢复、无权限引用拒绝、接收方行动变化。
4. Worker / Sandbox 测试：审批 → 新 revision → 恢复同一 Session、Lease 续租、stale owner fencing、长耗时 IO、取消与清理。
5. 安全/契约测试：审批、真实 SHA、Tool Executor、Final Validation、Review、GitHub 发布不被模型 action 绕过。

### B. 真实题验证（需单独预算授权）

复用 E01–E09 的同冻结 Issue、环境、镜像、公开 Profile、隐藏评分隔离。新版本记录独立 Source SHA、runtime digest、模型参数、预算与实验 ID。不得注入旧 Patch、gold patch 或评分信息；不为提升成绩替换题目、忽略 FAIL、自动整题重试。旧的 ¥200 总额、单题 ¥4 只是**历史实验边界，不构成本轮新增有偿 API 消耗的授权**。获得用户明确的本轮预算授权前，只执行本地 Fake Model / Dry-run / 可免费完成的集成测试。

必须报送：

- 首补丁覆盖、PLAN 接收、Coding 到达、正式验证、Review、独立 acceptance、原测试、严格 PASS（分别统计，NOT_RUN 不伪装 PASS）。
- 当前模型请求数、全部 Token、缓存读取量（如 Provider 有报告）、Agent 消息成功数、因消息改变决策的因果实例、逻辑工具与物理 IO、墙钟/active/queue/approval 时间、费用与未知账单。
- 至少比较同等预算和同一输入下：**强单 Agent**、**固定多角色工作流**、**动态协调多 Agent**；模型/算法版本不同时必须明确比较限制和随机性，单次九例不宣称统计显著。

### C. 发版门禁

- 安全：无未授权写入、无预算超售、无 stale owner 提交、无隐藏评分泄漏。
- 协作：至少一条可恢复的真实（非只有 mock）的 SEND→REPLY/CHALLENGE→另一 Agent 改变行为的证据链。
- 稳定性：E07 类消息错误可有限恢复；预算预检对 P-01/P-02 给出准确可解释的合法准入决策；E01 宿主静默和 Lease 问题经针对性回归。
- 质量：冻结 E03/E04 的既有成功能力不得被无理由破坏；全部 E01–E09 保留真实 PASS/FAIL/NOT_RUN 与资源数据，不因架构实现就宣布修复率提升。
- 只有工程、协作、真实任务和安全门禁达到事先定义的可复现标准后，才考虑标记正式 v3.0；否则保留实验或预发布版本。

## 六、对 Codex 的明确指令

你是 DevFlow 多 Agent 平台的主程、架构师和评测负责人。**请实际执行，不要停留在规划文档。**

1. 审计仓库 HEAD / git status / 相关源码 / 工程测试，确认本说明提及的路径和故障在当前版本的实际存在性。冻结现状并建立安全的开发/回退边界。
2. 分别为 P-01 至 P-05 制定“复现 → 根因 → 最小修复 → 反证/回归测试”的工单，并按阻断范围优先 P-01/P-02，然后 P-03/P-04，再 P-05。对原报告中没有证明的因果关系保持怀疑。
3. 可靠性修复通过后，给出 Agent 自主决策的最小可运行 RFC，说明模型动作协议、Tool Policy、预算、Recovery、任务板/消息和必经审批/验证边界。
4. 按阶段提交真实源码和测试；每阶段保留清晰变更、配置开关、成功/失败记录和回退办法。修复异常时不新增绕过审批或绕过账本的临时捷径。
5. 优先用 Fake Model/Mock 和低成本测试验证；涉及新的收费 API 或线上发布动作，先记录所需金额/范围并等待用户明确授权，不能把旧额度当作新授权。
6. 最终给出：代码修改清单、架构与数据协议、逐问题根因和修复说明、测试命令和原始状态、自治行为轨迹、资源统计、尚未解决风险、下一阶段建议。不以更高 Agent 数量或更早失败作为“升级完成”。