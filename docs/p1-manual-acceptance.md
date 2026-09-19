# P1 真实 LLM 手工验收指南

本指南验证一条完整且一次性的执行链路：真实模型调用工具，Docker 容器读取和修改仓库，在容器内运行测试，打印 Git diff，最后删除容器。Agent 不会修改传入的宿主机仓库；仓库会被复制到容器的 `/workspace`。

## 1. 前置条件

- Node.js 22.12+ 与 npm 10+
- Docker daemon 正在运行
- 一个支持 tool calling 的模型及其 API 凭据

在项目根目录安装依赖并构建沙箱镜像：

```powershell
npm install
npm run sandbox:build
```

先运行不访问真实模型的自动化验收：

```powershell
npm test
npm run test:p1
```

`npm test` 运行确定性单元测试；`npm run test:p1` 构建镜像并运行真实 Docker 夹具修复测试。后一个命令必须显示 calculator 测试通过、Git diff 断言通过，并且两个容器清理用例通过。

已有镜像时 `test:p1` 会直接复用，以避免无关的 registry 网络抖动。需要强制重建可先设置 `DEVFLOW_REBUILD_SANDBOX=1`。

## 2. 配置模型

复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

OpenAI 官方接口：

```env
LLM_PROVIDER=openai
LLM_MODEL=<model>
LLM_API_KEY=<api-key>
LLM_BASE_URL=
```

OpenAI-compatible 接口：

```env
LLM_PROVIDER=openai-compatible
LLM_MODEL=<model>
LLM_API_KEY=<api-key>
LLM_BASE_URL=<provider-base-url-usually-ending-in-v1>
LLM_PROVIDER_NAME=<short-provider-name>
```

`.env` 已被 Git 忽略。模型密钥只由 CLI 进程使用，不会传进 Docker 容器。当前 P1 内置支持 `openai` 和 `openai-compatible`；如供应商不是 OpenAI-compatible，需要在 `packages/agent/src/vercel-ai-model.ts` 的 `createConfiguredLanguageModel` 中增加对应的 Vercel AI SDK provider，并同步扩展 `LLM_PROVIDER` 校验。

## 3. 准备确定性手工夹具

夹具本身不会携带嵌套 `.git`。复制一份并创建基线提交：

```powershell
$fixture = Join-Path $env:TEMP "devflow-calculator-manual"
if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
Copy-Item -LiteralPath "tests/fixtures/calculator-bug" -Destination $fixture -Recurse
git -C $fixture init -b main
git -C $fixture config user.email "fixture@devflow.local"
git -C $fixture config user.name "DevFlow Fixture"
git -C $fixture add .
git -C $fixture commit -m "fixture baseline"
```

基线测试应失败；这是预期的夹具初始状态：

```powershell
npm --prefix $fixture test
```

## 4. 启动真实 Agent

精确命令：

```powershell
npm run dev:cli -- --repo $fixture --max-steps 15 --timeout-ms 300000 "Fix the bug causing the calculator tests to fail. Inspect the code and tests first, make the smallest fix, run the tests, and inspect gitDiff before completing."
```

预期执行流：

1. CLI 创建名为 `devflow-<run-id>` 的容器并把夹具复制到 `/workspace`。
2. 模型调用 `listFiles`、`readFile` 或 `searchCode` 定位问题。
3. `writeFile` 或 `applyPatch` 经显式 WRITE 策略修改容器内文件。
4. `runCommand` 经显式 EXECUTE 策略运行 `npm test`。
5. 终端打印命令的退出码和测试输出；应看到失败被修复且测试通过。
6. 模型调用 `gitStatus`/`gitDiff`，CLI 最后再次打印完整 tracked Git diff。
7. 无论成功、失败、超时或 Ctrl+C，CLI 都执行容器清理。

运行期间可以在另一个终端确认命令位于 Docker：

```powershell
docker ps --filter "label=devflow.runId=<terminal-shown-run-id>"
```

运行结束后，同一查询应为空：

```powershell
docker ps -a --filter "label=devflow.runId=<terminal-shown-run-id>"
```

## 5. 通过标准

P1 手工验收通过需要同时满足：

- 终端出现 `listFiles`/`readFile`、写工具、`runCommand` 和 `gitDiff` 的调用记录；
- `runCommand` 的 `exit=0`，并显示 calculator 两个测试通过；
- `=== Final Git Diff ===` 包含 `return left + right` 改为 `return left - right`；
- 最终状态为 `SUCCEEDED`；
- `docker ps -a` 找不到该 run label 的容器；
- 宿主机夹具仍是原始失败版本，证明修改只发生在一次性沙箱副本中。

建议把一次完整输出保留下来：

```powershell
npm run dev:cli -- --repo $fixture "Fix the bug causing the calculator tests to fail; run tests and inspect gitDiff." 2>&1 | Tee-Object p1-manual-run.log
```

## 已知 P1 限制

- 模型调用为非流式；没有持久化运行记录或审批 UI。
- 权限策略是 CLI 组合根中的显式内存策略，不是 P2 的持久化审批。
- 沙箱只实现 P1 基本资源限制与相对路径校验；完整的 symlink 防逃逸、网络白名单和生命周期恢复属于 P3。
- P1 的命令工具尚未实现 P3 级秘密文件过滤；只应传入不含生产密钥、私有凭据或敏感数据的验收仓库。
- diff 只在容器销毁前打印到终端，不会自动写回宿主机，也不会创建 commit/PR。
