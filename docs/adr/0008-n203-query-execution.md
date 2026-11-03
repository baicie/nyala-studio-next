# ADR 0008 · N-203 Query Execution Service 与执行快照

- 状态：Proposed（2026-11-03，`feat/n203-query-execution`，实现完成，Draft PR 待审）
- 日期：2026-11-03
- 决策域：一个已绑定的查询标签页如何执行 SQL、拥有结果、取消与释放
- 上位文档：[`docs/adr/0007-n202-query-editor-context.md`](0007-n202-query-editor-context.md)（QueryContext、`canExecute`、`switching`）、[`docs/adr/0006-p2-workbench-runtime-bridge.md`](0006-p2-workbench-runtime-bridge.md)（受控 IPC）、[`nyala/rpc/README.md`](../../nyala/rpc/README.md) §4–§7（方法目录、执行状态机、资源限额）、[`docs/nyala-governance/06-sql-runtime-safety.md`](../nyala-governance/06-sql-runtime-safety.md)（禁止全局 `currentConnection`）、[`docs/nyala-kickoff/docs/25-engineering-rules.md`](../nyala-kickoff/docs/25-engineering-rules.md) 第 6/7/8/9 条

## 背景

N-202 交付了能编辑、能绑定、但**不能执行**的查询标签页：`NyalaQueryEditorPane.getExecutionBinding()` 已经返回一个快照，或在绑定过期/切换中时返回 `undefined`，但没有任何命令使用它。Rust 侧的 `query.execute`、`query.cancel`、`query.getState`、`result.fetchPage`、`result.release` 与 `query.stateChanged` 通知从 N-106/N-108 起就已实现并通过契约测试；Main 进程的白名单目前只放行连接与 metadata 六条命令。

所以 N-203 的全部内容是**接线与所有权**，不是新的执行器：

1. 把 `query.*` / `result.*` 加进 Main 进程白名单，并在那里校验参数与回复；
2. 在 Workbench 里加一个执行服务，把「用户按下 Ctrl+Enter 的那一刻」固定成一份不可变快照；
3. 按 `executionId` 拥有执行、取消、状态推进与结果租约；
4. 暴露给 N-204 一个最小的只读接口。

### 核心风险

- **执行目标漂移**：标签页 A 绑定 Profile A，用户切到标签页 B（绑定 Profile B）后按 Ctrl+Enter。若命令处理器读「当前激活标签页」或「全局当前连接」，就会对着 B 的会话执行 A 的 SQL。
- **快照过期**：runtime 在执行请求发出后重启，`sessionId` 属于已经消失的进程。不校验代际就会把 `INVALID_SESSION` 当成普通失败，或更糟，把结果归给错误的标签页。
- **结果泄漏**：结果句柄由 Rust 持有，受 `maxResultTtlSecs` 与 `maxConcurrentExecutions` 约束。丢失 `resultId` 或漏掉 `release`，都会让后续执行被 `RESOURCE_LIMIT` 拒绝。
- **误报回滚**：`UNKNOWN_COMMIT_STATUS` 表示「可能已提交」。自动重试会重复写入；把它显示成「未执行」会误导用户。

## 决策

### 1. 执行入口只有一条，且必须经过 `canExecute()`

```text
Nyala: Execute            (Ctrl/Cmd+Enter: selection if any, else current statement)
Nyala: Execute Selection  (no default key)
Nyala: Execute Script     (Shift+Ctrl/Cmd+Enter)
        |
        v
INyalaQueryExecutionService.execute(queryId, text, mode)
        |
        +-- 1. 取 document/context，要求 canExecute(runtimeState) === true
        +-- 2. 取 context.binding 的四个字段，整体复制成快照（不读第二个来源）
        +-- 3. 同步拒绝：switching / 未绑定 / 同一 queryId 已有非终态执行
```

- **不允许**以 `binding !== undefined` 作为放行条件。`canExecute()` 已经同时要求 `bindingState === 'idle'`、有 binding、runtime `ready` 且代际相同；少检查任何一项，都会在「切换中」或「runtime 刚换代」的窗口里放行一次执行。
- **不允许**读取全局当前连接、`activeEditor` 之外的其他标签页，或 `INyalaConnectionService` 的「第一个连接」。
- 命令本身只做三件事：定位 `NyalaQueryEditorPane`、按模式取出 SQL、调用执行服务。它不做网络、不持有状态。

### 2. 快照是不可变的，且与 context 解耦

```ts
interface INyalaExecutionSnapshot {
	readonly queryId: string;
	readonly profileId: string;
	readonly profileName: string;      // 只用于显示，不参与路由
	readonly sessionId: string;
	readonly sessionGeneration: number;
	readonly runtimeGeneration: number;
	readonly sql: string;
	readonly mode: 'statement' | 'selection' | 'script';
	readonly readOnly: boolean;
	readonly startedAt: number;
}
```

- 快照在第一次 `await` **之前**构造完毕；之后无论标签页切换、重新绑定、关闭，这次执行的目标都不变。
- 快照不放进 `EditorInput`，也不放进 `NyalaQueryContext`：context 会因为用户改绑而变，执行必须记住它当时看到的东西。
- 快照的四个身份字段**整体复制**。若构造后读到 `undefined`，就不执行并报错，而不是补一个默认值。

### 3. 执行结束不等于结果释放（修订 D1）

执行记录与结果句柄是**两条生命周期**，此前把它们绑在一起是错的：

```text
ExecutionRecord:  queued -> running -> ... -> completed | failed | cancelled | unknown
                                              |
                                              | 终态只解除「同一 queryId 的互斥」，
                                              | 不销毁已经产生的结果
                                              v
ResultLease:      available --(N-204 acquire)--> leased --(last release)--> released
                       |                              |
                       +-- eviction / TTL expiry -----+
                       +-- window close / generation change --> dropped (本地)
```

- **`completed` 解除执行中的互斥，但不自动销毁成功结果。** 用户执行完一条 `SELECT` 后结果必须仍然可读；若终态即刻 `release`，N-204 永远拿不到数据。
- **`ResultHandle` 由 ExecutionService 统一拥有**，N-204 只能通过租约访问：

  ```ts
  interface INyalaResultLease {
      readonly resultId: string;
      readonly executionId: string;
      readonly runtimeGeneration: number;
      /** Marks this consumer as interested. Every acquire needs exactly one release. */
      release(): void;
  }

  interface INyalaQueryExecutionService {
      acquireResult(executionId: string, resultId: string): INyalaResultLease | undefined;
      fetchPage(lease: INyalaResultLease, cursor: string | null, limit?: number): Promise<INyalaResultPage>;
  }
  ```

- **清理只发生在五种情况**：最后一个租约释放；服务侧淘汰（窗口配额）；runtime 报告 TTL 过期（`RESULT_EXPIRED`）；窗口关闭；runtime 换代。
- **严禁向新 Runtime 释放旧代际结果。** 换代后进程已死，`result.release` 只会得到 `INVALID_SESSION` 或一条无意义的请求；此时只做本地遗忘。
- **`release` 的语义是「幂等、至多发送一次、有明确完成状态」，不是严格 exactly-once。** 网络或进程故障下无法证明对端收到，因此：
  - 每个租约只发一次 `result.release`；
  - `{released:false}` 视为「已经不在了」，不是错误；
  - `RESULT_EXPIRED`、`RUNTIME_LOST`、`INVALID_SESSION` 都让本地标记为 `released`，并记录原因；
  - UI 不显示「已释放」，因为那是一个无法证明的断言。
- **限额与 Runtime 的真实约束协调**：`query.execute` 的配额由 Rust 的 `maxConcurrentExecutions`（默认 4，且 `active + pendingResults` 一起计）决定，`maxResultTtlSecs`（默认 300）决定结果寿命。客户端因此：
  - 不自行发明更大的上限；本地「保留多少结果」的上限不得超过 hello 协商来的 `maxConcurrentExecutions`；
  - 命中 `RESOURCE_LIMIT` 时，先淘汰本地最旧的**已终态且无租约**结果并重试**一次**（仅当请求确定未到达 runtime 时），否则直接向用户报告「结果句柄已满，关闭一个结果视图后重试」；
  - **绝不通过重新执行 SQL 来「恢复」被淘汰的结果**——那是重复写入。

### 4. 未知执行结果必须诚实报告（修订 D2）

请求是否可能到达 Runtime，决定我们能说什么：

| 情形 | 判定 | 呈现 |
|---|---|---|
| 参数校验失败、`canExecute()` 失败、已有非终态执行 | 请求**未发出** | 普通失败，可以说「未执行」 |
| runtime 在发送前不可用（`RUNTIME_LOST` 且从未发出） | 请求**未发出** | 普通失败 |
| 请求已发出，回复丢失 / 代际变化 / 进程退出 | 可能已到达 | **`unknown`**：不得说「未执行」，不得说「已回滚」 |
| runtime 回复 `UNKNOWN_COMMIT_STATUS` | 已知不确定 | `failed` + 保留 `executionRollback: 'unknown'` 原义 |
| runtime 回复 `executionRollback: 'rolled_back'` | 有证据 | 显式标注「已回滚」 |

- `executionRollback` 与 `UNKNOWN_COMMIT_STATUS` 只透传、不解释成更弱的说法。客户端不得把 `unknown` 降级成 `failed`，也不得把 `rolled_back` 升格成「安全重试」。
- **禁止自动重放**写入或状态未知的执行。N-203 不提供「重试」按钮；用户要重新执行必须自己再按一次，并且会得到一条新的 `executionId`。
- 客户端自己产生的 `unknown`（如换代时仍有在途执行）与 runtime 报告的 `unknown` 在记录里用 `unknownReason` 区分，便于 N-207 的日志核对。

### 5. 身份与状态协议（修订 D3）

- `query.cancel`、`query.getState` 按 **`executionId`**。
- `result.fetchPage`、`result.release` 在 RPC 层按 **`resultId`**；**ExecutionService 负责校验 `resultId` 属于该 `executionId`**，越界的 `resultId` 直接拒绝，不发 RPC。
- **`query.cancel` 的回复不含 `sequence`**（v1 如此），因此它**不能**直接覆盖权威状态：
  - `accepted: true` → 本地进入 `cancel_requested`（这是客户端的意图，不是 runtime 的事实）；
  - 回复里的 `state` 只用于「已经终态」的判断（`completed`/`failed`/`cancelled`/`unknown`），仍不写 `sequence`；
  - 需要权威状态时调用 `query.getState` 校准，并沿用它的 `sequence`。
- **并发 `getState` 与乱序通知**：记录维护 `lastAppliedSequence` 与一个单调的 `stateEpoch`。
  - 只应用 `sequence > lastAppliedSequence` 的通知；
  - 跳号（`> last + 1`）触发一次校准读，校准结果按同样的规则比较后才写入；
  - 同一时刻只允许一个在途校准读；更晚的请求合并到它之后；
  - 终态一旦确立即**冻结**：后续任何通知、校准结果、取消回复都不能复活它，只能被忽略并计入诊断。
- 记录还带 `runtimeGeneration`：来自旧代际的通知一律丢弃，不参与 sequence 比较（否则会污染新代际的序列）。

### 6. SQL 模式与键位（修订 D4）

v1 合同里 `statement` 与 `selection` 都只允许**一条**语句（Rust `Mode::Single`；第二条语句会让整次执行以 `INVALID_PARAMS` 失败，而不是静默只跑第一条）。据此定死规则：

| 键位 | 命令 | 判定 |
|---|---|---|
| `Ctrl/Cmd+Enter` | `Nyala: Execute` | 有非空选区 → 执行选区；否则 → 执行当前语句 |
| `Shift+Ctrl/Cmd+Enter` | `Nyala: Execute Script` | 执行全文（`mode: 'script'`） |
| 无默认键位 | `Nyala: Execute Selection` | 只执行选区；无选区时拒绝并提示 |

- 选区本身含多条语句时，`Nyala: Execute` **明确拒绝**并提示「选区包含多条语句，请使用 Execute Script」，**不**只运行第一条，也**不**偷偷改成 `script` 模式。判断由客户端的 SQL 分割器完成，再交给 runtime 的单语句规则兜底。
- 当前语句由 `nyalaSqlStatements.ts` 做 SQL-aware 分割：识别 `'...'`（含 `''` 转义）、`"..."`、`` `...` ``、`[...]`、`--` 行注释、`/* */` 块注释，只在顶层 `;` 切分；**SQLite `CREATE TRIGGER ... BEGIN ... END;` 内部的 `;` 不切分**（`BEGIN`/`CASE` 深度跟踪）。
- 无法可靠识别（未闭合的字符串/注释/触发器块）时**拒绝执行**并说明原因，不猜一个片段。
- 空文档、纯注释、光标处无可执行语句 → 拒绝，不退化为执行全文。
- 用例必须覆盖：SQLite Trigger、字符串内的 `;`、注释内的 `;`、分号边界、CRLF、光标恰在分号上、多个连续分号。
- `Ctrl/Cmd+Enter` 的 `when` 为 `resourceScheme == 'nyala-query' && editorTextFocus`，weight 为 `KeybindingWeight.WorkbenchContrib`（200），高于 Monaco `editor.action.insertLineAfter` 的 `EditorContrib`（100）。这是**有意覆盖**，普通编辑器行为不变，双向断言（A18/A19）。

### 7. 文本与结果不落盘

- 不把用户 SQL 正文、连接路径或任何敏感参数写入日志或遥测。日志只写 `queryId`、`executionId`、状态与错误 `kind`。
- 结果只经句柄与分页进入 renderer，不缓存进执行记录。

### 8. Main 进程白名单、参数校验与回复校验

新增 `NyalaRuntimeCommand`：`QueryExecute`、`QueryCancel`、`QueryGetState`、`ResultFetchPage`、`ResultRelease`；新增事件 `QueryStateChanged`。

- 方法映射进 `NYALA_RUNTIME_METHODS`，表外命令继续被拒绝。
- 参数在 `nyalaRuntimeRequest.ts` 校验后才进 RPC：
  - `execute`：`sessionId` 匹配契约 id、`sessionGeneration >= 1`、`sql` 非空且 ≤ 1 MiB、`mode` 枚举、`timeoutMs` 1..600000、`maxInitialRows` 1..10000、`cancelTokenId` 有界；
  - `cancel`：`executionId` + 可选 `reason` 枚举；
  - `getState` / `release`：单个 `executionId` / `resultId`；
  - `fetchPage`：`resultId`、`limit` 1..1000、`cursor` 可为 `null` 且有界。
- 路由只用调用窗口自己的 supervisor；`runtimeGeneration` 取自回复信封，**不接受** renderer 传入的代际决定路由。
- 回复在 Main 侧做结构校验（`executionId`/`resultId` 形态、state 枚举、`sequence >= 1`、`rows` 不超过请求的 `limit`、`columns` 形状）。不合格回 `INVALID_PARAMS`/`INTERNAL`，不把畸形数据送进 renderer。
- **畸形回复不得被推断成「确定未执行」**：Main 只回答「这次调用失败」，执行服务据此把已发出的请求记为 `unknown`，不是失败。
- `listen(QueryStateChanged)` 从 supervisor 的 `onDidNotify` 过滤 `query.stateChanged`，并附上**该通知到达时**的 `runtimeGeneration`；renderer 丢弃代际不匹配的通知。

### 9. 与 N-204 的最小接口合同

```ts
interface INyalaQueryExecutionService {
	readonly onDidChangeExecution: Event<INyalaExecutionRecord>;
	getExecution(queryId: string): INyalaExecutionRecord | undefined;
	getExecutionById(executionId: string): INyalaExecutionRecord | undefined;
	acquireResult(executionId: string, resultId: string): INyalaResultLease | undefined;
	fetchPage(lease: INyalaResultLease, cursor: string | null, limit?: number): Promise<INyalaResultPage>;
	cancel(executionId: string): Promise<void>;
	readonly executions: readonly INyalaExecutionRecord[];
}
```

- N-204 不得调用 `INyalaRuntimeBridge`，不得在服务外保存 `resultId`，不得在释放租约后继续取页。
- 分页缓存的淘汰由 N-204 负责，但必须遵守「按需取页、有界缓存」。

## 未采纳的替代方案

1. **在 Pane 里直接发 RPC**：Pane 会持有执行生命周期，切换标签页或销毁控件时无法判断该不该取消（拒）。
2. **把执行快照存进 `NyalaQueryContext`**：context 因绑定而变，执行必须记住「当时」的目标（拒）。
3. **按 `queryId` 取消**：runtime 只认 `executionId`，按 queryId 会取消错对象（拒）。
4. **终态即释放结果**：`completed` 后结果立刻消失，N-204 永远读不到数据（拒，本版修订）。
5. **`cancel_requested` 直接当 `cancelled`**：Rust 可能仍在提交，UI 会谎报结果（拒）。
6. **失败自动重试**：写语句重试会重复写入；`UNKNOWN_COMMIT_STATUS` 时更严重（拒）。
7. **把结果行缓存进 renderer 的执行记录**：违反「大结果只通过受控分页」的工程红线（拒）。
8. **用重新执行 SQL 恢复被淘汰的结果**：等于重复写入（拒）。

## 后果与限制

- 正面：执行目标在类型上就是一份不可变快照；所有操作按 `executionId`；结果有主、有租约、有上限、有释放路径；未知状态被诚实报告。
- 负面：执行期间再次执行会被拒绝，用户必须先取消；结果占用受 runtime 配额限制，窗口内同时可读的结果数量有限。
- 已知缺口：没有结果网格（N-204/N-205）、没有草稿持久化（N-206）、没有桌面 E2E（N-207）；`readOnly` 只透传给 runtime，客户端不解析 SQL 判断读写；跨执行的事务语义属 N-402。

## 验证

见 [实施拆分与验收矩阵](../nyala-kickoff/docs/32-n203-execution-plan.md)。实现与实测状态记录在该文档 §3 与 `PROGRESS.md` P2.5。核心断言：

- 两个标签页各自执行时只用各自的 session 快照，切换激活标签页不改变任何在途执行的目标；
- `canExecute()` 为 false 时（未绑定、`switching`、runtime 换代）执行被拒绝，且不发出 RPC；
- `query.execute` 迟到回复、`runtimeGeneration` 不匹配、标签页已关闭三种情况下都不会绑定或复活执行；
- `sequence` 跳号会触发一次 `getState` 校准，重复与回退被丢弃，终态不可复活；
- `cancel_requested` 不显示为 `cancelled`，`UNKNOWN_COMMIT_STATUS` 不提供重试；
- 结果在 `completed` 后仍可通过租约读取，最后一个租约释放后才真正 `release`；
- 换代时本地丢弃租约，不向新 runtime 发 `release`；
- Main 进程拒绝白名单外命令与非法参数，畸形回复不让执行被标成「确定未执行」。
