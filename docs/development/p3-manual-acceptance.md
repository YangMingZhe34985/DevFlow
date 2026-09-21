# P3 Docker Sandbox 手工验收指南

本指南覆盖 P2 AgentState Windows 持久化回归、P3 Docker Sandbox，以及 P1/P2/P3 无回归验证。自动化测试不会调用真实 LLM；第 2 节的真实 CLI 验收会使用 `.env` 中配置的模型。

## 1. 自动化验收

在项目根目录执行：

```powershell
npm install
npm run check
npm run test:p1
npm run test:p2
npm run test:p3
```

其中：

- `test:p1` 验证 Agent → tools → Docker → tests → Git diff 完整链路，并回归 AgentState 多次 checkpoint、终态和指标写盘；
- `test:p2` 验证 runtime、工具执行器、workflow、CLI 配置与状态恢复；
- `test:p3` 使用真实 Docker 验证资源与网络限制、env、cwd、输出截断、路径穿越、symlink escape、超时、取消以及异常清理。

测试结束后确认没有残留容器：

```powershell
docker ps --all --filter "label=devflow.managed=true"
```

输出应只有表头。

## 2. P2 AgentState 真实 CLI 回归

确保项目根目录 `.env` 已配置 `LLM_PROVIDER`、`LLM_MODEL`、`LLM_API_KEY`，并保留：

```env
DEVFLOW_STATE_DIR=.devflow/state
```

从 workspace 子目录启动，以验证状态路径不依赖当前工作目录：

```powershell
Set-Location apps/cli
$fixture = Join-Path $env:TEMP "devflow-calculator-manual"
npm run dev -- --repo C:\path\to\git-repository "Inspect the repository, make one safe change, run tests, and inspect gitDiff."
```

记下 CLI 打印的 `<run-id>`，回到项目根目录检查：

```powershell
Set-Location ../..
$statePath = ".devflow/state/<run-id>.json" //aa2e0b81-9b06-4aeb-b2ee-bdf887000c0e
$statePath = ".devflow/state/aa2e0b81-9b06-4aeb-b2ee-bdf887000c0e.json"
$state = Get-Content -Raw $statePath | ConvertFrom-Json
$state | Select-Object schemaVersion,runId,phase,stepCount,metrics,finalResult,lastError
Get-ChildItem ".devflow/state/aa2e0b81-9b06-4aeb-b2ee-bdf887000c0e.json.*"
```

通过标准：

- CLI 不再出现 `Could not persist AgentState`；
- `phase` 为终态，且存在 `finalResult`；
- `metrics` 包含 `modelCalls`、`toolCalls`、`retries`、`modelLatencyMs`、`toolLatencyMs` 和 `tokenUsage`；
- 最后一条 `Get-ChildItem` 不应发现该 Run 的 `.tmp` 或 `.bak` 文件。

实现会在同目录写临时文件，然后跨平台安全替换正式 JSON。在 Windows 不支持直接覆盖 rename 时，会先保留旧文件，替换完成后再清理备份；替换失败时会尝试恢复旧状态。

## 3. P3 资源和执行边界

执行详细报告：

```powershell
npm run test:p3 -- --reporter=verbose
```

自动断言以下边界：

- Docker `NanoCpus`、memory、memory-swap、PID limit 和 `network=none`；
- 容器级环境变量与命令级环境变量名称、数量和值大小限制；
- `cwd` 必须位于 `/workspace` 的真实路径内；
- stdout/stderr 总捕获量不超过 `maxOutputBytes`，超出时设置 `outputTruncated`；
- `../`、绝对路径和指向 `/workspace` 外部的 symlink 被拒绝；
- 命令超时或取消会终止执行并强制删除整个一次性容器；
- 创建、复制、checkout 任一步骤失败都会清理部分创建的容器。

## 4. Copy 与 Clone

- 本地路径或 `file:` URI 会在校验真实路径属于 `workspaceRoot` 后复制进容器；宿主机 symlink 不能借此逃出允许根目录。
- `https://`、`http://`、`ssh://`、`git://` 和 SCP 风格 Git URI 使用容器内 `git clone`。
- 远程 clone 只有在 `networkEnabled: true` 时允许；默认 CLI 使用 `networkEnabled: false`，因此继续采用本地 repo copy。
- `baseRef` 会经过安全校验，`baseCommit` 只接受 7–64 位十六进制提交 ID。

## 5. 最终通过标准

- `npm run check`、`test:p1`、`test:p2`、`test:p3` 全部通过；
- 真实 CLI 可连续写入同一个 Run 的状态文件并恢复终态；
- 状态文件包含 state、metrics、token、latency 和 result；
- P3 安全与资源集成测试全部通过；
- 测试结束没有 `devflow.managed=true` 的残留容器。

## 当前限制

- 超时或取消会销毁整个一次性 sandbox；当前不尝试在同一容器内继续运行。
- 输出达到上限后会停止捕获但命令仍受 deadline 约束，不会仅因截断立即终止。
- 远程 clone 依赖镜像内 Git 和显式网络权限；凭据注入与托管仓库集成属于后续阶段。
- 修复前遗留的 `.tmp` 文件不会自动删除，以免误删可能用于诊断或恢复的数据。
