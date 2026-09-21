# P10–P11 简化验收指南

本指南采用“Web 完成业务验收，自动化完成安全边界验收”的方式。日常验收不再需要手写 API、SSE、SQL 或 Docker 故障注入命令。

## 1. 一次性准备

要求 Node.js 22.12+、npm 10+、Git 和 Docker Desktop。首次使用：

```powershell
Copy-Item .env.example .env
npm install
```

编辑 `.env`，至少配置数据库、Redis 和模型参数：

```dotenv
DATABASE_URL=postgresql://devflow:devflow@localhost:5432/devflow?schema=public
REDIS_URL=redis://localhost:6379
LLM_PROVIDER=openai
LLM_MODEL=<model>
LLM_API_KEY=<key>

# 留空时，每个 LOCAL Repository 仅允许读取自身目录。
# 需要允许多个本地仓库时，填写它们共同的、受控的绝对父目录。
DEVFLOW_LOCAL_REPOSITORY_ROOT=
```

随后只需一条启动命令：

```powershell
npm run acceptance:web
```

该命令会启动 PostgreSQL/Redis、应用 migration、按需构建 Sandbox image，并启动 Web、API 和 Worker。看到服务 ready 后打开：

<http://localhost:3000/acceptance>

## 2. Web 验收 LOCAL Run 与 Bugfix

在“Web 验收中心”按页面清单操作：

1. 创建 `LOCAL` Repository，填写 Git 仓库的绝对路径。
2. 创建 Task。LOCAL Repository 的 `Base ref` 和 `Base commit` 通常都留空，系统会冻结当前实际 `HEAD` 与 dirty working tree，不要求切换到默认分支。
3. 创建 Run，等待 Plan 出现。
4. 在页面直接批准或拒绝 Plan；拒绝时填写反馈，再批准新 Plan。
5. 观察页面自动经历 Execute、Test/Repair、Review、Diff 和 Result。

验收通过标准：

- 合法 Windows 路径可以创建 Run，不再出现“Repository directory ... does not exist”；
- Run Detail 无需刷新即可显示事件与终态；
- 成功 Run 显示 Diff、Review、指标和 `SUCCEEDED`；
- 失败 Run 显示结构化错误代码和消息，不会停留在 `RUNNING`；
- 宿主仓库的 HEAD、工作区和 `.git` 不会被 Agent 修改。

LOCAL dirty snapshot、Docker setup failure 清理、SSE 断线回放等不适合靠人工制造，使用下面两条自动化命令覆盖：

```powershell
npm run test
npm run test:e2e
```

## 3. Web 验收 P10 GitHub 发布

真实发布只使用你明确授权的、可丢弃的公开测试仓库。将以下配置加入 `.env` 后重启 `npm run acceptance:web`：

```dotenv
GITHUB_TOKEN=<fine-grained-token>
DEVFLOW_GITHUB_WRITE_ENABLED=true
DEVFLOW_SANDBOX_NETWORK_ENABLED=true
```

Token 只授予测试仓库的 Metadata read、Contents read/write 和 Pull requests read/write 权限。不要把 Token 填入页面、Task、审批意见或 `NEXT_PUBLIC_*` 变量。

在 <http://localhost:3000/acceptance> 中：

1. 创建 `GIT` Repository，URL 使用公开 HTTPS 地址。
2. 创建 Task，填写默认分支和从 GitHub 页面复制的完整 base commit SHA。
3. 创建 Run 并批准 Plan。
4. 测试、Review 和 Diff 完成后，页面停在 **Push approval**。检查仓库、base commit、目标分支和变更摘要后再点击批准。
5. Push 完成后页面停在 **PR approval**。再次确认标题、base/head 分支后点击批准。
6. 在 Run Detail 的 GitHub publication 区域打开远端分支和 Pull Request 链接，确认默认分支没有被直接修改。

两个审批按钮就是实际副作用的安全闸门。没有显式批准时，平台不得创建远端分支或 PR。

不访问真实 GitHub 的 P10 幂等与安全基线只需运行：

```powershell
npm run test:p10
```

## 4. P11 Benchmark 验收

P11 包含隐藏 evaluator、进程隔离、受保护文件哈希、超时和防篡改检查。这些检查不能由页面人工点击可靠替代，因此使用一条确定性命令：

```powershell
npm run test:p11
```

通过标准：6 组固定场景和全部 P11 测试通过，命令退出码为 `0`，结束后没有 `devflow.managed=true` 的容器残留。Benchmark 创建的普通 Run 仍使用与 Web 相同的 Run Detail 数据结构；对开发数据库运行正式 `npm run benchmark -- ...` 时，可在 Web Runs 列表中查看其执行、事件和结果。

## 5. 最小回归矩阵

提交前执行：

```powershell
npm run lint
npm run typecheck
npm run test
npm run test:e2e
npm run test:p9
npm run test:p10
npm run test:p11
```

其中 P9 本身就是浏览器端完整工作流，覆盖创建 Repository/Task/Run、拒绝并重新规划、批准、修复循环、独立 Review、Diff 与最终结果。

## 6. 清理

停止 `npm run acceptance:web` 后执行：

```powershell
npm run infra:down
```

真实 GitHub 验收产生的 Run 分支和测试 PR 由操作者在 GitHub 页面确认后删除或关闭。恢复安全默认值：

```dotenv
DEVFLOW_GITHUB_WRITE_ENABLED=false
DEVFLOW_SANDBOX_NETWORK_ENABLED=false
```
