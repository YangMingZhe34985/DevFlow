# PRG：Progressive Repository Graph 算法设计

**适用项目：** DevFlow v2.4
**模块：** Issue Localization
**算法名称：** Progressive Repository Graph（渐进式仓库图）

## 1. 核心思想

PRG 的目标是解决大型代码仓库中，GitHub Issue 仅包含抽象错误现象、缺少文件路径或函数名称时的代码定位问题。

**核心策略：全仓轻量建骨架、语义驱动寻找入口、按需解析代码关系、增量补全仓库图、证据驱动定位根因。**

不在初始化时构建完整调用图，也不要求 LLM 阅读整个仓库，而是采用渐进式构图：

1. **全局初始化：** 使用确定性程序构建完整的目录、文件结构及低成本可验证关系。
2. **Issue 语义理解：** Localization Agent 分析问题现象，生成业务行为描述与多个检索方向。
3. **分层定位：** 从仓库模块逐步深入文件、符号和源码，保留多个候选区域。
4. **按需补图：** 对相关区域使用 AST、语言解析器或 LSP 解析真实关系，并增量更新图。
5. **证据收敛：** Agent 根据新增证据修订根因假设，直到证据充分或探索预算耗尽。

## 2. 推荐数据结构

### 2.1 Repository Graph（共享仓库图）

采用 **分层目录树 + 稀疏关系图**，不要求初始化时每个文件之间都有边。

**节点 GraphNode**

| 字段        | 含义                                                   |
| ----------- | ------------------------------------------------------ |
| `id`        | 稳定节点标识                                           |
| `kind`      | REPOSITORY / DIRECTORY / MODULE / FILE / SYMBOL / TEST |
| `path`      | 仓库相对路径                                           |
| `name`      | 文件、目录或符号名称                                   |
| `sourceSha` | 对应源码内容身份（适用时）                             |
| `coverage`  | 当前索引及关系解析覆盖状态                             |

**边 GraphEdge**

| 字段                    | 含义                                                  |
| ----------------------- | ----------------------------------------------------- |
| `sourceId` / `targetId` | 起点与终点                                            |
| `relation`              | CONTAINS / DECLARES / IMPORTS / REFERENCES / CALLS 等 |
| `status`                | VERIFIED / UNRESOLVED / DYNAMIC                       |
| `evidence`              | 源码路径、行范围、SHA、解析来源                       |
| `resolverVersion`       | 解析器及配置身份                                      |

目录包含关系直接建立；跨文件引用和调用边只有在实际解析成功后才建立为 VERIFIED。

**未发现某条边，不代表该关系不存在。**

### 2.2 Semantic Card（可选语义索引）

用于辅助 Agent 理解业务结构。

| 字段             | 含义                        |
| ---------------- | --------------------------- |
| `targetId`       | 对应模块或文件              |
| `responsibility` | 模块/文件主要职责           |
| `operations`     | 提供的重要业务操作          |
| `evidenceRefs`   | 支撑描述的真实源码引用      |
| `status`         | VERIFIED / INFERRED / STALE |

优先构建模块级描述。对于职责不明确的模块，按需调用 LLM 分析，避免全仓逐文件生成摘要。

### 2.3 Issue Investigation State（任务独立调查状态）

与仓库图分离，防止模型假设污染共享事实。

主要保存：

- `behaviorQueries`：Issue 行为描述与检索查询。
- `candidateRegions`：候选模块、文件或符号。
- `hypotheses`：根因假设及支持、反对证据。
- `missingEvidence`：尚未确认的重要事实。
- `visitedScopes`：已探索范围与有效进展。
- `budget`：剩余查询、读取、模型和时间额度。

## 3. 核心算法流程

### Phase A：Repository Initialization

**输入：** 固定版本的 Repository Snapshot。

执行：

1. 遍历可信文件清单，构建目录树及文件节点。
2. 识别语言、Package、Module 和项目配置。
3. 低成本抽取声明符号及直接导入。
4. 构建确定性 CONTAINS、DECLARES 等关系。
5. 持久化图及覆盖状态，支持按源码 SHA 增量复用。

**输出：** Repository Atlas + 初始 Structural Graph。

此阶段原则上不需要 LLM。

### Phase B：Issue Understanding & Global Retrieval

**输入：** GitHub Issue + Repository Atlas。

Localization Agent：

1. 提取实际现象、期望行为和触发条件。
2. 生成多个候选业务行为及检索查询。
3. 利用模块描述、路径、符号、词法、测试和可选语义检索进行全仓召回。
4. 对候选模块排序，保留多个可能方向。

**输出：** Top-K 候选模块及初始调查假设。

避免因首个关键词命中而过早锁定单一模块。

### Phase C：Progressive Graph Expansion

循环执行：

1. 选择最有调查价值的候选区域。
2. 展开子目录，检索文件及 Symbol。
3. 根据需要查询 caller、callee、import、reference、test 等关系。
4. 由可信解析器解析缺失关系，增量更新 Structural Graph。
5. 读取真实源码及测试，验证行为假设。
6. 更新候选排序、支持证据和未解决问题。

Agent 负责决定探索方向；宿主负责确定性查询、关系解析与证据校验。

必要时允许重新执行全仓检索，避免局限在错误子图。

### Phase D：Evidence Convergence

满足以下条件时，可以向 Planner 交接：

- 已定位一个或多个具体候选代码区域。
- 候选与 Issue 行为之间存在可追溯的源码证据。
- 关键依赖、消费者或缺失证据得到适当说明。
- 证据版本与当前仓库视图一致。

如果证据不足，则在预算允许且确有新进展时继续探索；否则明确输出定位不完整及剩余不确定性。

**最终输出：** EvidencePack，包括候选区域、真实源码、已验证关系、根因假设和未解决问题。

## 4. 关键算法约束

1. **准确性优先：** LLM 不能直接把猜测写成 VERIFIED 图边。
2. **按需解析：** 不强制全仓构建完整 AST 引用图和调用图。
3. **增量缓存：** 文件解析按内容 SHA 复用，跨文件关系同时绑定仓库视图及解析配置。
4. **分层导航：** 采用 Repository → Module → File → Symbol → Source 的逐层探索。
5. **保留多候选：** 不因单条高排名路径立即排除其他业务模块。
6. **自适应预算：** 新证据允许有限扩展，重复无进展触发停止，并保障 Planner/Coding 的后续资源。
7. **职责隔离：** Repository Graph 保存可信关系，Issue Investigation 保存本次任务的模型假设。

## 5. 算法复杂度与成本控制

设 F 为文件数，S 为实际解析的声明数量，K 为单次 Issue 深入调查的候选规模。

- **初始目录扫描：** O(F)。
- **初始符号扫描：** 与实际扫描源码体量近似线性，可分批执行。
- **按需关系解析：** 主要限制在 K 个相关候选及其受控邻域。
- **LLM 开销：** 主要发生在 Issue 语义理解、候选判断、补证和可选 Semantic Card 构建阶段，不随全仓文件数线性增加为逐文件调用。

通过固定仓库身份、增量缓存、候选上限及 Resource Budget Scheduler 控制总体成本。

## 6. DevFlow v2.4 集成建议

保留 v2.3.1 现有 `IssueLocalizer`、`RelationGraph`、源码缓存和 Sandbox 安全边界。

新增或增强：

- `RepositoryAtlas`：全局目录、模块及文件导航。
- `GraphExpansionService`：按需解析和补充关系。
- `BehaviorRetriever`：行为描述到候选模块、文件和测试的多路召回。
- `LocalizationInvestigation`：候选假设、证据和探索进展管理。

建议通过功能开关与原 Localization 进行同基线对照实验，重点验证无路径 Issue 的根因召回率、消费者覆盖率、最终修复成功率和实际成本。

**算法总结：**

PRG 不试图提前理解仓库中的全部业务逻辑，而是先用低成本确定性方法建立完整结构骨架，再由 Localization Agent 根据 Issue 逐层导航、按需补全可信关系，并持续积累可复用仓库知识。

**核心目标不是生成一张完整的图，而是利用一张逐渐完善的图，高效、可靠地找到真正需要修改的代码。**