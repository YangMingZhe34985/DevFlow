# DevFlow

[中文](README_CN.md) | [English](README.md)

DevFlow 是一个面向 AI 软件工程 Agent 的可观测、可验证执行平台，覆盖仓库分析、代码修改、测试与修复、独立审查、人工审批以及 GitHub 交付流程。

> Repository + Task → Observable and Verifiable Agent Run

DevFlow 将交互 API 与不可信代码执行彻底分离：API 只持久化意图并投递任务，BullMQ Worker 驱动工作流，Agent 只能通过受策略约束的 Tool 在 Docker Sandbox 中操作仓库。

## 项目概述

DevFlow 把软件工程任务转化为持久化 Run，并提供明确的阶段状态、事件流、Agent 预算、确定性测试、人工审批点以及可审查的 Git 产物。系统同时支持本地仓库和 GitHub 仓库，并在创建 Task 时锁定不可变的基准 Commit，保证可复现性。

当前版本主要面向本地开发与评测。若要暴露在不可信网络中，需要先补充适合部署环境的身份认证与授权层。

## 主要能力

- 本地/GitHub 仓库管理与不可变基准 Commit 解析
- 结构化 PLAN、复杂度评估和 Run 级自适应 Step Budget
- 基于 Tool Calling 的 Agent Runtime，带上下文上限、重试、Token 限制和进展检测
- Docker Sandbox 隔离的文件、Git 和测试执行
- 确定性测试与定向 Repair 循环，防止无限修复
- 独立结构化 Review 和 Diff 生成
- PLAN 与 GitHub 发布的 Human-in-the-loop 审批
- BullMQ/Redis 异步执行，带 Lease、取消、重试和崩溃恢复
- PostgreSQL/Prisma 持久化 Run、Event、Step、Artifact、Approval 和 Metrics
- 基于持久化事件序号的 SSE 断线重放
- 幂等的 GitHub Branch Push 与 Pull Request 创建
- 可复现 Benchmark fixture、provenance 校验和效率报告
- 通过 Provider 抽象接入 OpenAI 和 OpenAI-compatible LLM

## 系统架构

```text
                        +-------------------+
用户 ------------------>| Web (Next.js)     |
  |                     +---------+---------+
  |                               |
  +-------------------->| CLI     | REST / SSE
                        +----+----+         |
                             |              v
                             |      +-------+--------+
                             |      | API (NestJS)   |
                             |      +---+---------+--+
                             |          |         |
                             |          |         +------> PostgreSQL
                             |          v
                             |      Redis / BullMQ
                             |          |
                             |          v
                             |      +---+----------+
                             +----->| Worker       |
                                    +---+----------+
                                        |
                           +------------+-------------+
                           | Workflow / Agent Runtime |
                           +------+--------------+----+
                                  |              |
                                  v              v
                         Tool Executor       LLM Provider
                                  |
                                  v
                         Docker Sandbox
                         (文件、Git、测试)
                                  |
                                  +----------> GitHub API
```

API 不执行 Agent；Worker 独占执行权。Agent 不会获得宿主文件系统、Docker、数据库或平台凭证的直接访问权。详细说明见 [docs/architecture.md](docs/architecture.md)。

## 技术栈

| 领域          | 技术                                                    |
| ------------- | ------------------------------------------------------- |
| Web           | Next.js 16、React 19、TypeScript                        |
| API           | NestJS 12、Zod                                          |
| Worker 与队列 | Node.js、BullMQ、Redis                                  |
| 数据持久化    | PostgreSQL、Prisma 7                                    |
| Agent 与 LLM  | Vercel AI SDK、OpenAI/OpenAI-compatible Adapter         |
| 隔离          | Docker Sandbox，带 CPU、内存、PID、网络、超时和输出限制 |
| 校验与测试    | Vitest、Playwright、Docker 集成测试                     |
| Monorepo      | npm workspaces、TypeScript project references、ESM      |

## 目录结构

```text
apps/
  api/          REST API、审批、队列投递与 SSE
  cli/          本地命令行组合入口
  web/          Dashboard、Run 创建和详情 UI
  worker/       队列消费者与生产工作流编排
packages/
  agent/        模型端口、Agent Loop、状态与上下文控制
  database/     Prisma Schema 和持久化 Adapter
  eval/         Benchmark 定义、评分、provenance 与报告
  git/          只能在 Sandbox 内执行的 Git Service
  github/       GitHub REST Adapter 和发布协调器
  sandbox/      Docker Sandbox 与不可变本地快照
  shared/       浏览器/服务端共用的领域契约和事件
  tools/        Tool 注册、策略、内置工具与 Executor
  workflow/     纯工作流状态和转移契约
docker/         开发基础设施与 Sandbox 镜像
docs/           架构、决策记录与归档开发资料
scripts/        跨 workspace 集成/验收 runner
tests/          集成测试、E2E 和 Benchmark fixture
```

## 快速开始

### 环境要求

- Node.js 22.12 或更高版本（CI 使用 Node.js 24）
- npm 10 或更高版本
- Docker Engine 或 Docker Desktop，并支持 Compose

### 安装与启动

```bash
git clone <your-fork-or-repository-url>
cd Devflow
cp .env.example .env
npm ci
```

Windows PowerShell 请使用 `Copy-Item .env.example .env`。

编辑 `.env`，至少配置 `LLM_PROVIDER`、`LLM_MODEL` 和 `LLM_API_KEY`。使用 OpenAI-compatible 服务时还需要配置 `LLM_BASE_URL`。

```bash
npm run infra:up
npm run db:migrate:deploy
npm run sandbox:build
npm run dev
```

默认地址：

- Web：`http://localhost:3000`
- API：`http://localhost:3001/api/v1`
- Worker 健康检查：`http://localhost:3002/health/ready`
- PostgreSQL：`localhost:5432`
- Redis：`localhost:6379`

停止开发基础设施：

```bash
npm run infra:down
```

## 配置

请从 [.env.example](.env.example) 开始。关键变量如下：

| 变量                            | 作用                                         |
| ------------------------------- | -------------------------------------------- |
| `DATABASE_URL`                  | Prisma、API 和 Worker 使用的 PostgreSQL 连接 |
| `REDIS_URL`                     | BullMQ 使用的 Redis 连接                     |
| `LLM_PROVIDER`                  | `openai` 或 `openai-compatible`              |
| `LLM_MODEL`                     | Provider 中的模型标识                        |
| `LLM_API_KEY`                   | 仅保存在平台边界的模型凭证                   |
| `LLM_BASE_URL`                  | OpenAI-compatible 接口必填                   |
| `DEVFLOW_LOCAL_REPOSITORY_ROOT` | 可选，限制允许导入的本地仓库根目录           |
| `DEVFLOW_MAX_STEPS`             | Agent 决策的 Run 级硬上限                    |
| `DEVFLOW_MAX_TOTAL_TOKENS`      | Run 级 Token 预算                            |
| `DEVFLOW_TIMEOUT_MS`            | 活跃执行链路的绝对超时                       |
| `DEVFLOW_SANDBOX_IMAGE`         | 隔离 Run 使用的 Docker 镜像                  |
| `DEVFLOW_GITHUB_WRITE_ENABLED`  | 是否启用审批后的 GitHub 写操作，默认关闭     |
| `GITHUB_TOKEN`                  | 平台专用 GitHub 凭证，不得传给 Agent         |

请勿提交 `.env` 或真实凭证。GitHub Token 必须保留在 API/Worker Provider 边界，不得进入 Task 描述、模型 Prompt、Sandbox 环境或 Event payload。

## 开发

```bash
npm run check          # lint、类型检查与单元测试
npm run build          # 构建 TypeScript workspaces 和生产 Web
npm run test           # Vitest 测试
npm run test:e2e       # Playwright Web E2E
npm run format:check   # 检查格式
npm run db:validate    # 校验 Prisma Schema
```

`package.json` 中还提供了 Docker 集成测试 runner。它们会创建隔离数据库与 Sandbox，因此需要 Docker、PostgreSQL 和 Redis。

## Run 工作流

```text
创建 Repository
        |
        v
创建 Task 并锁定 base commit
        |
        v
创建 Run -> 入队 -> Worker Claim / Lease
        |
        v
PLAN -> Plan Approval
        |
        v
EXECUTE -> TEST -> REPAIR（有界循环）
        |
        v
REVIEW -> 可选定向修复与重测
        |
        v
DIFF
        |
        +---- LOCAL ----------------------> DONE
        |
        +---- GitHub -> Push Approval -> Push
                         -> PR Approval -> Pull Request -> DONE
```

重要状态转移、模型调用和 Tool 结果都会持久化。Web 重连时会先按序号重放 Event，再继续接收 SSE 更新。

## Roadmap

- 面向部署的身份认证、授权和租户隔离
- 大型 Artifact/日志的对象存储与保留策略
- 更完整的运维指标与分布式追踪
- 更多仓库宿主和 Provider-specific LLM Adapter
- Benchmark Dashboard 和长期回归历史
- 对高风险 Tool 的更细粒度持久化审批策略

## 文档

- [架构说明](docs/architecture.md)
- [架构决策记录](docs/decisions/)
- [测试目录说明](tests/README.md)
- [脚本规范](scripts/README.md)
- [历史开发与验收资料](docs/development/)

## License

DevFlow 使用 [MIT License](LICENSE)。
