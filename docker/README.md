# Docker

- `compose.yml`：本地平台依赖（带健康检查和持久卷的 PostgreSQL、Redis）。
- `sandbox/Dockerfile`：未来每个 Agent Run 的基础镜像。

二者用途不同：停止 Compose 不代表已经清理 Run sandbox，Worker 必须负责后者的确定性回收。

进入可复现评估阶段前，PostgreSQL、Redis 与 Sandbox 基础镜像都应锁定 patch 版本或 image digest；初始化阶段暂用稳定系列标签方便开发。
