# DevFlow 2.4.0

[中文](README_CN.md) | [English](README.md)

DevFlow 把仓库任务和 GitHub Issue 交给一个自主 Agent 修复，并让整个过程可观察、可审计。

- **求解**：Agent 在隔离的 Docker 沙箱中自行决定探索、编辑、运行测试和提交。
- **验证与审查**：宿主独立复跑公开检查，再由独立的 Reviewer 分层审查。
- **交付**：GitHub 推送和 Pull Request 都必须经过人工审批。

当前架构为 v4 autonomous，设计见 [autonomous 模式说明](docs/v4/autonomous-mode.md)，演进过程见 [v4 进度](docs/v4/PROGRESS.md)。旧的 workflow / team / single 执行路径和 PRG 定位已在 Phase 4 退役。这些模式下的历史 Run 仍可读取，但不能再执行。

## 评测结果

| 评测集                                                     | 结果                          | 每题平均费用 |
| ---------------------------------------------------------- | ----------------------------- | ------------ |
| 合成回归集 E01–E10                                         | 补丁严格通过 10/10（Phase 2） | 约 ¥1.6–2.2  |
| 外部留出集（SWE-bench Verified 15 题 + Multilingual 5 题） | 官方验收通过 13/20（65%）     | ¥1.32        |

- **退役前的旧 workflow 路径**：同一合成集上的最好成绩为 5/10。
- **外部集口径**：每题只跑 1 次，样本小，置信区间较宽。
- **模型**：求解使用 GLM-5.3，审查使用 DeepSeek-v4-pro。
- **详细结果**：逐题结果和失败分析见 [v4 进度](docs/v4/PROGRESS.md)；已知的策略缺口见 [BACKLOG](docs/v4/BACKLOG.md)。

## 工作方式

```text
仓库 + 锁定基准 commit 的 Task
  -> Agent 自主求解（bash / read_file / edit_file / submit）
  -> 宿主复跑公开检查（自动发现 build / typecheck / lint / test）
       -> 失败：反馈回同一会话修订
  -> 分层独立审查：第 1 层无工具初审，出现具体疑点才进入第 2 层有界核查
       -> 判 FAIL：回到同一会话修订
       -> 结论不成立：换新沙箱再尝试，共享同一份费用、轮数和时间上限
  -> Diff -> LOCAL 仓库直接完成；GIT 仓库进入 Push 审批 -> PR 审批
```

### 主要边界

- **资源上限**：每个 Run 有费用、轮数和截止时间三项硬上限。尚未确认的模型调用按最坏情况计费。
- **受保护路径**：Agent 不能修改 `.git/` 和 `.github/workflows/`。
- **凭证与审批**：GitHub 凭证只在平台侧使用，不进入沙箱或提示词；写操作默认关闭，需要显式开启并审批。

## 快速开始

需要 Node.js >=22.12（CI 使用 24）、npm >=10、Docker 与 Compose。

```bash
git clone https://github.com/YangMingZhe34985/DevFlow.git
cd DevFlow
cp .env.example .env
npm ci
```

- **复制配置**：PowerShell 使用 `Copy-Item .env.example .env`。
- **填写凭证**：在本地 `.env` 中设置 `LLM_API_KEY`，并确认模型配置。不要提交凭证。

```bash
npm run infra:up
npm run db:migrate:deploy
npm run sandbox:build
npm run dev
```

| 服务            | 地址                               |
| --------------- | ---------------------------------- |
| Web             | http://localhost:3000              |
| API             | http://localhost:3001/api/v1       |
| Worker 就绪检查 | http://localhost:3002/health/ready |

停止基础设施：`npm run infra:down`。

当前面向本地开发。对不可信网络开放之前，需要先补充适合部署环境的认证与授权。

命令行可以直接在本地仓库上运行同一个 Agent 内核：

```bash
npm run dev:cli -- --repo <path> "<task>"
```

## 模型配置

[.env.example](.env.example) 默认使用百炼的 OpenAI 兼容接口，共两个模型绑定：

| 绑定            | 用途          | 默认模型               | 推理强度 | 输出上限 |
| --------------- | ------------- | ---------------------- | -------- | -------- |
| `LLM_EXECUTE_*` | 求解 Agent    | `glm-5.3`              | low      | 8,192    |
| `LLM_REVIEW_*`  | 独立 Reviewer | `deepseek-v4-pro-0813` | high     | 16,384   |

审查的分层设置由 `DEVFLOW_AUTONOMOUS_REVIEW_*` 覆盖，详见[模型配置](docs/stage-models.md)。修改配置后需要重启 Worker。

## 仓库结构

- **应用**：`apps/api`（REST/SSE）、`apps/web`（界面）、`apps/cli`（命令行）、`apps/worker`（执行与交付）。
- **基础包**：
  - `packages/agent`：模型适配与 Agent 内核；
  - `packages/tools`：ACI 工具；
  - `packages/sandbox`：Docker 沙箱与仓库快照；
  - `packages/database`：持久化；
  - `packages/github`：GitHub 交付；
  - `packages/shared`：共享契约。
- **评测与配套**：
  - `scripts/v4`：E01–E10 与外部留出集的评测入口；
  - `tests`：单元与集成测试；
  - `docker`：基础设施；
  - `docs`：文档。

模型原始请求、费用账本、隐藏验收数据和本地实验材料都不进入 Git。

## 开发验证

```bash
npm run check
npm run build
npm run format:check
npm run db:validate
npm run test:e2e
node scripts/check-release-files.mjs
```

- **集成测试**：需要 Docker 或 PostgreSQL，包括 `npm run test:p1`、`test:p3`、`test:p5`、`test:p9`、`test:p10`、`test:postgres`。这些命令会自行启动和清理所需的基础设施。
- **费用**：单元测试和集成测试都使用模拟模型，不调用付费模型。

[架构与历史](docs/devflow-history-and-architecture.md) · [测试说明](tests/README.md) · [脚本说明](scripts/README.md) · [MIT License](LICENSE)
