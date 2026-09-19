# @devflow/web

Next.js App Router 前端。Repository/Task/Run/Approval API 与 SSE 都由 NestJS API 提供，Web 不建立第二套业务后端。

`NEXT_PUBLIC_API_BASE_URL` 会在构建时固化；容器内 Server Component 若需访问 API，应使用仅服务端的 `API_INTERNAL_BASE_URL`。

## 页面

- `/`：工作台，可创建 Repository、Task 和 Run，并选择历史 Run。
- `/runs/:runId`：可直达的 Run Detail，展示计划/审批、步骤、工具调用、测试/修复、事件、指标、diff、review 和最终结果。

Run Detail 先读取 `GET /runs/:id/detail` 快照，再分页重放 `GET /runs/:id/events` 历史，最后连接 `GET /runs/:id/events/stream`。浏览器以 `sequence` 去重排序；SSE 断线后会带上已确认的 `afterSequence` 退避重连。

## 本地运行

```powershell
npm run dev:web
```

默认 API 地址为 `http://localhost:3001/api/v1`，可通过 `NEXT_PUBLIC_API_BASE_URL` 覆盖。
