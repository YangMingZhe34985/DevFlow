# P4–P5 API / Persistence / Queue 手工验收指南

本指南验证 PostgreSQL migration、Repository/Task/Run/Approval REST API、BullMQ Worker，以及 API → Queue → Worker → Agent/Sandbox → Persistence 完整链路。

## 1. 配置与启动 PostgreSQL、Redis

复制环境模板并按需修改账号和端口：

```powershell
Copy-Item .env.example .env
```

基础配置：

```env
POSTGRES_USER=devflow
POSTGRES_PASSWORD=devflow
POSTGRES_DB=devflow
POSTGRES_PORT=5432
DATABASE_URL=postgresql://devflow:devflow@localhost:5432/devflow?schema=public

REDIS_PORT=6379
REDIS_URL=redis://localhost:6379
RUN_QUEUE_NAME=devflow-runs
```

启动 [docker/compose.yml](../docker/compose.yml) 中的服务并执行 migration：

```powershell
npm run infra:up
docker compose -f docker/compose.yml ps
npm run db:migrate:deploy
npm run sandbox:build
```

PostgreSQL 和 Redis 应显示 `healthy`。compose 将数据放在 `postgres-data` 和 `redis-data` 命名卷中；`npm run infra:down` 不会删除数据卷。

## 2. 自动化验收

```powershell
npm run check
npm run test:p1
npm run test:p2
npm run test:p3
npm run test:p5
```

`test:p5` 会：

- 创建独立的临时空 PostgreSQL 数据库并运行首个 migration；
- 启动真实 NestJS HTTP API、Redis/BullMQ Worker；
- 验证 Repository、Task、Run、Approval CRUD、validation、404/409 和状态转换；
- 验证 Run idempotency key、BullMQ job ID 和数据库 execution lease 三层去重；
- 验证 transient retry、活动取消、过期租约 recovery 和重复消费；
- 用 Fake 模型驱动真实 Agent Runtime、Tools 与 Docker Sandbox，最终把状态、指标和 Event 写入 PostgreSQL；
- 删除临时数据库，并确认没有 `devflow.managed=true` 的沙箱容器残留。

如果脚本自行启动了 PostgreSQL/Redis，它会在测试后移除 compose 容器但保留数据卷；如果服务原本已运行，则保持原状态。

## 3. 启动真实 API 与 Worker

在 `.env` 中补齐模型配置：

```env
LLM_PROVIDER=openai
LLM_MODEL=<model>
LLM_API_KEY=<api-key>
```

OpenAI-compatible 服务还需要 `LLM_BASE_URL`。启动全部开发进程：

```powershell
npm run dev
```

检查就绪状态：

```powershell
Invoke-RestMethod http://localhost:3001/api/v1/health/ready
Invoke-RestMethod http://localhost:3002/health/ready
```

API 只有在 PostgreSQL 与 Redis 均可访问时才返回就绪；Worker 只有在数据库、Redis 和 BullMQ consumer 均启动后才返回就绪。

## 4. 创建并执行 Run

以下 PowerShell 示例使用本地 Git 仓库：

```powershell
$repository = Invoke-RestMethod -Method Post `
  -Uri http://localhost:3001/api/v1/repositories `
  -ContentType application/json `
  -Body (@{
    name = "sample"
    sourceKind = "LOCAL"
    sourceUri = "C:\path\to\repository"
    defaultBranch = "main"
  } | ConvertTo-Json)

$task = Invoke-RestMethod -Method Post `
  -Uri http://localhost:3001/api/v1/tasks `
  -ContentType application/json `
  -Body (@{
    repositoryId = $repository.id
    title = "Fix the failing tests"
    description = "Inspect the failure, implement the smallest fix, run tests and inspect the diff."
  } | ConvertTo-Json)

$key = [guid]::NewGuid().ToString()
$created = Invoke-RestMethod -Method Post `
  -Uri http://localhost:3001/api/v1/runs `
  -ContentType application/json `
  -Body (@{
    taskId = $task.id
    idempotencyKey = $key
    maxSteps = 25
  } | ConvertTo-Json)

$runId = $created.run.id
Invoke-RestMethod "http://localhost:3001/api/v1/runs/$runId"
```

重复提交相同 `idempotencyKey` 应返回同一个 Run 且 `created=false`。API 进程只写入数据库并调用 queue adapter；Agent 和 Docker 只会出现在 Worker 进程。

## 5. Cancel、Retry 与 Recovery

取消 Run：

```powershell
Invoke-RestMethod -Method Post "http://localhost:3001/api/v1/runs/$runId/cancel"
```

- 等待中的 job 会从队列删除并直接进入 `CANCELLED`；
- 运行中的 Run 会记录 `cancelRequestedAt`，Worker 轮询后中止 Runtime，Docker Sandbox 随后清理；
- Worker 对基础设施异常使用 BullMQ exponential backoff；数据库先释放租约并增加 `retryCount`；
- Worker 重启时会扫描 `QUEUED` 和租约过期的 `RUNNING`，用相同 `jobId` 安全重新入队。

可在运行期间终止 Worker、等待 `WORKER_LEASE_MS` 后重新启动，确认 Run 被恢复且不会出现两个执行者。

## 6. Approval API

```powershell
$approval = Invoke-RestMethod -Method Post `
  -Uri http://localhost:3001/api/v1/approvals `
  -ContentType application/json `
  -Body (@{ runId=$runId; kind="PLAN"; request=@{ summary="Review plan" } } | ConvertTo-Json -Depth 5)

Invoke-RestMethod -Method Post `
  -Uri "http://localhost:3001/api/v1/approvals/$($approval.id)/resolve" `
  -ContentType application/json `
  -Body (@{ status="APPROVED"; actorId="local-user" } | ConvertTo-Json)
```

同一个 Approval 只能从 `PENDING` 解决一次；重复解决返回 HTTP 409。

## 当前限制

- Approval 已可持久化并进行并发安全的状态转换，但完整“等待审批后恢复工作流”属于 P8。
- Runtime Event 已按 Run 原子分配 sequence；Step/ToolCall/Artifact 的完整投影和 SSE replay 属于 P7–P8。
- Redis job 是至少一次投递；真正的 exactly-once 执行由 PostgreSQL execution lease 和终态检查保证。
- 远程 Git clone 必须显式启用 `DEVFLOW_SANDBOX_NETWORK_ENABLED=true`；凭据代理与仓库平台集成属于后续阶段。

停止基础设施：

```powershell
npm run infra:down
```

如需同时永久删除本地数据库和队列数据，明确确认后再执行：

```powershell
docker compose -f docker/compose.yml down --volumes
```
