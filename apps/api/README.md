# @devflow/api

NestJS 组合根。API 管理 Repository、Task、Run、Approval，并从持久化事件日志提供 SSE；它只负责持久化与入队，不执行 Agent 或 Sandbox。

- `GET /api/v1/health/live`：进程存活。
- `GET /api/v1/health/ready`：实时检查 PostgreSQL 与 Redis，任一不可用时返回 `503`。

Repository、Task、Run、Approval 均提供 JSON REST API。创建 Run 使用可选 `idempotencyKey`，事务落库后才调用 BullMQ queue adapter；API workspace 不依赖 `@devflow/agent` 或 `@devflow/sandbox`。

Run 事件接口：

- `GET /api/v1/runs/:id/events?afterSequence=0&limit=100`：按 sequence 升序读取历史事件；`afterSequence` 是排他游标。
- `GET /api/v1/runs/:id/events/stream?afterSequence=0`：SSE 历史重放与实时流；浏览器重连时 `Last-Event-ID` 优先于查询游标。

每个持久化 SSE 事件的 `id` 等于其 sequence。连接空闲时服务端发送不带 id 的 comment heartbeat；Run 终止后发送 `stream-end`，客户端收到后应关闭 `EventSource`。
