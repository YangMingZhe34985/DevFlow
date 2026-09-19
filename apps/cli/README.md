# @devflow/cli

P1/P2/P3 的独立 Node.js Agent 入口。它负责组合 Vercel AI SDK 模型适配器、可恢复 runtime、受策略控制的 tools、Git 服务和带资源及路径边界的一次性 Docker sandbox。

CLI 总是从 DevFlow 项目根目录加载 `.env`，与当前工作目录无关；运行状态默认写入根目录 `.devflow/state`。Agent 生成的仓库命令只会通过 `SandboxSession` 在容器内执行，不存在宿主机命令回退。

```powershell
npm run dev:cli -- --repo C:\path\to\repository --max-retries 2 "Describe the task"
```
