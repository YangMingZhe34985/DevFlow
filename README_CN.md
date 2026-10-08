# DevFlow 2.3

包版本保持 **2.3.0**。代码编辑与失败修复共用持久化的 Coding Session。Resource Budget Scheduler 开发批次严格通过 **1/4**（E07）；E10 已真实派发重新规划、获得新审批并恢复 Coding，但仍未完成修复，**未达到 v2.4 升级条件**。见[资源调度架构](docs/resource-budget-scheduler.md)、[本轮结果及剩余问题](docs/resource-budget-validation-20261008.md)和[此前 v2.3 验收记录](docs/unified-coding-loop-20261008.md)。

后续[E10 Runtime P0 定向修复](docs/e10-runtime-p0-20261008.md)通过原始请求 Docker 回放与工程检查；独立单题真实复测仍因公开测试失败、下游时间预检停止而严格失败（**0/1**），版本继续保持 2.3.0。

[中文](README_CN.md) | [English](README.md)

DevFlow 将仓库任务和 GitHub Issue 转化为可观察、可审批的 AI 工程运行，包含定位、经批准的修复规划、迭代 Coding Loop、确定性最终验证与独立评审。

API 负责持久化意图和入队，Worker 负责执行；Agent 通过受策略约束的工具操作 Docker 沙箱中的代码。Task 锁定不可变基准 commit，Run 保存事件、源码引用、补丁、指标和预算。

## 当前能力

- 精简提案式 Planner：修复方向、拟修改文件、验证方式和不确定性；人工审批确定写入范围。
- Localization、Planner、Coding、Review 分别配置模型，示例默认使用百炼。所有 Coding 迭代统一使用 `EXECUTE` 模型绑定；旧 `REPAIR` 配置仍可读取。
- 版本化 TS/JS 文件依赖与导出关系，以及 Python/Java/C++ 有界静态导航；各阶段共享证据，歧义和不完整关系明确标注。
- 修改前核对完整文件 SHA，支持精确文本替换和保护文件策略。
- Review 保持无工具，可请求宿主进行有界补证和隔离的公开复现；确认的缺陷携带诊断任务、与当前 SHA 关联的证据和经校验的答复，返回同一 Coding Session。
- 公开 build/typecheck/lint/test 验证 profile、源码诊断交接，以及需要新审批的一次有界范围重新规划。
- 同一 Coding Session 在编辑、公开测试失败和 Review 反馈之间保留历史、检查点、工具策略及资源消费。重复观察不算新进展；编辑格式错误与输出纠正共享一次有界纠正额度。
- 稳定补丁仍可在批准范围内继续编辑。`finishPhase` 将候选交给 Workflow 强制执行最终验证；验证失败或明确的未完成事项，在剩余资源允许时返回同一会话。最终 Review 保持独立，见[当前 Coding 生命周期](docs/unified-coding-loop-20261008.md)。
- Run 级 Resource Budget Scheduler：持久化准入与结算，按实际请求和重新规划操作清单估算资源；分别记录逻辑工具、内部执行及 IO，保持硬上限和受保护写入范围。

此前不同版本的九题单批严格通过 5/9；其中一题因费用阈值中断，单独续测后通过，历史九题覆盖中共有 6 题获得严格端到端成功证据。这些不是当前 Scheduler 版本的成绩。该小型数据集证明限定仓库中的实际修复能力，仍不足以代表任意仓库的成功率，见[验证结果与限制](docs/validation-v2.md)。

v2.2 新数据集实验中，E09、E01 在同一冻结批次获得严格成功，E08 在后续单题批次通过。这些记录来自不同版本，不合并为同一批通过率，见[当前实验记录](docs/new-dataset-validation-20261007.md)。

## 快速开始

需要 Node.js >=22.12（CI 使用 24）、npm >=10、Docker 与 Compose。

```bash
git clone https://github.com/YangMingZhe34985/DevFlow.git
cd DevFlow
cp .env.example .env
npm ci
```

PowerShell 使用 `Copy-Item .env.example .env`。在本地 .env 设置 `LLM_API_KEY` 并确认模型及平台配置，不要提交凭证。安装时会自动生成 Prisma Client。

```bash
npm run infra:up
npm run db:migrate:deploy
npm run sandbox:build
npm run dev
```

Web：http://localhost:3000；API：http://localhost:3001/api/v1；Worker 就绪检查：http://localhost:3002/health/ready。通过 `npm run infra:down` 停止基础设施。当前面向本地开发；对不可信网络开放前需补充适合部署环境的认证与授权。

## 分阶段模型

[.env.example](.env.example) 默认使用百炼兼容接口。Planner / Review 使用 `deepseek-v4-pro-0813`；整个 Coding Loop 使用 `glm-5.3`；Localization 继承 `LLM_MODEL`。Coding 使用 `LLM_EXECUTE_*`：开启思考、low 推理强度、8,192 输出 token 和 32,000 上下文 token。独立 Review 使用 high 推理强度、16,384 输出 token 和 64,000 上下文 token。`LLM_REPAIR_*` 保留为旧配置接口，不会创建另一套 Coding Agent，也不改变统一会话的额度。见[配置优先级、能力建议及预算](docs/stage-models.md)，修改后重启 Worker。

## 工作流与边界

```text
仓库 + 锁定 Task -> Localization -> Planner -> 计划审批
  -> Unified Coding Loop：观察 -> 编辑 -> 测试 -> 分析失败 -> 修正
  -> Workflow 最终验证 -> Independent Review
       -> 验证失败 / 确认缺陷 -> 同一 Coding Session
       -> 新增写入范围 -> Planner -> 新计划审批 -> 同一 Coding Session
  -> Diff -> 本地完成或经批准的 GitHub Push / Pull Request
```

提案合法、测试通过和 Issue 修复成立是不同结果。空目标或全 INSPECT 计划不授予写权限；扩大范围需重新审批。Review 默认无工具，由宿主提供当前证据。见[阶段职责、图的用途和保护规则](docs/v2-workflow.md)。

## 仓库结构

- `apps/api`、`web`、`cli`、`worker`：REST/SSE、界面、命令行与编排。
- `packages/agent`、`tools`、`sandbox`：模型运行时、工具策略与隔离执行。
- `packages/shared`、`workflow`、`database`、`git`、`github`、`eval`：契约、持久化、交付和评测。
- `tests`、`docker`、`scripts`、`docs`：公开夹具、基础设施、验证与文档。

旧实验实现、模型原始请求、费用账本、隐藏验收数据与私人接手笔记均排除在 Git 外。生产 Planner 只保留提案协议，已有持久化审批的兼容契约继续保留。

## 开发验证

```bash
npm run check
npm run build
npm run format:check
npm run db:validate
npm run test:e2e
node scripts/check-release-files.mjs
```

Docker 集成需显式启用并配置本地基础设施，普通单元测试不调用付费模型。GitHub 发布默认关闭，需要审批；平台凭证不传入沙箱。

[架构](docs/architecture.md) · [测试说明](tests/README.md) · [脚本说明](scripts/README.md) · [MIT License](LICENSE)
