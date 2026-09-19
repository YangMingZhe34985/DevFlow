# DevFlow

DevFlow 是一个 AI 软件工程 Agent 的执行、观测与评估平台。核心抽象始终是：

> **Repository + Task → Observable and Verifiable Agent Run**

当前已完成 **P1–P9**：在 CLI Runtime、Docker Sandbox、API、Persistence、Queue 与 Worker 基础上，现已提供浏览器 Run Detail、持久化 SSE、计划审批与拒绝重规划、测试修复循环、独立 Review、Diff 和最终结果展示。

## 目录

```text
apps/
  cli/       Phase 1 独立 Agent 原型入口
  web/       Next.js Web 界面
  api/       NestJS REST / SSE API
  worker/    BullMQ Agent 执行进程
packages/
  shared/    浏览器与服务端共享的领域契约
  sandbox/   隔离工作区与命令执行端口
  git/       只能经 Sandbox 执行的 Git 端口
  tools/     Tool schema、注册表、策略与执行端口
  agent/     模型端口与 Agent Runtime
  workflow/  确定性工作流状态机
  database/  Prisma schema 与持久化端口
  eval/      可复现实验与评分契约
docker/      开发基础设施与 Sandbox 基础镜像
docs/        架构、决策与路线图
```

## 快速开始

要求 Node.js 22.12+（推荐 Node 24）、npm 10+ 和 Docker。

```bash
npm install
cp .env.example .env
npm run sandbox:build
npm run check
npm run dev:cli -- --repo <repository-path> "Describe the software engineering task"
```

Windows PowerShell 可使用 `Copy-Item .env.example .env` 替代 `cp`。

根目录 `.env` 会由 Prisma、API、Worker 与 Next 配置显式加载。默认端口：Web `3000`、API `3001`、Worker 健康探针 `3002`、PostgreSQL `5432`、Redis `6379`。

## 常用命令

| 命令                                          | 作用                                                  |
| --------------------------------------------- | ----------------------------------------------------- |
| `npm run dev`                                 | 先构建核心包，再同时监听 packages、Web、API 与 Worker |
| `npm run dev:cli -- --repo <path> "任务描述"` | 运行 Phase 1 Docker CLI Agent                         |
| `npm run check`                               | lint、类型检查与单元测试                              |
| `npm run test:p1`                             | 构建沙箱镜像并运行确定性 Docker 夹具修复验收          |
| `npm run test:p2`                             | 运行 Runtime、Tool、Workflow 与 CLI 的 P2 测试        |
| `npm run test:p3`                             | 运行 P3 真实 Docker 隔离与异常清理测试                |
| `npm run test:p5`                             | 运行 P4–P5 数据库、API、队列和 Worker 端到端验收      |
| `npm run test:p9`                             | 运行 P6–P9 浏览器、SSE、审批、修复与 Review 验收      |
| `npm run build`                               | 构建核心 workspaces 与 Next.js                        |
| `npm run infra:up`                            | 启动本地 PostgreSQL 与 Redis                          |
| `npm run db:validate`                         | 校验 Prisma schema                                    |
| `npm run db:migrate:deploy`                   | 将已提交的 Prisma migrations 应用到数据库             |
| `npm run sandbox:build`                       | 构建每次 P1 Run 使用的基础镜像                        |

## 当前边界

- API 只负责资源、审批和排队；绝不在请求进程中执行 Agent。
- Worker/CLI 负责组装 runtime；Agent 只能通过 `ToolExecutor` 操作仓库。
- Git 与命令执行只能经由 `SandboxSession`，不存在宿主机回退实现。
- Web 只依赖浏览器安全的 shared 契约，不能导入 Prisma、Docker 或 Node-only 代码。
- Approval 是可持久化的工作流状态，不能通过进程内等待模拟。
- Trace 只记录结构化、已脱敏、可截断的数据；不得存储密钥或模型内部思维链。

详细说明见 [架构文档](docs/architecture.md) 和 [开发路线图](docs/roadmap.md)。原始需求保留在 [项目说明](项目说明.md)。
真实模型配置与 P1 逐步验收见 [P1 手工验收指南](docs/p1-manual-acceptance.md)，P2 状态、指标、错误与 Windows 验收见 [P2 手工验收指南](docs/p2-manual-acceptance.md)，Docker 隔离见 [P3 手工验收指南](docs/p3-manual-acceptance.md)，API、PostgreSQL、Redis、Queue 与 Worker 全链路见 [P4–P5 手工验收指南](docs/p4-p5-manual-acceptance.md)，浏览器交互式工作流见 [P6–P9 手工验收指南](docs/p6-p9-manual-acceptance.md)。
