# @devflow/cli

本地命令行入口，在 Docker 沙箱中运行与 Worker 相同的 Agent 内核（`runAgentLoop`），使用四个 ACI 工具：`bash`、`read_file`、`edit_file`、`submit`。结束时打印 git diff 和用量。

CLI 总是从 DevFlow 项目根目录加载 `.env`，与当前工作目录无关；模型由 `LLM_PROVIDER`、`LLM_MODEL`、`LLM_API_KEY` 和 `LLM_BASE_URL` 配置。Agent 的命令只通过 `SandboxSession` 在容器内执行，不存在退回到宿主机执行的路径。

```powershell
npm run dev:cli -- --repo C:\path\to\repository --max-turns 40 "Describe the task"
```

CLI 不做宿主验证、审查或交付，这些只在 Worker 中进行。
