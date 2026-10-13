# E01 所有权、验收 IO 与候选失败审计

本文核对 2026-10-13 三 Worker 九题中的 E01 原始事件、Coding checkpoint、Scheduler 账本与冻结公开材料。历史代码为 `3eb17f3c71207135be62b72432d3e8478d312f33`，runtime 为 `035a783855890c2fca67f4f55b1fd9413d0a747b24500ed1f0a2ca5ae8feb05a`。本次只有免费回放与工程测试，没有新增 Provider 请求。

## 1. 首次失败与后续故障必须分开

E01 首次公开验证失败后，确实完成 Replan、第二次 PLAN Approval 与 Coding Session 恢复。恢复后的 Coding 没有形成搜索层补丁。

| UTC 时间          | 已保存的观测                                                   | 能确认的结论                           |
| ----------------- | -------------------------------------------------------------- | -------------------------------------- |
| 07:57:48          | `REPAIR_STARTED: APPROVED_SCOPE_REPLAN`                        | 新审批后的修复已开始                   |
| 07:57:52          | `readFile` 被 `CLOSING_REFRESH_EXHAUSTED` 拒绝                 | 必要补读没有执行                       |
| 07:58:36–47       | `applyPatch` 返回 `CONTEXT_MISMATCH`；`workspaceChanged=false` | 搜索层编辑没有写入；索引层旧补丁仍在   |
| 07:58:47          | Coding checkpoint 已 `FAILED / AGENT_STALLED`，无进展计数 2    | 这是先发生的修复停机                   |
| 07:58:50          | Workflow 记录 Repair 结果后进入候选独立评估                    | 后续耗时不是新的模型调查               |
| 07:59:39–08:12:02 | 单个 `sandbox.readFile` 实际耗时 741,958 ms                    | 存在宿主 IO 长等待；该操作报价仅 30 秒 |
| 08:12:19          | `SANDBOX_LOST_OWNERSHIP` 成为最终 Run 错误                     | 后续评估错误覆盖了先前的 Coding 原因   |

因此，旧报告所称“13 分 29 秒没有新模型/工具回执”不能理解为整个宿主完全没有活动。该期间账本仍记录内部文件读取；一次读取占据了约 12 分 22 秒。历史产物没有该读取的 Docker transport 与数据库 ownership 子阶段耗时，也没有 heartbeat 延迟记录，无法继续证明当时是 Docker daemon、数据库等待还是事件循环阻塞。不能据此声称发生了多个写者。

## 2. 高 IO 的可核查来源

账本合计 718 次内部执行、675 次读。读操作由 630 次 `sandbox.readFile`、43 次 `sandbox.listFiles`、2 次 PRG store 读取构成。Sandbox 写入为 2 次 `writeFile` 与 1 次 `applyPatch`，PRG store 写入 4 次。

该题有 265 个受保护文件。将冻结快照文件字节数、保护文件顺序与按时间排序的 readFile 结算对照，可以识别下列连续序列；历史记录缺少逐读路径，故这是结合生产调用路径的序列归因，不是臆造路径级 span。

| 调用阶段                                    |           可匹配的保护文件序列 | 实际时间范围 UTC  |
| ------------------------------------------- | -----------------------------: | ----------------- |
| 首次 `prepareBenchmarkEvaluation`           |                        265/265 | 07:48:44–07:51:37 |
| 新审批恢复后的 `prepareBenchmarkEvaluation` |                        265/265 | 07:54:02–07:57:28 |
| 失败候选 `evaluateBenchmarkInSandbox`       | 54 个正常完成，然后 1 个长等待 | 07:58:51–08:12:02 |
| 后续失败处理中的再次评估                    |                  13 个正常完成 | 08:12:07–08:12:18 |

首两次各 265 个文件是不同 Sandbox 恢复后的完整性验证；未经验证就复用旧哈希会削弱完整性，不属于可以直接删掉的重复成本。本轮没有用缓存命中伪装物理读，也没有删减保护文件检查。后续若批量计算文件哈希，应分别计量一次 transport 与实际 N 次文件读取，并保持文件类型、SHA 与变更检测。

上述耗时为可重叠的操作区间，不能把 inclusive time 简单相加当作 Run 墙钟时间。741,958 ms 失败读取的 1 MiB 结算值来自失败时的保守估计，不证明实际成功返回了 1 MiB 文件。

## 3. 本轮确定性平台修复

1. Sandbox 为 ownership 前置校验、Docker command、ownership 后置校验分别记录不含源码的 operation ID、阶段、起止、期限与失败类型。ownership 校验最多 5 秒；Docker transport 沿用原命令期限并仅增加 2 秒终止/排空时间。容器内部 GNU timeout 继续保留。
2. transport 逾期视为执行结果未知，当前 Sandbox 标为 unsafe，拒绝后续读写，只允许原 owner 清理。晚到成功回执不能重新开放该 Session。本地补证请求取消仍先排空有界命令，不因子请求取消销毁正常所有者的容器。
3. RunProcessor 根据最后确认的租约设置 watchdog。heartbeat 卡住不能让检查永远处于 pending；过期后停止该执行者。记录续租数量、最长检查耗时、失败检查、是否到达租约期限及 dispatch revision。忽略 abort 的 executor 也不能提交成功。
4. Prisma 续租先在事务中锁定 owner 行，再用独立语句的数据库 `clock_timestamp()` 校验租约；避免 `WHERE` 在等待行锁之前求值导致过期后续租。已过期租约不能自我复活。完成 Run、创建 PLAN/GitHub Approval 前使用同一活租约检查。恢复仍需重新 claim，新 owner 不能被旧 owner 提交覆盖。
5. 已失败 Coding 的独立评估再次失败时，保留原始错误，同时附上 `benchmarkEvaluation.status=INCOMPLETE` 和次级错误。没有完整独立评估的成功候选仍会失败，不能据此放宽验收。

这些修复提供故障边界和准确归因；不宣称已经查明历史 Docker/数据库长等待的底层原因，也不宣称 E01 已严格修复。

## 4. E01 候选的公开行为复现

在同一冻结公开快照、同一镜像、关闭网络的独立 Docker 容器中，分别运行原生 build 与 91 项公开测试。候选使用历史真实 diff；不修改测试，不运行私有评分器，不读取参考补丁。

| 版本             | Build | 原公开测试 | 未通过                                                                                             |
| ---------------- | ----- | ---------- | -------------------------------------------------------------------------------------------------- |
| 原始 broken 基准 | PASS  | 89/91      | `SearchEngineTest.FiltersStalePostings`、`ModelTest.FixedSeedLifecycleMatchesIndependentScanModel` |
| 历史真实候选     | PASS  | 90/91      | `SearchEngineTest.FiltersStalePostings`                                                            |

因此“原测试 FAIL”在本题表示仍有基准缺陷未完成，不能称为该补丁新引入了回归。索引删除的补丁解决了生命周期问题；公开搜索测试直接删除 DocumentStore 中的文档，独立检验搜索层对陈旧 posting 的过滤。候选没有更改搜索层，实际仍返回 `{2,9}`，期望 `{9}`。

原始恢复请求中搜索实现的已展示范围为 29–71 行；关键 `if (explanation != nullptr)` 分支在后面的 72–76 行。补读失败后，模型提交的 hunk 不匹配，而且拟调用 `filterExisting` 的参数也不符合当前声明。由于该补丁从未写入，不能把这个拟议编译错误记成候选实际回归。源码证据不足与不合法编辑共同限制了此次修复，不能只归因于模型忽略完整证据。

可泛化的后续措施是：在当前批准范围与预算内允许恢复缺失的关键连续源码，给 `CONTEXT_MISMATCH` 提供有界编辑纠正，并保持原公共失败诊断。读取恢复不授予新写权限，纠正不计实质进展，也不能在配额耗尽后隐式重置恢复信用。应先用通用截断函数/错误 hunk 夹具验收，不向模型注入该案例的正确修改。

## 5. 免费验收与限制

- Sandbox 32 项测试通过，包括挂起 transport、迟到成功回执、ownership 查询挂起、越权/失效 owner、局部取消排空与恢复容器隔离。
- RunProcessor 11 项测试通过，包括 5 秒长 IO 期间连续续租，以及 pending heartbeat 后到达租约期限、迟到回执不复活。
- Database event store 8 项测试通过；独立 PostgreSQL 租约/审批恢复测试 4 项通过，包括续租、完成和审批在行锁等待后到期的负例，临时数据库已清理。
- 主失败原因保留 2 项测试通过：失败 Coding 不被二级评估错误覆盖；成功候选遇到评估错误仍拒绝。
- 上述两次 Docker 公开回放完成；TypeScript core 检查通过。本批新增付费请求和费用均为 0。

原始轨迹、读取序列审计、公开测试 stdout、临时实验脚本保存于 Git 忽略的 `.devflow/ownership-audit-20261013/`。需要新的真实模型实验才能判断修复成功率；本次附件明确要求另行获得付费实验授权。
