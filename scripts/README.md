# Scripts

这里只放跨 workspace 且 package scripts 无法清晰表达的跨平台 Node.js 脚本。不要把业务逻辑或宿主机命令执行塞进该目录。

- `run-p1-integration.mjs` / `run-p3-integration.mjs`：Docker Agent 与 Sandbox 验收。
- `run-p5-integration.mjs`：空库 migration 及 API → Queue → Worker → Sandbox → Persistence 验收。
- `run-p9-integration.mjs`：临时数据库、Redis、真实 Docker Sandbox 和无头浏览器中的 Approval → Repair → Review 验收。
