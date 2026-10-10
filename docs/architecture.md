# DevFlow 架构说明

按模块复习内部机制与调用链，请先阅读[整体技术报告与源码指南](project-study-guide-v2.3.1.md)。

当前版本为 v2.3.1（[技术报告](technical-report-v2.3.1-20261010.md)），代码修改和失败修复共用一个持久化 Coding Session。流程、验收结果及剩余预算阻断见 [Unified Coding Loop](unified-coding-loop-20261008.md)，生产契约见 [v2 workflow](v2-workflow.md)，模型接入见 [stage models](stage-models.md)。历史阶段标签和复杂度字段保持兼容，不代表新的 Agent 生命周期或 Planner 必填输出。

## 1. 设计目标

DevFlow 将一次 AI 软件工程任务建模为可持久化、可恢复、可审批的 Run。核心目标是：

- API 与不可信代码执行分离；
- Agent 只通过明确的 Tool 端口获得能力；
- 代码、Git 和测试操作都在 Docker Sandbox 中完成；
- PLAN 审批、Coding、宿主最终验证、独立 Review 与 GitHub 发布都有明确边界；
- Run 状态、事件、指标和审批可以在进程崩溃后恢复；
- 用户能通过 Web/SSE 理解 Agent 做了什么、为什么停止。

## 2. 系统全景

```text
                              REST / SSE
 +---------+              +---------------+
 |   Web   |------------->|  NestJS API   |
 +---------+              +-------+-------+
                                  |
 +---------+                      | persist / query
 |   CLI   |                      v
 +----+----+               +------+-------+
      |                     | PostgreSQL   |
      |                     | Prisma       |
      |                     +------+-------+
      |                            ^
      |                    events / checkpoints
      |                            |
      |    +-------------+   +-----+-------+
      +--->| Agent stack |<--|   Worker    |
           +------+------+   +-----+-------+
                  |                ^
                  |                |
                  |          Redis / BullMQ
                  v                ^
           +------+-------+        |
           | ToolExecutor |        +--- API enqueue
           +------+-------+
                  |
                  v
           +------+-------+       +-------------+
           | Docker       |------>| Git / tests |
           | Sandbox      |       +-------------+
           +------+-------+
                  |
                  +---------------> GitHub REST API
                       approved platform operation
```

### Web

Next.js App Router 应用负责 Repository / Task / Run 创建、Run Detail、审批操作与实时事件展示。Web 只使用浏览器安全的领域契约，不导入 Prisma、Docker 或 Node-only 实现。

### API

NestJS API 管理 Repository、Task、Run 和 Approval。它负责 Zod 校验、数据持久化、Run 入队与 SSE，但不执行 Agent。创建 Task 时会解析并固定完整 base commit SHA；创建 LOCAL Run 时会持久化不可变快照。

### Redis / BullMQ

API 将版本化 `{ runId, dispatchRevision }` 任务投递到 BullMQ。Redis 只承载调度，PostgreSQL 才是 Run 状态的权威来源。

### Worker

Worker 消费队列、Claim Run 执行 Lease、定期续租/检查取消，并驱动生产工作流。如果 Worker 崩溃，Lease 过期后 Recovery 会重新入队可恢复 Run。

### Agent Runtime

Agent Runtime 管理模型消息、Tool Call、Tool Result、Checkpoint、Retry、Context Projection 和 Step Budget。Localization、Planner 和独立 Review 各自绑定模型；代码编辑、测试失败修订、Review 缺陷处理和重新审批恢复均使用同一 Coding Session，沿用 `LLM_EXECUTE_*`。宿主反馈更新稳定任务状态和有效源码证据，不重置历史、预算、纠正额度或进展计数。历史 `REPAIR` 标签只表示失败处理原因。

### Tool Executor

Tool Registry 为每个 Tool 提供 Schema、Permission 和可并行/只读/写入元数据。Executor 统一执行输入校验、Policy 判定、超时、结果规范化和 Event 记录。

### Docker Sandbox

Sandbox 使用独立容器、非 root 用户和 `/workspace` 工作目录。容器受 CPU、内存、PID、网络、超时和输出上限约束；路径规范化与 symlink 检查防止逃逸。LOCAL 仓库通过已固定快照进入容器，远程仓库在容器内 clone 并 checkout 固定 SHA。

### GitHub Adapter

GitHub Token 只存在平台 Provider 边界。Branch Push 和 Pull Request 要求持久化审批，并使用稳定 operation key 和远程 marker 实现幂等恢复。

## 3. 一次 Run 的数据流

```text
Repository
   |
   v
Task -- resolve/fix baseRef + baseCommitSha
   |
   v
Run -- persist immutable options/snapshot -- enqueue
   |
   v
Worker claim + lease
   |
   v
LOCALIZATION -- read-only evidence
   |
   v
PLAN -- concise proposal -- Approval
   |
   v
CODING SESSION -- observe / edit / analyze / revise
   | submit                       ^
   v                              | public failures / unfinished work
FINAL VALIDATION -- public build / typecheck / lint / test
   | pass                         |
   +------------------------------+
   |
   v
REVIEW -- structured independent result
   | confirmed defect -> same CODING SESSION -> VALIDATION -> REVIEW
   | evidence gap -> bounded host evidence / public reproduction
   v
DIFF
   |
   +-- LOCAL: result
   |
   +-- GIT: push approval -> branch -> PR approval -> pull request
```

PlanProposal 不要求历史 `complexity` / `estimatedSteps` / `confidence` 字段。宿主按当前输入、配置输出、可达后续操作和剩余资源预检；同一任务共享步骤、token、工具、时间及费用上限。修订不会生成一份新的 Repair 预算。重复读取、未变 diff 或相同失败不能构成进展；有效 `finishPhase` 直接交给宿主验证，不追加模型确认。扩大修改范围需要一次只读 Replan 和新的 PLAN 审批，批准前不得写入新增目标。

## 4. 状态与事件

`Run.status` 表示执行生命周期：

```text
QUEUED | RUNNING | WAITING_APPROVAL | SUCCEEDED | FAILED | CANCELLED | TIMED_OUT
```

`Run.currentStage` 表示工作流位置：

```text
START -> ANALYZE_REPOSITORY -> ANALYZE_TASK -> GENERATE_PLAN
      -> WAITING_APPROVAL -> EXECUTE -> TEST <-> FIX -> REVIEW
      -> GENERATE_DIFF -> [WAITING_PUSH_APPROVAL -> PUSH
      -> WAITING_PR_APPROVAL -> CREATE_PR] -> DONE
```

`FAILED` 和 `CANCELLED` 是终态阶段。状态写入使用当前 status/stage 作为 CAS 条件，并经过转移约束校验，防止过期 Worker 覆盖新状态。

`EXECUTE`、`FIX` 等存储与展示标签为兼容保留。`FIX` 不再创建独立 Repair Agent：公开验证或 Review 的反馈继续原 Coding Session；无资源、停滞或证据无法确认时保存候选和具体原因，不能标记为成功。

Event 在单个 Run 内使用单调递增 `sequence`。SSE 客户端携带 `Last-Event-ID` 或 `afterSequence` 后，API 从 PostgreSQL 补发缺失事件，再持续轮询新事件；空闲期发送 heartbeat，终态后发送 `stream-end`。

## 5. 数据模型

```text
Repository 1---N Task 1---N Run
                         |
                         +---N Step
                         +---N ToolCall
                         +---N Event
                         +---N Artifact
                         +---N Approval
                         +---1 GitHubPublication
                         +---0..1 BenchmarkCaseExecution
```

Prisma Schema 定义持久化结构，`DatabaseAdapter` 是应用层端口，防止 Prisma record 直接泄漏成 API/领域契约。Artifact 保存 Plan、Diff、Test/Review report、GitHub changeset 和快照；Event 保存可重放的操作轨迹。

## 6. 恢复与幂等

- Run 创建支持 `idempotencyKey`，重放请求不会重新读取已变化的 LOCAL 仓库。
- BullMQ Job 携带 `dispatchRevision`，过期派发可以被拒绝。
- Worker 通过 owner + lease 保证单个 Run 的有效执行者。
- Agent/Workflow Checkpoint 持久化会话历史、任务反馈、预算、纠正额度、指标、测试指纹和 Diff 指纹；恢复不重新领取消费或重规划次数。
- 新审批恢复先核对基准、累计变更、当前 SHA、批准范围和原会话关联，再继续 Coding。无法确认旧任务身份或消费时明确阻断。
- 审批会暂停执行并释放 Worker，而不是在进程内阻塞等待。
- GitHub 写操作使用稳定 operation key；在远程写入可能已成功而本地响应丢失时，协调器会先对账再持久化。

## 7. 安全边界

1. Agent 生成的任意命令不能在宿主机直接执行。
2. Tool 与 Sandbox 使用 `program + args[]`，不默认接受 shell 字符串。
3. 路径限定在 `/workspace`，并检查 `..`、`.git` 与 symlink escape。
4. 容器默认禁用网络，环境变量使用 allowlist。
5. 每次命令都有超时、取消、输出上限和结构化错误。
6. GitHub/LLM 凭证属于平台配置，不进入 AgentState、Prompt、Tool 输入或 Sandbox env。
7. GitHub Push/PR 需要明确的持久化审批。

## 8. 包依赖方向

```text
shared
├── sandbox
│   └── git
│       └── tools
│           └── agent
├── database
├── github
└── eval

workflow 依赖 shared + agent
apps/* 是组合根
```

关键端口包括 `LanguageModelPort`、`ToolExecutor`、`SandboxManager` / `SandboxSession`、`GitService`、`DatabaseAdapter`、`EventSink` 和 `EvaluationTarget`。具体 SDK/框架对象局限在 Adapter 或应用组合层。
