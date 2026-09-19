# ADR-0001：使用 npm workspaces 与端口式模块边界

- 状态：Accepted
- 日期：2026-09-18

## 决策

项目使用 npm workspaces、TypeScript project references 和统一 ESM。领域核心通过接口（ports）描述；Next.js、NestJS、Prisma、BullMQ、Docker 与模型 SDK 都位于 adapter 或应用组合层。

暂不引入 Nx/Turborepo、LangGraph、多 Agent、MCP 或 RAG。现阶段 workspace 数量和构建图可由 TypeScript references 管理，等真实瓶颈出现后再增加编排层。

## 原因

- 减少初始化阶段的工具链和缓存复杂度；
- 让核心运行时可在 CLI、Worker 和测试中复用；
- 保持安全边界可审计，避免框架对象渗入领域层；
- 符合先验证单 Agent 核心路径、再扩展平台能力的优先级。

## 后果

- 内部 workspace 必须显式声明真实依赖并维护 project reference；
- Node ESM 源码中的相对导入使用 `.js` 后缀；
- 构建使用 `tsc -b`，Web 由 Next.js 单独构建；
- 若未来引入任务编排器，应保留当前 package scripts 作为稳定接口。
