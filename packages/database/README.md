# @devflow/database

Prisma schema 与首个 migration 已描述 `Repository → Task → Run → Step/ToolCall/Event/Artifact/Approval`。`PrismaDatabaseAdapter` 使用 Prisma 7 PostgreSQL driver adapter，并且只在 API/Worker 组合根显式创建和连接。

当前 adapter 保证：

- Prisma record 不直接作为 API/领域对象；
- Run 内 Event sequence 通过事务内原子计数分配；
- 状态变更与关键事件在同一事务提交；
- 首个 migration 包含非负计数/耗时、Artifact content/uri、Approval resolution time 等数据库 `CHECK`；
- Run 使用 idempotency key、execution owner 与过期 lease 防止重复执行，并支持崩溃恢复；
- 大型日志/diff 转为 Artifact；
- payload 在持久化前完成脱敏与截断。
