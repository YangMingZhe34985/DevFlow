# Scripts

这里只放跨 workspace、无法用 package scripts 清楚表达的跨平台 Node.js 脚本。不要把业务逻辑或宿主机命令执行塞进该目录。

- `run-p1-integration.mjs`：在真实 Docker 中运行 autonomous 执行器。
- `run-p3-integration.mjs`：沙箱验收。
- `run-p5-integration.mjs`：从空库执行 migration，然后验收 API → Queue → Worker → Sandbox → Persistence。
- `run-p9-integration.mjs`：在临时数据库、Redis、真实 Docker 沙箱和无头浏览器中，验收 autonomous Run 的创建、审查与 Diff 展示。
- `run-p10-integration.mjs`：GitHub 审批与发布的持久化。
- `run-postgres-integration.mjs`：Run 所有权和租约，以及经由 RunProcessor 的 autonomous 执行。
- `check-release-files.mjs`：检查 Git 候选文件中的私人路径、疑似凭证，以及 workspace 版本是否一致；不会输出匹配到的凭证值。
- `v4/`：真实模型评测入口，见 [验证与评测使用说明](../docs/benchmark-guide.md)。

研究脚本和付费评测的控制器保留在本地的忽略路径中，不属于公开运行接口。公开测试使用合成夹具，默认不调用付费模型。
