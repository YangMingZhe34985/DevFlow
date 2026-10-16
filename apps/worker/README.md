# @devflow/worker

Worker 是执行 Run 的组合根。它消费 BullMQ job，通过 PostgreSQL 原子领取执行租约，再交给 `ExecutionModeRouter`：

- **autonomous Run** 由 `AutonomousRunExecutor` 执行：单 Agent 求解、宿主验证、分层审查、检查点和多次尝试；
- **GitHub 推送和 PR 阶段** 由 `GitHubDeliveryExecutor` 完成；
- **已退役模式的历史 Run** 会被拒绝执行，并给出明确错误。

重复的 job 或并发 consumer 无法重复领取同一个 Run。

Worker 支持 BullMQ 重试、持久化的取消轮询、租约续期，以及启动时和周期性的恢复。ioredis 使用 `maxRetriesPerRequest: null`。关闭时先停止领取新 job 并等待活动 job 结束，再依次关闭 Queue、数据库与 Redis。
