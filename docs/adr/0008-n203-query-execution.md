# ADR 0008 · N-203 Query Execution Service 与执行快照

- 状态：Proposed（2026-11-03，`feat/n203-query-execution`，Draft PR 待审）
- 日期：2026-11-03
- 决策域：一个已绑定的查询标签页如何执行 SQL、拥有结果、取消与释放
- 上位文档：[`docs/adr/0007-n202-query-editor-context.md`](0007-n202-query-editor-context.md)（QueryContext、`canExecute`、`switching`）、[`docs/adr/0006-p2-workbench-runtime-bridge.md`](0006-p2-workbench-runtime-bridge.md)（受控 IPC）、[`nyala/rpc/README.md`](../../nyala/rpc/README.md) §4–§5（方法目录、执行状态机）、[`docs/nyala-governance/06-sql-runtime-safety.md`](../nyala-governance/06-sql-runtime-safety.md)（禁止全局 `currentConnection`）、[`docs/nyala-kickoff/docs/25-engineering-rules.md`](../nyala-kickoff/docs/25-engineering-rules.md) 第 6/7/8/9 条

## 背景

N-202 交付了能编辑、能绑定、但**不能执行**的查询标签页：`NyalaQueryEditorPane.getExecutionBinding()` 已经返回一个快照，或在绑定过期/切换中时返回 `undefined`，但没有任何命令使用它。Rust 侧的 `query.execute`、`query.cancel`、`query.getState`、`result.fetchPage`、`result.release` 与 `query.stateChanged` 通知从 N-106/N-108 起就已实现并通过契约测试；Main 进程的白名单目前只放行连接与 metadata 六条命令。

所以 N-203 的全部内容是**接线与所有权**，不是新的执行器：

1. 把 `query.*` / `result.*` 加进 Main 进程白名单，并在那里校验参数与回复；
2. 在 Workbench 里加一个执行服务，把「用户按下 Ctrl+Enter 的那一刻」固定成一份不可变快照；
3. 按 `executionId` 拥有执行、取消、状态推进与结果句柄；
4. 暴露给 N-204 一个最小的只读接口。

### 核心风险

- **执行目标漂移**：标签页 A 绑定 Profile A，用户切到标签页 B（绑定 Profile B）后按 Ctrl+Enter。若命令处理器读「当前激活标签页」或「全局当前连接」，就会对着 B 的会话执行 A 的 SQL。
- **快照过期**：runtime 在执行请求发出后重启，`sessionId` 属于已经消失的进程。不校验代际就会把 `INVALID_SESSION` 当成普通失败，或更糟，把结果归给错误的标签页。
- **结果泄漏**：结果句柄由 Rust 持有，有 TTL 与内存上限。丢失 `resultId` 或漏掉 `release`，都会在 runtime 里堆积到 `RESOURCE_LIMIT`。
- **误报回滚**：`UNKNOWN_COMMIT_STATUS` 表示「可能已提交」。自动重试会重复写入。

## 决策

### 1. 执行入口只有一条，且必须经过 `canExecute()`

```text
Nyala: Execute Current Statement   (Ctrl/Cmd+Enter)
Nyala: Execute Selection           (no default key)
Nyala: Execute Script              (Shift+Ctrl/Cmd+Enter)
        |
        v
INyalaQueryExecutionService.execute(queryId, text, mode)
        |
        +-- 1. 从 document/context 取 context，要求 canExecute(runtimeState) === true
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
- 快照的四个身份字段**整体复制**。若构造后再读到 `undefined`，就不执行并报错，而不是补一个默认值。

### 3. ExecutionId 是唯一的操作身份

```ts
interface INyalaExecutionRecord {
	readonly requestId: string;              // 客户端生成，回复前就有
	readonly executionId: string | undefined; // runtime 回复后确定
	readonly snapshot: INyalaExecutionSnapshot;
	readonly state: NyalaExecutionState;
	readonly sequence: number;
	readonly resultIds: readonly string[];
	readonly error?: INyalaRuntimeErrorObject;
	readonly endedAt?: number;
}
```

- `query.cancel`、`query.getState`、`result.fetchPage`、`result.release` **只按 `executionId`**。不按「当前标签页」「最近的执行」或 `queryId`。
- 一个 `queryId` 同时最多**一个**非终态执行。第二次执行被同步拒绝（提示先取消），而不是排进队列：用户对同一个标签页的第二次点击通常意味着第一次点错了。
- `requestId` 存在的唯一理由是「`query.execute` 还没回，标签页就关了」。回复到达时若该记录已被放弃，立即用拿到的 `executionId` 发 `query.cancel {reason:'user'}`，不把执行复活到已关闭的标签页。

### 4. 状态推进只来自 `query.stateChanged`，且必须防乱序

- 终态：`completed`、`failed`、`cancelled`、`unknown`。到达终态后忽略该 execution 的后续通知。
- 非终态：`queued`、`running`、`streaming`、`cancel_requested`。
- 只接受 `sequence` 严格递增的通知；重复或回退的丢弃。
- 若收到 `sequence > last + 1`，先发一次 `query.getState` 校准，再应用；`getState` 的结果也只在与本地 sequence 比较后才写入。
- `query.execute` 的回复本身带 `state` 与 `sequence`（通常 `sequence: 1`）。回复的 `runtimeGeneration` 与快照不等时，丢弃 `executionId`，记录标为 `failed`，原因「运行时已重启，本次执行未生效」，**不发** `cancel`（新 runtime 不认识它）。
- 结果句柄只在 `resultIds` 出现时登记，且每个 `resultId` 只登记一次。

### 5. 取消是一次请求，不是一次结果

```text
用户取消 -> query.cancel{executionId, reason:'user'} -> accepted?
   accepted=true  -> 状态进入 cancel_requested，等通知变成 cancelled / completed / failed
   accepted=false -> 用回复里的 state 更新；若已终态则结束
   RPC 失败(RUNTIME_LOST / INVALID_SESSION) -> 标 unknown，绝不显示「已取消」
```

- `cancel_requested` **不等于** `cancelled`。Rust 在语句已过最后一个可中断点时仍会 `completed`，这是正确行为。
- 超时由 Rust 以 `QUERY_TIMEOUT` 结束，与用户取消分开呈现。
- `failed` 且错误为 `UNKNOWN_COMMIT_STATUS` 时，UI 必须说明「提交结果未知」，不提供自动重试；N-203 不提供「重试」按钮。

### 6. 结果所有权、上限与释放

- 执行记录只保存 `resultIds` 与元数据，**不缓存行数据**。行数据只能通过 scoped 句柄按页拉取。
- `INyalaResultHandle` 由执行服务发放，N-204 只能通过它取页；N-204 不得直接调用 `INyalaRuntimeBridge`，也不得自己保存 `resultId`。
- `fetchPage`：`limit` 默认 200、硬上限 1000（契约值 `maxPageRows`）；同一 `resultId` 同时只允许一个在途请求；`cursor` 原样回传，不解析。
- `release` 恰好一次：`{released:false}` 视为「已不在」，不是错误；`RUNTIME_LOST` 时本地遗忘。
- 上限：每执行最多 8 个结果句柄，每窗口最多 16 个；超出时先释放「已终态且未被引用」的最旧句柄，仍超出则拒绝新结果并提示关闭结果视图。
- **终止即释放路径**：执行终态、标签页关闭、窗口关闭、runtime 换代。任何路径都不允许把句柄留到下一次执行。
- runtime 换代时进程已死：**本地**清理句柄，不向新 runtime 发 `result.release`。

### 7. 文本模式：选区 / 当前语句 / 全文

- `selection`：编辑器有非空选区时使用选区原文；空白选区拒绝并提示。
- `statement`：光标所在语句，由 `nyalaSqlStatements.ts` 做 SQL-aware 分割：识别 `'...'`（含 `''` 转义）、`"..."`、`` `...` ``、`[...]`、`--` 行注释、`/* */` 块注释，只在顶层 `;` 处切分。光标落在两条语句之间时取前一条；纯注释或空白文档返回 `undefined`，提示「光标处没有可执行语句」，**不**退化为执行全文。
- `script`：整个文档，trim 后为空则拒绝。
- 三个模式共用同一套快照与记录，`mode` 只影响显示与 runtime 的语义标记。

### 8. 键位：Ctrl/Cmd+Enter 覆盖 Monaco 的「在下方插入行」

- `Nyala: Execute Current Statement` 的 primary 是 `Ctrl/Cmd+Enter`，`when: resourceScheme == 'nyala-query' && editorTextFocus`，`weight: KeybindingWeight.WorkbenchContrib`（200）。
- Monaco 的 `editor.action.insertLineAfter` 用同一组合键，weight 是 `EditorContrib`（100）。200 > 100，因此在查询标签页里执行会胜出；在普通文本编辑器里 `when` 不成立，行为不变。
- 这是有意的取舍，必须写进 PR 说明，并用浏览器测试双向断言：查询编辑器里 Ctrl+Enter 触发执行且**没有**插入新行；普通编辑器里 Ctrl+Enter 仍插入行。
- `Shift+Ctrl/Cmd+Enter` 执行全文，`Ctrl/Cmd+Alt+Enter` 不占用（留给未来的「执行并解释」，本阶段不注册）。
- 命令处理器在运行时再次确认活动编辑器是 `NyalaQueryEditorPane`：`when` 只负责 UI 可用性，不是授权。

### 9. Main 进程白名单、参数校验与回复校验

新增 `NyalaRuntimeCommand`：`QueryExecute`、`QueryCancel`、`QueryGetState`、`ResultFetchPage`、`ResultRelease`；新增事件 `QueryStateChanged`。

- 方法映射进 `NYALA_RUNTIME_METHODS`，表外命令继续被拒绝。
- 参数在 `nyalaRuntimeRequest.ts` 校验后才进 RPC：
  - `execute`：`sessionId` 匹配契约 id、`sessionGeneration >= 1`、`sql` 非空且 ≤ 1 MiB（帧上限 8 MiB 的保守余量）、`mode` 枚举、`timeoutMs` 1..600000、`maxInitialRows` 1..10000、`cancelTokenId` 有界；
  - `cancel`：`executionId` + 可选 `reason` 枚举；
  - `getState` / `release`：单个 `executionId` / `resultId`；
  - `fetchPage`：`resultId`、`limit` 1..1000、`cursor` 可为 `null` 且有界。
- 路由只用调用窗口自己的 supervisor；`runtimeGeneration` 取自回复信封，**不接受** renderer 传入的代际决定路由。
- 回复在 Main 侧做结构校验（`executionId`/`resultId` 形态、state 枚举、`sequence >= 1`、`rows` 不超过请求的 `limit`、`columns` 形状）。不合格回 `INVALID_PARAMS`/`INTERNAL`，不把畸形数据送进 renderer。
- `listen(QueryStateChanged)` 从 supervisor 的 `onDidNotify` 过滤 `query.stateChanged`，并附上当前 `runtimeGeneration`；renderer 丢弃代际不匹配的通知。

### 10. 与 N-204 的最小接口合同

```ts
interface INyalaQueryExecutionService {
	readonly onDidChangeExecution: Event<INyalaExecutionRecord>;
	getExecution(queryId: string): INyalaExecutionRecord | undefined;
	getResultHandle(executionId: string, resultId: string): INyalaResultHandle | undefined;
	cancel(executionId: string): Promise<void>;
	readonly executions: readonly INyalaExecutionRecord[]; // 窗口内所有未释放的记录，只读
}

interface INyalaResultHandle {
	readonly resultId: string;
	readonly executionId: string;
	fetchPage(cursor: string | null, limit?: number): Promise<INyalaResultPage>;
	release(): Promise<void>;
}
```

- N-204 不得调用 `INyalaRuntimeBridge`，不得在服务外保存 `resultId`，不得在 `release()` 后继续取页。
- 分页缓存的淘汰由 N-204 负责，但必须遵守「按需取页、有界缓存」。

## 未采纳的替代方案

1. **在 Pane 里直接发 RPC**：Pane 会持有执行生命周期，切换标签页或销毁控件时无法判断该不该取消（拒）。
2. **把执行快照存进 `NyalaQueryContext`**：context 因绑定而变，执行必须记住「当时」的目标；混在一起会让改绑影响在途执行（拒）。
3. **按 `queryId` 取消**：同一标签页可能有 pending 与在途两个概念，按 queryId 会取消错的对象；且 runtime 只认 `executionId`（拒）。
4. **`cancel_requested` 直接当 `cancelled`**：Rust 可能仍在提交，UI 会谎报结果（拒）。
5. **失败自动重试**：写语句重试会重复写入；`UNKNOWN_COMMIT_STATUS` 时更严重（拒）。
6. **把结果行缓存进 renderer 的 execution record**：违反「大结果只通过受控分页」的工程红线（拒）。

## 后果与限制

- 正面：执行目标在类型上就是一份不可变快照；所有操作按 `executionId`；结果有主、有上限、有释放路径；Ctrl+Enter 在查询标签页里语义明确。
- 负面：执行期间再次执行会被拒绝，用户必须先取消；快照只覆盖单次执行，跨执行的事务语义仍属 N-402。
- 已知缺口：没有结果网格（N-204/N-205）、没有草稿持久化（N-206）、没有桌面 E2E（N-207）；`readOnly` 只透传给 runtime，客户端不解析 SQL 判断读写。

## 验证

见 [实施拆分与验收矩阵](../nyala-kickoff/docs/32-n203-execution-plan.md)。核心断言：

- 两个标签页各自执行时只用各自的 session 快照，切换激活标签页不改变任何在途执行的目标；
- `canExecute()` 为 false 时（未绑定、`switching`、runtime 换代）执行被拒绝，且不发出 RPC；
- `query.execute` 迟到回复、`runtimeGeneration` 不匹配、标签页已关闭三种情况下都不会绑定或复活执行；
- `sequence` 跳号会触发一次 `getState` 校准，重复与回退被丢弃；
- `cancel_requested` 不显示为 `cancelled`，`UNKNOWN_COMMIT_STATUS` 不提供重试；
- 结果句柄在终态、关闭、换代时释放，`release` 幂等，上限与 LRU 可测；
- Main 进程拒绝白名单外命令与非法参数，畸形回复不进 renderer。
