# @devflow/worker

Worker 是真正执行 Agent Run 的组合根。它消费 BullMQ job，先通过 PostgreSQL 原子领取 execution lease，再组合 Runtime、Workflow 状态转换、Tools 与 Docker Sandbox。重复 job 或并发 consumer 无法重复领取同一个 Run。

Worker 支持 BullMQ retry、持久化取消轮询、租约续期和启动/周期 recovery。ioredis 使用 `maxRetriesPerRequest: null`；关闭时先停止取新 job并等待活动 job，再关闭 Queue、数据库与 Redis。
