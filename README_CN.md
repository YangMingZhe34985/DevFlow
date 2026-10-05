# DevFlow 2.0

[中文](README_CN.md) | [English](README.md)

DevFlow 将仓库任务和 GitHub Issue 转化为可观察、可审批的 AI 工程运行，包含定位、修复规划、代码编辑、确定性测试、定向修复与独立评审。

API 负责持久化意图和入队，Worker 负责执行；Agent 通过受策略约束的工具操作 Docker 沙箱中的代码。Task 锁定不可变基准 commit，Run 保存事件、源码引用、补丁、指标和预算。

## v2.0 的主要变化

- 精简提案式 Planner：修复方向、拟修改文件、验证方式和不确定性；人工审批确定写入范围。
- Localization、Planner、Execute、Repair、Review 分别配置模型，示例默认使用百炼。
- 版本化 TS/JS 文件依赖与导出关系，Execute / Repair 可按需调用有界 `queryRelations`。
- 修改前核对完整文件 SHA，支持精确文本替换和保护文件策略。
- Review 获得当前源码及未修改分支；Repair 可用源码证据回应错误意见，再经过测试和独立 Review。
- 统一请求、恢复和最终输出预算；重复读取、失败调用和无效写入接受进展检测。

最终九题单批严格通过 5/9；其中一题因费用阈值中断，单独续测后通过，九题覆盖中共有 6 题获得严格端到端成功证据。该小型数据集证明限定仓库中的实际修复能力，仍不足以代表任意仓库的成功率，见[验证结果与限制](docs/validation-v2.md)。

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

[.env.example](.env.example) 默认使用百炼兼容接口。Planner 使用 `deepseek-v4-pro-0813`；Execute / Repair 使用 `glm-5.3`；Localization / Review 继承 `LLM_MODEL`。每阶段支持独立 `LLM_<STAGE>_*` 配置，具体模型由用户根据平台和任务选择。见[配置优先级、能力建议及预算](docs/stage-models.md)，修改后重启 Worker。

## 工作流与边界

```text
仓库 + 锁定 Task -> Localization -> Planner -> 计划审批
  -> Execute -> Test -> 有界 Repair / 重测
  -> Review -> 定向修复或证据回应 -> Test -> Review
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
