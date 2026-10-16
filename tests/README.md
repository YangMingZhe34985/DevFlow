# Tests

- 包级单元测试：`packages/*/tests`。
- 应用单元测试：`apps/*/tests`。
- 跨包集成测试：`tests/integration`。
- Playwright：`tests/e2e`。
- 安全的最小仓库夹具：`tests/fixtures`。

测试、构建与安装命令不允许在宿主机执行 Agent 生成的任意命令；Sandbox 集成测试必须显式启用 Docker。

- `npm run test:p5`：API、数据库、队列、Worker 与 Docker 中的 autonomous 执行。
- `npm run test:p9`：在浏览器中创建 autonomous Run，并展示审查与 Diff。
- `npm run test:p1`、`test:p3`、`test:p10`、`test:postgres`：见 [验证与评测使用说明](../docs/benchmark-guide.md)。
