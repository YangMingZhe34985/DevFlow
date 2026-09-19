# P2 Runtime / Tool Abstraction 手工验收指南

本指南验证 P2 新增的根目录配置加载、Windows Unicode 输出、工具执行边界、AgentState 检查点以及 token、latency、retry 指标，同时回归 P1 Docker 修复链路。

## 1. 自动化验收

在项目根目录执行：

```powershell
npm install
npm run check
npm run test:p2
docker desktop start
npm run test:p1
```

验收点：

- `test:p2` 覆盖 AgentState JSON/文件持久化与恢复、模型 retry/指标、工具 validation/policy/timeout/error/event、runtime 取消以及 workflow 失败/取消。
- `test:p1` 使用 Fake 模型在真实 Docker 容器内修复 calculator，验证测试、Git diff、Unicode 输出和成功/失败清理路径。
- 所有自动化测试都不会调用真实 LLM。

## 2. 根目录 `.env` 自动加载

只在项目根目录创建 `.env`：

```powershell
Copy-Item .env.example .env
```

填写真实配置：

```env
LLM_PROVIDER=openai
LLM_MODEL=<model>
LLM_API_KEY=<api-key>

DEVFLOW_MAX_STEPS=25
DEVFLOW_MAX_RETRIES=2
DEVFLOW_TIMEOUT_MS=900000
DEVFLOW_STATE_DIR=.devflow/state
```

OpenAI-compatible 服务还需：

```env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=<provider-base-url>
LLM_PROVIDER_NAME=<provider-name>
```

清除 PowerShell 会话中可能残留的同名变量，并从 `apps/cli` 目录启动：

```powershell
Remove-Item Env:LLM_PROVIDER,Env:LLM_MODEL,Env:LLM_API_KEY -ErrorAction SilentlyContinue
Set-Location apps/cli
npm run dev -- --repo C:\path\to\git-repository "Inspect the repository, make a small safe fix, run tests, and inspect gitDiff."
```

CLI 根据自身模块位置加载项目根目录 `.env`，而不是从当前工作目录查找。如果没有出现 `LLM_PROVIDER`、`LLM_MODEL` 或 `LLM_API_KEY` 缺失错误，即证明根目录配置加载成功。

## 3. Windows Unicode 验收

CLI、Docker 镜像和命令捕获均显式使用 UTF-8。运行包含中文文件名、中文任务或中文测试输出的仓库，确认终端内容没有出现 `锟斤拷` 或替换字符 `�`。

较旧的 Windows PowerShell 可在运行前额外设置终端编码：

```powershell
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
```

Docker 集成测试还会直接断言容器输出 `测试通过：你好，DevFlow 🚀` 能逐字还原。

## 4. 状态与指标验收

每次 CLI 运行都会把版本化状态写到：

```text
.devflow/state/<run-id>.json
```

打开终态文件，确认包含：

- `schemaVersion: 1`；
- `phase` 与 `stepCount`；
- 可恢复的 `messages`；
- `metrics.modelCalls`、`toolCalls`、`retries`；
- `modelLatencyMs`、`toolLatencyMs`；
- `tokenUsage.inputTokens/outputTokens/totalTokens`；
- `finalResult` 或失败时的 `lastError`。

CLI 最后一行也会打印 steps、modelCalls、retries、tools 与两类 latency。自动化测试会把终态放入新的 runtime，确认不会再次调用模型。

## 5. 工具执行器验收

执行：

```powershell
npx vitest run packages/tools/tests/executor.test.ts --reporter=verbose
```

应看到以下场景全部通过：

- schema validation 返回 `VALIDATION_ERROR`；
- 未授权权限返回 `PERMISSION_DENIED`；
- 即便工具忽略 `AbortSignal`，deadline 仍返回 `TIMEOUT`；
- 普通异常规范化为 `TOOL_FAILED`；
- caller cancellation 返回 `CANCELLED` 且不启动工具；
- 每次已识别调用产生相关联的 `TOOL_CALL`、`TOOL_RESULT` 事件。

## 6. P2 通过标准

以下条件需同时满足：

- `npm run check`、`npm run test:p2`、`npm run test:p1` 全部通过；
- 从 `apps/cli` 启动时能读取根目录 `.env`；
- 中文与 emoji 在 CLI 和 Docker 输出中保持完整；
- 工具的 validation、policy、timeout、error、event 测试通过；
- AgentState 可以序列化、写盘、读取，并恢复终态结果；
- retry、token 和 latency 指标出现在状态文件与 CLI 汇总中；
- P1 calculator 修复、测试、diff 和容器清理无回归。

## 当前限制

- CLI 每次仍创建新的 run/sandbox；跨进程恢复非终态运行需要后续结合持久化 sandbox/checkpoint identity，属于 P4。
- retry 目前按错误可重试属性执行固定次数，没有指数退避或 provider-specific 分类。
- Workflow P2 只提供可序列化状态以及显式失败/取消转换；完整审批、测试/修复和 review 编排仍属于 P8。
- 文件状态可能包含模型消息与工具结果，应使用受保护的状态目录；集中脱敏与数据库持久化属于后续阶段。
