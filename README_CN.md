# DevFlow 2.4.0

当前包版本为 **2.4.0**。执行模式默认仍为 `workflow`。PRG 为可选定位模式，定位默认仍为 legacy；动态多 Agent 为默认关闭的实验功能，尚未达到 v3.0 发布门槛。

项目复习与历史追溯请阅读[版本变更、架构与当前问题](docs/devflow-history-and-architecture.md)，操作文档见[文档入口](docs/README.md)。旧 workflow 十题冻结批次严格通过 5/10；其后五题定向修复中 E07 严格通过，E01 补丁独立验收通过但 Review 被费用预检阻断，其余未严格通过。另行进行的 v4 autonomous Phase 2 十题补丁验收通过 10/10，Review PASS 为 7/10；后续分层审查复测已运行的三题补丁与 Review 均通过，另外两题为 NOT_RUN。各批次口径与结果见 [v4 进度](docs/v4/PROGRESS.md)，不能合并为一个成功率。真实有效 AgentMessage 仍为 0，显式通信闭环尚未获得真实验证。

[中文](README_CN.md) | [English](README.md)

DevFlow 将仓库任务和 GitHub Issue 转化为可观察、可审批的 AI 工程运行，包含定位、经批准的修复规划、迭代 Coding Loop、确定性最终验证与独立评审。

API 负责持久化意图和入队，Worker 负责执行；Agent 通过受策略约束的工具操作 Docker 沙箱中的代码。Task 锁定不可变基准 commit，Run 保存事件、源码引用、补丁、指标和预算。

可选择 [`autonomous` 模式](docs/v4/autonomous-mode.md)：单个 Agent 自主决定探索、编辑和提交，宿主独立执行公开检查与保护路径验证，再进行分层审查。第 1 层为无工具初审，只有出现具体疑点才启动有界工具核查；验证失败或阻断性审查问题在剩余额度内返回同一求解会话。默认仍为 `workflow`；下方阶段式能力和工作流描述适用于该路径。

## 当前能力

- 精简提案式 Planner：修复方向、拟修改文件、验证方式和不确定性；人工审批确定写入范围。
- Localization、Planner、Coding、Review 分别配置模型，示例默认使用百炼。所有 Coding 迭代统一使用 `EXECUTE` 模型绑定；旧 `REPAIR` 配置仍可读取。
- 版本化 TS/JS 文件依赖与导出关系，以及 Python/Java/C++ 有界静态导航；各阶段共享证据，歧义和不完整关系明确标注。
- 修改前核对完整文件 SHA，支持精确文本替换和保护文件策略。
- Review 保持无工具，可请求宿主进行有界补证和隔离的公开复现；确认的缺陷携带诊断任务、与当前 SHA 关联的证据和经校验的答复，返回同一 Coding Session。
- 公开 build/typecheck/lint/test 验证 profile、源码诊断交接，以及需要新审批的一次有界范围重新规划。
- 同一 Coding Session 在编辑、公开测试失败和 Review 反馈之间保留历史、检查点、工具策略及资源消费。重复观察不算新进展；编辑格式、工具参数和输出纠正共享一次有界纠正额度。
- 稳定补丁仍可在批准范围内继续编辑。`finishPhase` 将候选交给 Workflow 强制执行最终验证；验证失败或明确的未完成事项，在剩余资源允许时返回同一会话。最终 Review 保持独立，见[当前 Coding 生命周期](docs/devflow-history-and-architecture.md)。
- Run 级 Resource Budget Scheduler：持久化准入与结算，按实际请求和重新规划操作清单估算资源；分别记录逻辑工具、内部执行及 IO，保持硬上限和受保护写入范围。

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

提案合法、测试通过和 Issue 修复成立是不同结果。空目标或全 INSPECT 计划不授予写权限；扩大范围需重新审批。Review 默认无工具，由宿主提供当前证据。见[阶段职责、图的用途和保护规则](docs/devflow-history-and-architecture.md)。

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

[架构](docs/devflow-history-and-architecture.md) · [测试说明](tests/README.md) · [脚本说明](scripts/README.md) · [MIT License](LICENSE)
