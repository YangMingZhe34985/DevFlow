# P6–P9 手工验收指南

本轮验收重点是浏览器中的完整链路：

`Task → Plan → Approval → Execute → Test/Repair → Review → Result`

## 1. 启动依赖

在仓库根目录准备 `.env`，至少配置：

```dotenv
DATABASE_URL=postgresql://devflow:devflow@localhost:5432/devflow?schema=public
REDIS_URL=redis://localhost:6379
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api/v1
CORS_ORIGINS=http://localhost:3000
LLM_PROVIDER=openai
LLM_MODEL=<可用模型>
LLM_API_KEY=<API Key>
```

然后执行：

```powershell
npm install
npm run infra:up
npm run db:migrate:deploy
npm run sandbox:build
npm run build
```

迁移会从空数据库依次创建 P4–P5 基础结构及 P6–P9 工作流字段、约束。

## 2. 启动应用

```powershell
npm run dev
```

预期：Web 为 `http://localhost:3000`，API 为 `http://localhost:3001/api/v1`，Worker health 为 `http://localhost:3002/health`。

## 3. 浏览器 E2E

1. 打开 `http://localhost:3000`。
2. 创建 Repository。LOCAL 来源填写一个存在的 Git 项目绝对路径。
3. 创建 Task，填写明确需求和验收条件。
4. 创建 Run；页面会自动进入 `/runs/<runId>`。
5. 等待状态变为 `WAITING_APPROVAL`，确认页面出现结构化 Plan 和 pending Approval。
6. 此时确认尚无代码执行：步骤中不应出现 WRITE/EXECUTE 工具。可选执行 `docker ps --filter "label=devflow.managed=true"`，预期没有该 Run 的沙箱。
7. 输入拒绝反馈并点击“拒绝并重新规划”。预期旧 Approval 为 `REJECTED`，生成新 Plan，再次进入 `WAITING_APPROVAL`。
8. 点击“批准并继续”。预期产生 `PLAN_APPROVED`，Run 使用新的 dispatch revision 重新入队，然后进入 `EXECUTE`。
9. 观察事件区。若首次测试失败，应依次出现 `TEST_RESULT(ok=false)`、`REPAIR_STARTED`、修复步骤和新的测试；测试成功后退出 repair loop。
10. 观察独立 Review。预期 Review 使用独立调用、没有写工具，并产生 `REVIEW_REPORT`。
11. 最终预期状态为 `SUCCEEDED`；页面完整展示 Steps、Tool Calls、事件、Metrics、Diff、Review 与 Result。

若测试在 `maxTestRetries` 次修复后仍失败，预期 Run 为 `FAILED`，错误详情包含 `workflowCode=TEST_FAILED`，且不会进入 Review。

## 4. SSE 重连检查

先读取历史事件：

```powershell
$runId = "<runId>"
Invoke-RestMethod "http://localhost:3001/api/v1/runs/$runId/events?afterSequence=0&limit=500"
```

刷新详情页或点击“重新连接”。预期：

- 服务端以持久化 `sequence` 作为 SSE id；
- `Last-Event-ID` 或 `afterSequence` 只重放游标之后的事件；
- 浏览器按 sequence 去重、升序展示；
- heartbeat 不推进游标；
- Run 终态后收到 `stream-end` 并正常关闭，不重复事件。

## 5. 自动化验收

```powershell
npm run lint
npm run typecheck
npm run test
npm run test:p1
npm run test:p2
npm run test:p3
npm run test:p5
npm run test:p9
```

`test:p9` 会启动临时 PostgreSQL/Redis、从空库执行 migration，启动真实 API、BullMQ Worker、Next.js 和无头浏览器，并在真实 Docker Sandbox 中验证审批前不执行、Reject/replan、测试修复、独立 Review、终态失败上限、连续 Event sequence 和资源清理。

自动化测试使用脚本化 Fake Model，不需要外部 LLM Key；手工验收使用 `.env` 中配置的真实模型。

## 6. 清理

```powershell
npm run infra:down
docker ps --all --filter "label=devflow.managed=true"
```

预期第二条命令没有输出。`infra:down` 不删除 PostgreSQL/Redis 数据卷。
