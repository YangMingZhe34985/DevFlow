# DevFlow 文档入口

当前版本 **4.0.0**：单 Agent 自主求解、宿主验证与分层独立审查。旧的 workflow / team / single 路径和 PRG 已在 v4 Phase 4 退役，退役前的代码可从 Git 标签 `v4-pre-retirement` 找回。

| 文档                                                            | 用途                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| [autonomous 模式](v4/autonomous-mode.md)                        | 求解、验证、分层审查、多次尝试、检查点与配置。                 |
| [v4 进度与评测](v4/PROGRESS.md)                                 | 分阶段实现状态、评测结果和尚未验证的范围。                     |
| [v4 待办缺陷](v4/BACKLOG.md)                                    | 已证实、暂未处理的策略缺口与改进项。                           |
| [模型配置](stage-models.md)                                     | 求解与审查两个模型绑定、审查覆盖值、价格和 Run 硬限。          |
| [验证与评测使用说明](benchmark-guide.md)                        | 日常工程与集成验证、真实模型评测入口、严格成功标准与批次冻结。 |
| [ADR-0001：模块边界](decisions/0001-monorepo-and-boundaries.md) | npm workspaces 与端口式模块边界的原始决定。                    |

开始运行请看根目录的 [中文 README](../README_CN.md) 或 [English README](../README.md)。应用、[测试](../tests/README.md)、[脚本](../scripts/README.md) 与 [Docker](../docker/README.md) 的 README 只保留操作说明。

原始实验结果、费用账本、私有评测数据、评分材料，以及退役设计的历史文档，都保存在被 Git 忽略的本地目录中。
