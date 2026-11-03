# 32 · N-203 实施拆分与验收矩阵

- 状态：设计完成，实施中（`feat/n203-query-execution`，Draft PR）
- 上位文档：[ADR 0008](../../adr/0008-n203-query-execution.md)、[ADR 0007](../../adr/0007-n202-query-editor-context.md)、[`nyala/rpc/README.md`](../../../nyala/rpc/README.md)
- 依赖：N-202 已合入 `nyala/main`（squash `e6f94e042bc`）

## 1. 范围

交付「一个已绑定的查询标签页能执行 SQL，并拥有这次执行」所需的最小闭环：

| 有 | 无（留给后续） |
|---|---|
| 三种执行模式的命令与键位 | 结果网格、表格虚拟化（N-204/N-205） |
| 执行快照与执行记录 | 草稿持久化（N-206） |
| `query.*` / `result.*` 的 Main 进程白名单与校验 | 桌面原生 E2E（N-207） |
| 取消、状态推进、结果句柄所有权 | 事务所有权与 `UNKNOWN` 的人工确认流（N-402） |
| 与 N-204 的最小接口 | PostgreSQL/MySQL、Explain、导出 |

Rust 执行器、`nyala/rpc/**` 与生成的契约**不改**。若实施中发现真正的契约缺口，单开 PR，不混入 N-203。

## 2. 实施拆分

每个拆分是一个可独立审查的提交，按顺序落地；前一个的测试通过后再开始下一个。

### S1 · SQL 语句分割（纯函数）

- 新增 `src/vs/workbench/contrib/nyala/query/common/nyalaSqlStatements.ts`。
- 导出 `splitSqlStatements(text): readonly { start: number; end: number; text: string }[]` 与 `statementAt(text, offset)`。
- 识别：单引号字符串（`''` 转义）、双引号标识符、反引号、`[...]`、`--` 行注释、`/* */` 块注释；只在顶层 `;` 切分。
- 边界：空文档、纯注释、末尾无分号、连续分号、CRLF、光标恰在分号上、光标在语句之间。
- 验收：`nyalaSqlStatements.test.ts`（node），不需任何服务。

### S2 · 执行记录与状态机（无 IO）

- 新增 `common/nyalaQueryExecution.ts`：`INyalaExecutionSnapshot`、`NyalaExecutionState`、终止态判定、`applyState(record, state, sequence)` 的纯函数版本。
- 不发起任何 RPC；只做状态推进、乱序丢弃与终态冻结。
- 验收：`nyalaQueryExecution.test.ts`（node），覆盖 sequence 递增/相等/回退/跳号、终态后通知被忽略。

### S3 · Main 进程白名单与校验

- `nyalaRuntimeIpc.ts`：新增 5 个 `NyalaRuntimeCommand` 与 `QueryStateChanged` 事件。
- `nyalaRuntimeRequest.ts`：`executeParams`、`cancelParams`、`executionRef`、`fetchPageParams`。
- `nyalaRuntimeChannel.ts`：方法映射、参数校验、回复结构校验、`QueryStateChanged` 转发并附 `runtimeGeneration`。
- 验收：`nyalaRuntimeRequest.test.ts`、`nyalaRuntimeChannel.test.ts`（node），覆盖白名单外命令、每个非法参数、畸形回复、跨窗口不可见。

### S4 · 执行服务（renderer）

- 新增 `common/nyalaQueryExecutionService.ts`：持有记录、发起 `query.execute`、订阅状态通知、取消、结果句柄与上限、终态/关闭/换代释放。
- 依赖 `INyalaRuntimeBridge`、`INyalaQueryContextService`、`ILogService`；不再引入第三个来源。
- 验收：`nyalaQueryExecutionService.test.ts`（node，FakeBridge + `DeferredPromise`），覆盖快照固定、拒绝并发、迟到回复、代际不匹配、取消三态、结果上限与释放。

### S5 · 命令与键位

- 新增 `browser/nyalaQueryExecution.contribution.ts`：三个 `Action2` 与键位；注册进 `query/browser` 的贡献文件。
- Pane 增加只读的 `getSelectionText()` / `getCursorOffset()` / `getText()`（已有 `getText`）。
- 验收：`nyalaQueryExecution.test.ts`（Chromium），覆盖三个命令的文本来源、未绑定拒绝、Ctrl+Enter 在查询编辑器与普通编辑器中的不同结果。

### S6 · 文档与治理

- ADR 0008 更新为 Accepted 前的实际行为；`PROGRESS.md` 增 P2.5；`20-backlog.md` 的 N-203 行；`docs/adr/README.md` 与 `docs/nyala-kickoff/docs/adr/README.md` 的仓库级 ADR 列表加入 0008。

## 3. 验收矩阵

`PASS` 需指向可重跑的测试；`BLOCKED`/`NOT RUN` 必须写明具体原因。

| # | 断言 | 类型 | 覆盖 |
|---|---|---|---|
| A1 | 光标所在语句被执行；字符串/注释里的 `;` 不切分 | 单元 | S1 |
| A2 | 有选区时只发送选区；空白选区被拒绝 | 单元 | S1/S5 |
| A3 | 全文模式发送整个文档；空白文档被拒绝 | 单元 | S1/S5 |
| A4 | 同一 `queryId` 的第二个非终态执行被同步拒绝 | 单元 | S4 |
| A5 | 两个标签页各自执行时使用各自的 session 快照 | 单元 | S4 |
| A6 | 执行开始后切换激活标签页、重新绑定、关闭标签页都不改变在途执行的目标 | 单元 | S4 |
| A7 | `canExecute()` 为 false（未绑定 / `switching` / runtime 换代）时拒绝执行且不发 RPC | 单元 | S4/S5 |
| A8 | `query.execute` 回复的 `runtimeGeneration` 与快照不符时丢弃 `executionId` 并标失败 | 单元 | S4 |
| A9 | 标签页在回复前关闭，迟到的 `executionId` 会立刻收到 `cancel` | 单元 | S4 |
| A10 | 通知 `sequence` 重复/回退被丢弃；跳号触发一次 `getState` 校准 | 单元 | S2/S4 |
| A11 | `cancel_requested` 不显示为 `cancelled`；取消被拒时按回复状态收敛 | 单元 | S2/S4 |
| A12 | `UNKNOWN_COMMIT_STATUS` 标为「提交结果未知」，不提供自动重试 | 单元 | S4 |
| A13 | 终态、关闭、runtime 换代都会释放结果句柄；`release` 幂等；换代时不向新 runtime 发 release | 单元 | S4 |
| A14 | 结果句柄上限（每执行 8、每窗口 16）与淘汰顺序可测 | 单元 | S4 |
| A15 | 白名单外命令被拒绝；每个非法参数在触达进程前返回 `INVALID_PARAMS` | 单元 | S3 |
| A16 | 畸形回复（state 枚举、sequence、rows 超 limit）不进入 renderer | 单元 | S3 |
| A17 | `QueryStateChanged` 只送给调用窗口，带当前 `runtimeGeneration` | 单元 | S3 |
| A18 | Ctrl+Enter 在查询编辑器里执行当前语句，且没有插入新行 | 浏览器 | S5 |
| A19 | Ctrl+Enter 在普通文本编辑器里仍是「在下方插入行」 | 浏览器 | S5 |
| A20 | Shift+Ctrl+Enter 执行全文；有选区时 Ctrl+Enter 执行选区 | 浏览器 | S5 |
| A21 | 未绑定标签页上的三个命令都不发执行请求，并给出可读提示 | 浏览器 | S5 |
| A22 | `npm run build-fast`、Nyala 文件 `tsc`、`git diff --check` 通过 | 构建 | 全部 |
| A23 | 四项必需 CI 与手动 Full test suites 在 HEAD 上通过 | CI | 全部 |
| A24 | 桌面原生 smoke（连接→执行→取消→结果） | 原生 | 受 Electron 阻塞时记 NOT RUN |

## 4. 判定规则

- 任何一个 A 项为 FAIL，不合并。
- A24 若仍受 `@vscode/policy-watcher` 原生绑定阻塞，记 NOT RUN 并写具体阻塞，不以 Chromium 单测替代。
- 报告统一使用 PASS / FAIL / BLOCKED / NOT RUN。

## 5. 关键实现约束（复述 ADR 0008）

1. 执行入口必须调用 `canExecute()`，不接受 `binding !== undefined`。
2. 快照在第一次 `await` 之前构造并冻结。
3. 所有操作按 `executionId`，不按 `queryId` 或「当前标签页」。
4. `unknown` 是诚实的终态，不自动重跑；`UNKNOWN_COMMIT_STATUS` 不重试。
5. 结果只走句柄与受控分页，`release` 恰好一次。
6. Main 进程是边界；renderer 不命名任意 RPC 方法。
