# DevFlow 架构骨架

## 运行路径

```text
Web ──REST/SSE──> API ──enqueue──> Redis/BullMQ
                   │                    │
                   └──PostgreSQL <── Worker
                                          │
                                   Workflow + Agent
                                          │
                                      ToolExecutor
                                          │
                                  Docker Sandbox ── Git
```

API 不执行 Agent。Worker 从队列收到 `{ version, runId }` 后从数据库加载权威状态，创建独立 Sandbox，并驱动可恢复的 workflow。

## 包依赖方向

```text
shared
├── sandbox
│   └── git
│       └── tools
│           └── agent
│               └── workflow
├── database
└── eval
```

这是允许的依赖方向，而不是调用顺序。组合根位于 `apps/cli` 与 `apps/worker`。禁止出现以下反向依赖：

- `shared` 导入 Node、Prisma、NestJS 或环境变量；
- `agent` 直接访问文件系统、Docker、Git 或数据库；
- `sandbox` 了解 Tool 或 Agent；
- Prisma record 充当领域/API DTO；
- Web 导入任意服务端实现包。

## 关键端口

- `LanguageModelPort`：屏蔽 Vercel AI SDK 与具体模型供应商。
- `ToolExecutor`：Agent 唯一可调用的外部能力。
- `SandboxManager` / `SandboxSession`：仓库、文件与命令的隔离边界。
- `GitService`：只能使用 `SandboxSession.exec()`。
- `EventSink`：为持久化与 SSE 提供统一事件入口。
- `EvaluationTarget`：让评估系统复用正式执行路径。

## 安全不变量

以下内容不是普通 TODO，任何实现都必须先满足：

1. Agent 生成的命令不得在宿主机运行。
2. 文件路径必须规范化并限制在 workspace 内，同时防止符号链接逃逸。
3. 命令使用 `program + args[]`，默认不接受 shell 字符串。
4. 每次执行都支持 deadline、取消、输出上限和结构化错误。
5. 环境变量使用 allowlist；平台凭据不得暴露给 Agent 或写入 trace。
6. 写操作与高风险命令必须经过策略判断，必要时持久化 Approval 后暂停。

## 应用职责

| 应用   | 职责                                  | 当前状态                                 |
| ------ | ------------------------------------- | ---------------------------------------- |
| CLI    | Phase 1 本地原型组合入口              | 参数入口已建；runtime TODO               |
| Web    | Dashboard / Run Detail                | App Router 与健康路由已建；业务 UI TODO  |
| API    | Repository、Task、Run、Approval、SSE  | Nest 模块与 health 已建；业务 API TODO   |
| Worker | 消费 Run、驱动 workflow、管理 Sandbox | 探针与 processor 边界已建；队列接线 TODO |

## 数据与事件

`Run.status` 表示执行生命周期，`Run.currentStage` 表示工作流位置。事件使用 Run 内单调递增的 `sequence`，便于 SSE 重放；分配序号时必须使用数据库原子机制。大日志和 diff 最终应写入 Artifact/Object Storage，而不是无限膨胀 Event payload。
