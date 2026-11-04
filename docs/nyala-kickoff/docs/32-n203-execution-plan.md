# 32 · N-203 实施拆分与验收矩阵

- 状态：D1–D4 已落实，S1–S6 实现完成（`feat/n203-query-execution`，Draft PR #51）
- 上位文档：[ADR 0008](../../adr/0008-n203-query-execution.md)、[ADR 0007](../../adr/0007-n202-query-editor-context.md)、[`nyala/rpc/README.md`](../../../nyala/rpc/README.md)
- 依赖：N-202 已合入 `nyala/main`（squash `e6f94e042bc`）

## 0. 审查修订摘要（D1–D4）

| 编号 | 问题 | 修订 |
|---|---|---|
| D1 | 执行结束即释放结果，N-204 拿不到数据 | 执行记录与结果租约分离；`completed` 只解除互斥；租约由执行服务拥有；五种清理时机；旧代际只本地遗忘；`release` 幂等且至多一次，不承诺 exactly-once；限额与 `maxConcurrentExecutions`/`maxResultTtlSecs` 协调，淘汰后**不重跑 SQL** |
| D2 | 请求可能已到达 runtime 却报「未执行」 | 只有请求**确定未发出**才报普通失败；已发出但结果未知一律 `unknown`；保留 `UNKNOWN_COMMIT_STATUS` 与 `executionRollback` 原义；禁止自动重放 |
| D3 | `cancel` 回复与通知可能污染权威状态 | `cancel` 按 `executionId`；`fetchPage`/`release` 在服务内校验 `resultId` 归属；`cancel` 回复不含 `sequence`，不覆盖状态，必要时 `getState` 校准；单飞校准 + `stateEpoch` + 终态冻结 + 代际过滤 |
| D4 | 命令与验收规则自相矛盾 | `Ctrl/Cmd+Enter` = 选区优先，否则当前语句；`Shift+Ctrl/Cmd+Enter` = 全文；独立 Execute Selection 保留；**多语句选区明确拒绝**而非只跑第一条；补充 Trigger/字符串/注释/分号/CRLF 用例 |

## 1. 范围

| 有 | 无（留给后续） |
|---|---|
| 三种执行模式与键位 | 结果网格、虚拟化、缓存（N-204/N-205） |
| 执行快照、记录、状态推进 | 草稿持久化（N-206） |
| `query.*` / `result.*` 白名单与校验 | 桌面原生 E2E（N-207） |
| 取消、结果租约与上限 | 事务所有权与 `unknown` 人工确认流（N-402） |
| 与 N-204 的最小接口 | PG/MySQL、Explain、导出 |

Rust 执行器、`nyala/rpc/**` 与生成契约**不改**。若发现真正的契约缺口，停止相关子项并建议独立 PR。

## 2. 实施拆分

### S1 · SQL 语句分割（纯函数）

- 新增 `common/nyalaSqlStatements.ts`：`splitSqlStatements(text)`、`statementAt(text, offset)`、`countStatements(text)`。
- 识别单引号（`''` 转义）、双引号、反引号、`[...]`、`--`、`/* */`；只在顶层 `;` 切分。
- **SQLite Trigger**：`CREATE TRIGGER ... BEGIN ... END;` 内部的 `;` 属于触发器体，不切分；`BEGIN`/`END` 与 `CASE ... END` 需要深度跟踪。
- 无法可靠识别（未闭合字符串/注释/触发器块）时返回 `{ ok: false, reason }`，调用方拒绝执行。
- 验收：`nyalaSqlStatements.test.ts`（node）。

### S2 · 快照、状态机与结果租约（无 IO）

- 新增 `common/nyalaQueryExecution.ts`：`INyalaExecutionSnapshot`、`NyalaExecutionState`、`isTerminal`、`nextState(record, state, sequence)` 纯函数、`INyalaExecutionRecord`、`INyalaResultLease` 的状态。
- 状态机拒绝：重复 sequence、回退 sequence、非法跃迁（例如 `completed` 后再 `running`）、终态复活。
- 验收：`nyalaQueryExecution.test.ts`（node）。

### S3 · Main 进程白名单与校验

- `nyalaRuntimeIpc.ts`：5 个命令 + `QueryStateChanged` 事件。
- `nyalaRuntimeRequest.ts`：`executeParams`、`cancelParams`、`executionRef`、`fetchPageParams`、`resultRef`。
- `nyalaRuntimeChannel.ts`：方法映射、参数校验、回复结构校验、通知转发并附 `runtimeGeneration`。
- 验收：`nyalaRuntimeRequest.test.ts`、`nyalaRuntimeChannel.test.ts`（FakeSupervisor + 真实协议样例）。

### S4 · 执行服务（renderer）

- 新增 `common/nyalaQueryExecutionService.ts`：
  - 快照在第一个 `await` 前构造；`canExecute()` 把关；
  - 发送前注册 pending 记录（防重复点击与关闭竞态）；
  - 每 `queryId` 至多一个非终态执行；
  - 回复前关闭 → `abandoned`，迟到的 `executionId` 立刻 `cancel`；
  - runtime 丢失 → `unknown`，不报「未执行」；
  - 状态只由通知/校准推进，按 `sequence` 与代际过滤；
  - 结果租约、配额、淘汰与释放。
- 验收：`nyalaQueryExecutionService.test.ts`（node，FakeBridge + `DeferredPromise`）。

### S5 · 命令与键位

- 新增 `browser/nyalaQueryExecution.contribution.ts`：三个 `Action2` 与键位。
- Pane 增加只读访问：`getSelection()`（文本 + 是否为空）。`getText()` 已有。
- 验收：`nyalaQueryExecution.test.ts`（Chromium），覆盖命令来源、未绑定/切换中/重复执行提示、Ctrl+Enter 双向行为。

### S6 · 文档与治理

- ADR 0008 更新到实际行为并改状态；`PROGRESS.md` P2.5；`20-backlog.md` N-203；`00-index.md`；两处 ADR 索引。

## 3. 验收矩阵

| # | 断言 | 类型 | 覆盖 |
|---|---|---|---|
| A1 | 光标所在语句被执行；字符串/注释内的 `;` 不切分 | 单元 | S1 |
| A2 | **SQLite Trigger** 体内的 `;` 不切分；`CASE ... END` 同理 | 单元 | S1 |
| A3 | 未闭合字符串/注释/触发器块 → 拒绝执行并给出原因 | 单元 | S1 |
| A4 | CRLF、光标在分号上、连续分号、纯注释文档的边界行为明确 | 单元 | S1 |
| A5 | 同一 `queryId` 的第二个非终态执行被同步拒绝 | 单元 | S4 |
| A6 | 两个标签页各自执行时使用各自的 session 快照 | 单元 | S4 |
| A7 | 执行开始后切换标签页、重新绑定、关闭标签页都不改变在途执行目标 | 单元 | S4 |
| A8 | `canExecute()` 为 false（未绑定 / `switching` / runtime 换代）时拒绝且不发 RPC | 单元 | S4/S5 |
| A9 | 回复代际不匹配 → 丢弃 `executionId`，记录为 `unknown`，不报「未执行」 | 单元 | S4 |
| A10 | 标签页在回复前关闭 → `abandoned`，迟到 `executionId` 立刻收到 `cancel` | 单元 | S4 |
| A11 | 通知/校准 sequence 重复或回退被丢弃；跳号触发**一次**校准；终态不可复活 | 单元 | S2/S4 |
| A12 | `cancel_requested` ≠ `cancelled`；取消被拒时按回复状态收敛，`sequence` 不被覆盖 | 单元 | S2/S4 |
| A13 | `UNKNOWN_COMMIT_STATUS` → `failed` 且保留 `executionRollback: 'unknown'`，无重试入口 | 单元 | S4 |
| A14 | `executionRollback: 'rolled_back'` 原样透传，不被升格为「可重试」 | 单元 | S4 |
| A15 | **`completed` 后结果仍可读**；最后一个租约释放才 `release`；`release` 至多发送一次且幂等 | 单元 | S4 |
| A16 | 换代时本地丢弃租约，**不向新 runtime 发 `release`** | 单元 | S4 |
| A17 | 结果配额上限与淘汰顺序可测；淘汰后**不重跑 SQL** | 单元 | S4 |
| A18 | `resultId` 不属于该 `executionId` 时被拒绝，不发 RPC | 单元 | S4 |
| A19 | 白名单外命令被拒绝；每个非法参数在触达进程前返回 `INVALID_PARAMS` | 单元 | S3 |
| A20 | 畸形回复（state 枚举、sequence、rows 超 limit、id 形态）不进入 renderer | 单元 | S3 |
| A21 | 通知只送给调用窗口，并带该通知到达时的 `runtimeGeneration` | 单元 | S3 |
| A22 | `Ctrl/Cmd+Enter` 在查询编辑器里执行且**没有插入新行** | 浏览器 | S5 |
| A23 | `Ctrl/Cmd+Enter` 在普通编辑器里仍是「在下方插入行」 | 浏览器 | S5 |
| A24 | 有选区时 `Ctrl/Cmd+Enter` 执行选区；`Shift+Ctrl/Cmd+Enter` 执行全文；多语句选区被拒绝并提示 Execute Script | 浏览器 | S5 |
| A25 | 未绑定 / 切换中 / runtime 不可用 / 重复执行都给出可读提示且不发请求 | 浏览器 | S5 |
| A26 | `build-fast`、Nyala `tsc`、`npm run nyala:check-rpc-generated`、hygiene、`git diff --check` 通过 | 构建 | 全部 |
| A27 | 四项必需 CI 与手动 Full test suites 在当前 HEAD 通过 | CI | 全部 |
| A28 | 桌面原生 smoke（连接→执行→取消→结果） | 原生 | 受阻塞时记 NOT RUN |
| A29 | 早到通知在 `execute` 续体前到达时仍完整收敛（终态/sequence/resultIds/错误） | 单元 | S4 |
| A30 | 早到缓存有界、按代际丢弃、重复通知只应用一次 | 单元 | S4 |
| A31 | 第 4 个结果被显式 release；配额等待在途 release 完成 | 单元 | S4 |
| A32 | 关闭查询后记录/SQL/无租约结果清理；有租约结果保留至最后释放 | 单元 | S4 |
| A33 | IPC Promise 拒绝不会让执行停在 `queued`；终态 cancel 通过 `getState` 补齐元数据 | 单元 | S4 |
| A34 | 空白/注释选区被拒绝，不退化为执行下方语句；释放后的租约不能取页 | 浏览器/单元 | S4/S5 |

## 3.1 实施状态（2026-11-03）

| 拆分 | 状态 | 证据 |
|---|---|---|
| S1 语句分割 | **DONE** | `nyalaSqlStatements.test.ts` 18 passing；红/绿：去掉触发器跟踪后 4 条失败 |
| S2 快照与状态机 | **DONE** | `nyalaQueryExecution.test.ts` 17 passing；红/绿：允许终态复活后 2 条失败 |
| S3 Main 进程白名单 | **DONE** | `nyalaRuntimeRequest.test.ts` 10、`nyalaRuntimeChannel.test.ts` 13 passing；新增命令、参数/回复校验、通知代际 |
| S4 执行服务与租约 | **DONE** | `nyalaQueryExecutionService.test.ts` 25 passing；红/绿：移除 `canExecute` 门禁后 stale-generation 用例失败，把未知降级为失败后另一条失败 |
| S5 命令与键位 | **DONE** | `nyalaQueryExecution.test.ts`（Chromium）8 passing；红/绿：把 weight 降到 `EditorContrib` 后键位断言失败 |
| S6 文档与治理 | **DONE** | 本文件、ADR 0008、`PROGRESS.md`、`20-backlog.md`、两处 ADR 索引 |

## 3.2 复审修复（CHANGES_REQUESTED 收口）

| 问题 | 修复 | 证据 |
|---|---|---|
| 通知早于 `execute` 续体，记录停在 `queued` | 按 `executionId` 的有界早到缓存，采纳 id 后回放；换代丢弃 | `notifications that arrive before the execute continuation are replayed, not lost` 等 4 条 |
| 第 4 个结果被丢弃且占用 runtime 配额 | 拒收即显式 `release`；配额按「保留 + 在途 release」计算，新执行等待淘汰释放完成 | `the fourth result of one execution is released instead of silently dropped`、`a new run waits for an evicted result…` |
| 关闭查询后记录/SQL/句柄残留 | 终止执行从 `byQuery` 脱离、SQL 快照清空、无租约结果释放；有租约保留至最后释放 | 关闭三组用例 |
| IPC Promise 拒绝导致永久 `queued` | `execute`/`cancel` 拒绝 → `unknown`；`getState` 拒绝只结束校准；`fetchPage` 拒绝转可读错误 | 拒绝用例 2 条 |
| 终态 cancel 回复缺少 resultIds | 一次 `getState` 元数据校准 | `a cancel reply that only says completed…` |
| 空白选区退化为执行下方语句 | `hasSelection()` 区分「无选区」与「选了空白」；有选区但无 SQL 时拒绝 | Chromium 空白/注释选区两组 |

红/绿：回退早到缓存、拒收释放、关闭清理、取消元数据校准、空白选区判断与拒绝处理，分别出现 7（Node）与 1（Chromium）条失败；恢复后全绿。

## 4. 判定规则

- 任一 A 项 FAIL 不合并。
- A28 若仍受 `@vscode/policy-watcher` 原生绑定阻塞，记 NOT RUN 并写具体阻塞，不以 Chromium 单测替代。
- 报告统一使用 PASS / FAIL / BLOCKED / NOT RUN。

## 5. 关键实现约束（复述 ADR 0008）

1. 执行入口必须调用 `canExecute()`，不接受 `binding !== undefined`。
2. 快照在第一次 `await` 之前构造并冻结。
3. `query.cancel` / `query.getState` 按 `executionId`；`resultId` 归属由服务校验。
4. `completed` 只解除互斥，不销毁结果；结果由租约拥有并在五种时机清理。
5. `unknown` 是诚实的终态，不自动重跑；`UNKNOWN_COMMIT_STATUS` 不重试。
6. Main 进程是边界；畸形回复不得被推断成「确定未执行」。
