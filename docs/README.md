# DevFlow 文档入口

当前包版本 **2.4.0**。v3 多 Agent 仍是可关闭的实验实现，不能将开发分支名称当作已发布版本。

| 文档                                                                      | 用途                                                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [历史版本变更溯源书、架构与当前问题](devflow-history-and-architecture.md) | 复习主入口：版本演进、两条迁移路线、重点模块机制、源码入口、分批真实结果和未解决问题。 |
| [autonomous 模式](v4/autonomous-mode.md)                                  | v4 单 Agent 自主求解、宿主验证、分层审查与配置。                                       |
| [v4 进度与评测](v4/PROGRESS.md)                                           | 分阶段实现状态、评测结果及尚未验证的范围。                                             |
| [阶段模型与资源配置](stage-models.md)                                     | 模型继承、统一 Coding、定位模式、费用计价、Review 期限和受控摘要配置。                 |
| [验证与评测使用说明](benchmark-guide.md)                                  | 日常工程/Docker 验证、严格成功标准、实验冻结与同条件对照。                             |
| [ADR-0001：模块边界](decisions/0001-monorepo-and-boundaries.md)           | 保留最初 monorepo/端口式设计决定，附后续演进说明。                                     |

开始运行请看根 [中文 README](../README_CN.md) 或 [English README](../README.md)。应用、[测试](../tests/README.md)、[脚本](../scripts/README.md) 与 [Docker](../docker/README.md) 的 README 保留操作说明，不重复长期历史报告。

原始 [PRG 设计](../PRG：Progressive%20Repository%20Graph%20算法设计.md) 和 [v3 任务书](../DevFlow_v3.0_MultiAgent_Refactor_Brief.md) 保留需求来源；它们的设计意图不等同于当前已验证实现。

旧阶段报告已提取到溯源书后删除。Git 跟踪文件可从清理前保护分支恢复；其他旧文档有本地完整快照。原始实验结果、账本、私有数据和评分材料保持在 Git 忽略目录，不因文档精简而删除。
