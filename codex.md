# DevFlow — UI / Git Base Commit / Adaptive Agent Budget

## Goal

本轮完成三个任务：

1. 优化 Web UI，提升信息层级、可读性和整体完成度。
2. 修复 `baseCommitSha` 缺失导致 GitHub publication 失败的问题，改为自动解析。
3. 移除 Agent 阶段固定 step budget，改为根据任务复杂度和 `Run.maxSteps` 动态分配。

开始修改前先检查现有实现、测试和数据流。不要进行无关重构。

---

# Task 1 — Base Commit 自动解析

难度：低  
优先级：最高

当前问题：

GitHub publication 要求 Task 存在完整 40 字符 `baseCommitSha`，但当前：

- UI 不强制输入；
- 系统也不会自动解析；
- Run 执行完成后才在 Push 阶段报：

`GitHub publication requires a fixed 40-character task base commit SHA.`

这是不完整的产品链路。

## Requirements

创建 Task 时自动确定并固定 `baseCommitSha`。

### LOCAL Repository

优先根据 Task 的 `baseRef`：

```bash
git rev-parse <baseRef>
```

若未指定 `baseRef`：

- 使用当前有效 checkout branch / HEAD；
- 最终必须解析为完整 40 位 commit SHA。

### GitHub Repository

根据：

- repository URL
- baseRef / defaultBranch

解析远端 branch HEAD commit。

平台 GitHub credential 仅允许 Worker / GitHub adapter 使用，禁止暴露给：

- Agent
- LLM
- Web
- API body
- Event
- AgentState

### Persistence

Task 创建成功后必须保存：

```
baseRef
baseCommitSha
```

此后整个 Run 使用固定 SHA。

禁止在 Push 时重新解析最新 HEAD，否则会破坏可复现性。

### Validation

解析失败时：

- Task 创建阶段立即失败；
- 返回明确结构化错误；
- 不允许 Agent 执行数分钟后才在 Push 阶段发现问题。

### UI

Base commit 不再要求用户手填。

显示：

```
Base ref: main
Base commit: a1b2c3d...
```

可提供“重新解析”操作，但创建 Task 后必须固定实际 SHA。

### Tests

覆盖：

- LOCAL main
- LOCAL 非 main branch
- GitHub default branch
- 显式 baseRef
- invalid ref
- unresolved repository
- SHA 为完整 40 位
- Run 期间 branch HEAD 改变不会影响已有 Task

------

# Task 2 — Web UI 优化

难度：中
 优先级：第二

当前 UI 功能完整，但视觉层级较弱、信息密度高、整体偏原型化。

不要重写前端框架，不改变核心交互流程。

## Goals

保持当前深色技术风格，重点改善：

- 页面层级
- 间距
- 卡片组织
- 状态表达
- 操作区域
- 响应式布局
- 长内容展示

## Run Detail

重点优化：

### Header

突出：

- Run title
- status
- repository
- current stage
- duration

减少无关视觉占用。

### Workflow progress

当前：

```
Plan → Approval → Execute → Test → Repair → Review → Diff → Push → PR → Result
```

改进：

- 当前 stage 明显高亮；
- completed / running / failed / skipped 状态视觉区分；
- Failure 应直接定位失败阶段；
- GitHub stages 只在适用时突出。

### Metrics

重新组织：

- Duration
- Steps
- Model Calls
- Tool Calls
- Tokens
- Model Latency
- Tool Latency
- Retries

避免全部指标拥有相同视觉权重。

### Steps / Tools / Events

增强：

- collapsible detail
- compact summary
- success / failure 状态
- duration
- tool name
- stage

避免长页面产生大量重复卡片。

### Diff / Review / Result

提升代码与结构化内容可读性。

Review JSON 不应以原始 JSON 作为主要展示方式。

将其渲染为：

```
Review: PASSED

Summary
...

Findings
...
```

原始 JSON 可作为折叠详情。

### Create Run sidebar

重新整理 Repository / Task / Run 三块输入区域。

减少视觉拥挤，并明确：

```
1 Repository
2 Task
3 Run
```

保持现有功能和 API 不变。

------

# Task 3 — Adaptive Agent Step Budget

难度：高
 优先级：第三

这是本轮最重要的运行时改进。

修改前必须检查：

- Workflow state machine
- Agent Runtime loop
- PLAN structured output
- EXECUTE budget
- REPAIR budget
- REVIEW / REVIEW_REPAIR
- Run.maxSteps
- per-stage accounting
- termination logic

不要直接修改常量。

------

## Problem

当前存在类似：

```
EXECUTE:
min(12, remainingSteps)

REPAIR:
min(4, remainingSteps)
```

这种固定 stage budget。

当：

```
Run.maxSteps = 25
```

时可能勉强合理。

但如果：

```
Run.maxSteps = 100
```

仍限制 EXECUTE 为 12 steps，就无法适配复杂项目。

反之，简单任务也不应该因为 maxSteps=100 就允许 Agent 无限制探索。

------

# Complexity Estimation

不要默认增加一个独立 LLM Agent。

优先复用现有 PLAN 调用，在 PLAN structured output 中增加：

```
complexity: "SIMPLE" | "MEDIUM" | "COMPLEX"

estimatedSteps: number

confidence: number
```

PLAN 已经读取任务目标，因此无需为了复杂度再次调用模型。

如果现有 PLAN 无法可靠完成评估，再说明理由并考虑独立 estimator。

## Complexity factors

评估至少参考：

- task description
- repository size
- relevant file count
- expected changed files
- language / framework
- test availability
- cross-module dependency
- bug / feature / refactor 类型
- 是否需要多轮 test-repair

不要仅按源码总行数判断。

------

# Adaptive Budget

定义：

```
hardLimit = Run.maxSteps
estimatedBudget = PLAN estimatedSteps
```

实际 Run soft budget：

```
softLimit =
min(
  hardLimit,
  estimatedBudget + adaptiveMargin
)
```

例如：

```
SIMPLE
estimated = 8
margin = 4
softLimit = 12

MEDIUM
estimated = 20
margin = 8
softLimit = 28

COMPLEX
estimated = 55
margin = 15
softLimit = 70
```

具体算法由实现根据当前架构确定，不要机械采用以上数字。

核心原则：

```
estimatedSteps
    <
softLimit
    <=
Run.maxSteps
```

`Run.maxSteps` 始终是最终硬限制。

------

# Dynamic Stage Allocation

禁止继续使用：

```
EXECUTE = 12
REPAIR = 4
```

这种固定硬编码。

根据：

- complexity
- estimatedSteps
- remainingSteps
- 当前 workflow progress

动态分配。

例如：

```
PLAN
↓
Budget Planner
↓
EXECUTE budget
TEST deterministic
REPAIR reserve
REVIEW reserve
```

必须预留 Repair / Review 必要预算，禁止 EXECUTE 一次耗尽整个 Run。

同时不要把所有预算提前完全锁死。

允许根据实际进度重新分配未使用预算。

------

# Progress-aware Extension

如果 Agent：

- 已产生有效 diff；
- 持续取得 progress；
- 尚未达到 Run hard limit；
- soft budget 即将耗尽；

允许获得有限 extension。

如果：

- 重复 tool call；
- 重复读取文件；
- diff 长时间无变化；
- 相同 test failure 重复；
- 没有有效进展；

则禁止因为 maxSteps 较大继续浪费预算。

------

# Simple Task Fast Path

对简单任务建立 fast path。

例如：

```
PLAN
→ 定位文件
→ read
→ patch
→ deterministic test
→ review
→ result
```

简单 bug 不应进入几十次 Agent loop。

目标：

```
<200 LOC 简单 fixture
```

正常情况下应显著低于 25 steps。

------

# Budget Accounting

PLAN、EXECUTE、REPAIR、REVIEW_REPAIR 等全部共享：

```
Run.stepBudget
```

禁止进入新 Agent phase 后重置预算。

Metrics 增加：

```
complexity
estimatedSteps
softLimit
hardLimit

planSteps
executeSteps
repairSteps
reviewSteps

unusedSteps
budgetExtensions
```

Web Run Detail 显示：

```
Complexity       SIMPLE
Estimated Steps  8
Budget            12 / 25
Actual Steps      7
```

------

# Failure Semantics

区分：

```
ESTIMATED_BUDGET_EXCEEDED
MAX_STEPS_EXCEEDED
NO_PROGRESS
```

其中 soft limit 不应立即等同于失败。

系统可以：

1. 判断当前 progress；
2. 必要时申请内部 extension；
3. extension 仍不得超过 Run.maxSteps。

------

# Acceptance

## Base Commit

创建 Task 后：

```
baseCommitSha
```

必须自动存在且为完整 40 位 SHA。

无需用户手填。

GitHub publication 不得再因为正常 Task 缺少 SHA 而在末期失败。

------

## UI

确保：

- Run Detail 层级明显改善；
- workflow stage 易于识别；
- FAILED 能快速定位失败阶段；
- Review JSON 有结构化 UI；
- Diff / Metrics / Events 易于阅读；
- 不破坏现有功能。

------

## Adaptive Budget

准备至少：

### SIMPLE

小型单文件 bug。

要求：

- 自动识别 SIMPLE；
- 低 step 完成；
- 不浪费完整 maxSteps。

### MEDIUM

多文件 bug。

要求：

- budget 高于 SIMPLE；
- Test / Repair 有足够预留。

### COMPLEX

较大型项目任务。

运行：

```
maxSteps = 100
```

要求：

- EXECUTE 不再被固定 12 steps 限制；
- 可以根据 estimatedSteps 获得合理预算；
- 总步骤永远不能超过 100。

### Wrong estimation

测试 complexity 判断偏低的情况。

系统应允许有限 adaptive extension，而不是立即失败。

------

# Regression

至少执行：

```
npm run build
npm run test:p1
npm run test:p2
npm run test:p3
npm run test:p5
npm run test:p9
npm run test:p10
npm run test:p11
npm run test:e2e
```

不得破坏：

- Approval
- SSE
- Sandbox
- Test / Repair
- Review
- GitHub Push / PR
- Benchmark

------

# Execution Order

严格按以下顺序实施：

1. Base commit 自动解析
2. UI 优化
3. Adaptive Agent Budget

每完成一个任务先测试，再进入下一个。

Adaptive Budget 修改前必须先给出：

- 当前预算实现
- 固定硬编码位置
- 新预算算法
- 兼容现有 Workflow 的方案

确认方案后再修改运行时。

不要为了本任务引入 LangGraph.js，除非现有架构确实无法实现动态预算，并明确说明必要性。

------

# Deliverables

最终报告保持精简：

1. 修改文件
2. Base commit 自动解析逻辑
3. UI 主要变化
4. 新复杂度评估方式
5. 新 budget algorithm
6. SIMPLE / MEDIUM / COMPLEX 测试结果
7. 修改前后 steps / modelCalls / tokens / latency 对比
8. Regression test 结果

```
这里我特意把你的“任务难度判别 Agent”调整成了**优先复用 PLAN，而不是默认新建一个 Agent**。因为如果新增：

`Task → Complexity Agent → Plan Agent → Execute Agent`

反而又多了一次模型调用，和我们刚刚做的“减少 Agent 调度”目标相冲突。

更理想的是让现有 PLAN 一次返回：

```json
{
  "complexity": "MEDIUM",
  "estimatedSteps": 24,
  "confidence": 0.82,
  "plan": [...]
}
```

然后 Workflow 根据它和用户设置的 `maxSteps` 分预算。这样 `25`、`50`、`100` 都能自然适配，而不再依赖 `12 / 4` 这种固定常量。