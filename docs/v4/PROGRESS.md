# DevFlow v4 进度日志

方案见 [DevFlow_v4.0_Autonomous_Refactor_Plan.md](../../DevFlow_v4.0_Autonomous_Refactor_Plan.md)。本文只记录**已验证的状态**和下一步，最新条目在上方。

## 当前阶段：Phase 0（零费用部分）

- **分支**：`v4/phase0`，从 `06ef552` 拉出。
- **付费运行**：尚未获得授权，**目前没有发起任何付费模型请求**。

### Phase 0 清单

| 项目                | 状态     | 说明                                                                                                                          |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 基线冻结            | 完成     | `npm run lint` / `typecheck` 通过；vitest 1187 通过、60 跳过。                                                                |
| 0.1 缓存 Token 记账 | 完成     | 提交 `d85719b`：`cachedInputTokens` 写入 usage 并汇总进指标；结算支持 `cachedInputMicrosPerMillionTokens`；报价仍按无缓存价。 |
| 0.2 对照 Agent      | 代码完成 | 提交 `01854c4`：Kernel + 通用工具 + 求解尝试模块 + 数据集 runner。离线链路验证见下表。                                        |
| 0.3 现系统消融开关  | 调查中   | 已交给 Codex 做只读调查（任务书：`.devflow/v4-research/codex-brief-phase0.md`，任务 A），结果出来后再实现开关。               |
| 0.4 评测框架        | 部分完成 | runner 已能逐题记录轨迹、补丁、评分和 golden 文件触达情况；多次运行汇总和失败自动分类待补。                                   |
| 0.5 外部留出集      | 未开始   | —                                                                                                                             |
| 付费运行            | 等待授权 | 计划见下文。                                                                                                                  |

### 零费用验证记录

**脚本化 golden 运行**的做法：Fake Model 把注入文件恢复为 golden 内容，然后由同一个冻结评分器打分。它检验的是“沙箱 → 工具 → 补丁导出 → 评分”整条链路，**不代表 Agent 的能力**。

| 案例 | 语言   | 评分结果                                               | 耗时（含评分） |
| ---- | ------ | ------------------------------------------------------ | -------------- |
| E01  | C++    | 严格 PASS                                              | 54s            |
| E02  | Python | 严格 PASS                                              | 11s            |
| E03  | TS     | 严格 PASS                                              | 38s            |
| E04  | Java   | 严格 PASS（经 `edit_file` 写回）                       | 49s            |
| E05  | TS     | 严格 PASS                                              | 20s            |
| E06  | C++    | 严格 PASS                                              | 122s           |
| E07  | TS     | 严格 PASS                                              | 59s            |
| E08  | Python | 严格 PASS                                              | 376s           |
| E09  | Java   | 严格 PASS                                              | 46s            |
| E10  | TS     | 严格 PASS（`git apply` 与 `edit_file` 两种方式均通过） | 38–40s         |

其他零费用检查：

- **冒烟**（E02）：bash、read_file、edit_file 可用；编辑受保护的测试路径会被拒绝。
- **负对照**（E10 空提交）：判为失败。
- **三路并发**（E02/E03/E05）：全部通过。
- **真实请求体检查**（`.devflow/v4-phase0/wire-check.ts`）：通过 capture 机制在本地构造 GLM-5.3 请求，不发送 HTTP。请求参数为 `enable_thinking=true`、`reasoning_effort=low`、`clear_thinking=true`，4 个工具齐全，工具结果以纯文本发送，初始请求约 1.3K Token。

### 待授权的付费运行（建议）

**口径**：与旧批次一致，即同一冻结快照、镜像、公开 profile 和评分器；模型同为 GLM-5.3（百炼）、reasoning low、输出上限 8192；按无缓存上限计价（输入 ¥8 / 输出 ¥28 每百万 Token）；每题费用硬上限 ¥4。

| 批次   | 内容                                                                  | 上限  |
| ------ | --------------------------------------------------------------------- | ----- |
| A1     | 对照 Agent 在 E01–E10 上各跑 1 次                                     | ≤ ¥40 |
| A2     | 现系统消融 (a)、(b) 两档，各在 E10、E08 上跑 1 次（等开关实现后进行） | ≤ ¥16 |
| 检查点 | 出报告，并决定是否进入 B 段                                           | —     |

运行命令：

```bash
node --env-file=.env --import tsx scripts/v4/phase0-dataset.ts --live --spend-cap-cny 40 --cases E01,E02,E03,E04,E05,E06,E07,E08,E09,E10
```

## 运行方式（零费用）

```bash
node --env-file=.env --import tsx scripts/v4/phase0-dataset.ts --cases E10 --script golden
```

- `--script` 可选值：`golden`（链路验证）、`smoke`（工具冒烟）、`submit`（空提交负对照）。
- 输出写入 `.devflow/v4-phase0/<时间>-<脚本>/`，每题生成 `trajectory.jsonl`、`candidate.diff`、`result.json` 和评分目录。
