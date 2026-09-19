# Tests

- 包级单元测试：`packages/*/tests`。
- 应用单元测试：`apps/*/tests`。
- 跨包集成测试：`tests/integration`。
- Playwright：`tests/e2e`。
- 安全的最小仓库夹具：`tests/fixtures`。

测试、构建与安装命令不允许在宿主机执行 Agent 生成的任意命令；Sandbox 集成测试必须显式启用 Docker。

- `npm run test:p5`：P4–P5 API、数据库、队列、Worker 与 Docker Agent 集成。
- `npm run test:p9`：P6–P9 浏览器 UI、SSE、审批、修复循环与独立 Review 集成。
