# 初始化后的开发路线图

每个 TODO 使用 `TODO(Pn-area)` 标记，对应《项目说明》的阶段。建议按下面顺序推进，始终保持一个可验证的小里程碑。

## P1 — CLI Agent Prototype

- 实现一个 Vercel AI SDK `LanguageModelPort` adapter。
- 在 Docker Sandbox 中实现只读工具，再实现带策略的写工具。
- 完成 LLM → tool call → result 循环、maxSteps、deadline 与取消。
- 使用小型 fixture 仓库证明可修复测试并输出 git diff。

## P2 — Runtime / Tool Abstraction

- 实现 `DefaultToolExecutor`：schema、policy、timeout、structured error、event。
- 持久化/序列化 `AgentState`，补齐 token、latency、retry 指标。
- 建立 runtime、tools、workflow 的错误与取消测试。

## P3 — Docker Sandbox

- 实现容器创建、repo copy/clone、执行、回收与异常清理。
- 加入 CPU、内存、PID、网络、env、cwd 和输出限制。
- 针对路径穿越、symlink escape、超时与残留容器增加集成测试。

## P4–P5 — API / Persistence / Queue

- 创建首个 Prisma migration 与 repository adapters。
- 实现 Repository、Task、Run、Approval REST API。
- API 只 enqueue，Worker 才执行；实现幂等 job、retry、cancel 与 recovery。

## P6–P9 — UI / SSE / Approval / Repair Loop

- 优先实现 Run Detail，不先做视觉包装。
- 用持久化 Event + SSE 支持断线重放。
- 计划审批后才能执行；拒绝时重新规划。
- 实现测试失败修复循环、最大次数与独立 review。

## P10–P11 — GitHub / Evaluation

- 凭据由平台注入，不传给 Agent；push/PR 必须审批。
- Benchmark 固定 repository、base commit、task 与 evaluation command。
- 记录成功率、测试、steps、tools、tokens、cost、latency 与 retry。
