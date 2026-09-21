# DevFlow 架构说明

## 1. 设计目标

DevFlow 将一次 AI 软件工程任务建模为可持久化、可恢复、可审批的 Run。核心目标是：

- API 与不可信代码执行分离；
- Agent 只通过明确的 Tool 端口获得能力；
- 代码、Git 和测试操作都在 Docker Sandbox 中完成；
- PLAN、测试、Repair、Review 与 GitHub 发布都有明确边界；
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

Agent Runtime 管理模型消息、Tool Call、Tool Result、Checkpoint、Retry、Context Projection 和 Step Budget。生产 Workflow 会为 PLAN、EXECUTE、REPAIR 和 REVIEW 选择不同 Prompt、Tool 集与 reasoning 策略。

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
PLAN -- structured output + adaptive budget -- Approval
   |
   v
EXECUTE -- minimal repository changes
   |
   v
TEST -- deterministic command
   | pass                         | fail
   |                              v
   |                           REPAIR
   |                              |
   +------------------------------+
   |
   v
REVIEW -- structured independent result
   | fail -> targeted repair -> TEST -> REVIEW
   v
DIFF
   |
   +-- LOCAL: result
   |
   +-- GIT: push approval -> branch -> PR approval -> pull request
```

PLAN 输出的 `complexity` / `estimatedSteps` / `confidence` 与仓库路径元数据一起生成 soft budget。`Run.maxSteps` 是 PLAN、EXECUTE、REPAIR、REVIEW 共用的硬上限。有效 Diff 或定向探索可获得有界扩展；重复 Tool、未变 Diff 或相同测试失败会触发收敛保护。

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
- Agent/Workflow Checkpoint 持久化预算、指标、测试指纹和 Diff 指纹。
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
