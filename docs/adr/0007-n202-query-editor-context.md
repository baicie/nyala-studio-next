# ADR 0007 · N-202 Query EditorInput 与 QueryContext

- 状态：Proposed（2026-11-03，`feat/n202-query-editor-context`，Draft PR 待审）
- 日期：2026-11-03
- 决策域：一个 SQL 查询标签页的身份、文本归属、执行目标与生命周期
- 上位文档：[`docs/adr/0006-p2-workbench-runtime-bridge.md`](0006-p2-workbench-runtime-bridge.md) §4/§6.1（Profile 身份、连接尝试）、[`docs/nyala-kickoff/docs/05-workbench-integration.md`](../nyala-kickoff/docs/05-workbench-integration.md)（QueryEditor Input 身份）、[`docs/nyala-governance/06-sql-runtime-safety.md`](../nyala-governance/06-sql-runtime-safety.md)（禁止全局 `currentConnection`）

## 背景

N-201 已经把连接做成一棵真实的树，并且每个连接的身份是 `INyalaConnectionHandle`（`profileId` + `sessionId` + `sessionGeneration` + `runtimeGeneration`）。缺的是**工作台里能写 SQL 的地方**：一个原生编辑器标签页，它知道自己属于哪个查询、可以连到哪个连接，并且在运行时重启或连接断开之后不会悄悄换一个目标。

硬约束：

1. 不得从全局「当前连接」推断执行目标。两个标签页绑不同 Profile，切换激活不得改变任何一侧的绑定。
2. 不得另造编辑器 Tab 系统，也不得重写通用 `EditorService`。必须复用 `EditorInput`/`EditorPane`、`IEditorService`、文本模型、DI 与 `Disposable`。
3. 标签页 URI 不得携带路径、连接串、用户名、密码或 Token。
4. 关闭标签页要释放监听器与编辑器资源。

## 决策

### 1. 三个对象，三种身份

| 对象 | 回答的问题 | 身份 | 生命周期 |
|---|---|---|---|
| `NyalaQueryEditorInput` | 「这是哪个查询标签页？」 | `queryId`（uuid） | 标签页存在期间；`dispose` 时销毁模型与上下文 |
| `NyalaQueryContext` | 「这个查询能对哪个会话执行？」 | 无独立 id；每个 `queryId` 恰好一个 | 窗口内，由 `INyalaQueryContextService` 持有 |
| `NyalaQueryEditorPane` | 「怎么显示与编辑？」 | 每个编辑器组一个实例 | 由工作台按组创建与释放 |

- `queryId` 是 EditorInput 身份，也是文本模型的 URI 键（`nyala-query://local/<queryId>`）。**同一个 `queryId` 复用同一模型**；不同 `queryId` 的模型与上下文完全独立。
- Session Handle 是运行时身份，只存在于 `NyalaQueryContext.binding` 里。它是绑定时**整体快照**的 `{profileId, profileName, sessionId, sessionGeneration, runtimeGeneration}`，绝不会由新旧字段拼接出来。
- Pane 不持有连接状态：它每次向上下文与 `INyalaConnectionService.runtimeState` 询问。

```text
QueryEditorInput (queryId, model, dirty)
  +-> INyalaQueryContextService (per window)
        +-> NyalaQueryContext (one per query)
              +-> binding: { profileId, sessionId, sessionGeneration, runtimeGeneration }
                    +-> INyalaConnectionService (N-201) -> bridge -> runtime
```

### 2. URI 只含查询 id

`nyala-query://local/<queryId>`。

- `authority` 固定为 `local`，`path` 只有 uuid，没有 query、没有 fragment。
- 需要「哪个数据库」时**不**从 URI 读取：它来自上下文里的 Profile（标题与状态行走 `displayName` 与 `target.path`）。因此窗口标题、序列化布局、崩溃转储里都不会出现路径或凭据。
- 打开时 `IEditorResolverService` 以 `RegisteredEditorPriority.exclusive` 注册 `nyala-query://local/**`，`createEditorInput` 只从 URI 里取 `queryId`，别的一律不接受。

### 3. 绑定是显式动作，失效是单向的

- 唯一的绑定入口是 `Nyala: Change Query Connection`（`nyala.query.changeConnection`），它对**当前激活标签页**操作，先 `quickInput.pick` 选 Profile，再 `INyalaQueryContextService.bind(context, profileId)`。
- `bind` 若目标 Profile 已有会话就采用它，没有就先 `connect`；`await` 之后重新读取该行，用**读到的** handle 整体绑定，避免把 `await` 之前的旧字段带进来。
- 变更是单向的：`NyalaQueryContextService` 订阅 `onDidChangeConnections` 与 `onDidChangeRuntime`，只要出现以下任一情况就 `unbind`，绝不自动改绑：
  - runtime 换代（`generation` 变化）→ `runtime-restarted`；
  - runtime `failed`/`stopped` → `runtime-unavailable`；
  - Profile 断开或行消失 → `connection-closed`；
  - Profile 在标签页背后被重连（同一 Profile、新的 `sessionId`）→ `connection-closed`。这条最重要：新会话不是用户为**这个**标签页选的。
- Pane 的执行判定是 `context.canExecute(runtimeState)`，它同时要求「有 binding」且「runtime ready 且代际相同」。因此即使行状态尚未传到，runtime 先换代的那一刻标签页就已经拒绝执行。
- 没有绑定的标签页**照常编辑**（文本、光标、选区、撤销都是普通 Monaco 行为），只是没有执行目标。`getExecutionBinding()` 返回 `undefined`。

### 4. 复用，而不是重写

| 需求 | 采用的既有机制 |
|---|---|
| 标签页/分组/恢复 | `EditorInput` + `IEditorService.openEditor` |
| 编辑器控件 | `AbstractTextCodeEditor`（`CodeEditorWidget`），与 `TextFileEditor`/`SearchEditor` 同层 |
| 注册 | `IEditorPaneRegistry.registerEditorPane` + `IEditorResolverService.registerEditor` + `IEditorFactoryRegistry.registerEditorSerializer` |
| 文本模型 | `IModelService.createModel` / `getModel` / `destroyModel`，language 为内置 `sql` |
| 布局与主题 | Workbench 常规 CSS + `--vscode-*` 变量，未新增自定义颜色或全局选择器 |
| 释放 | 全部走 `this._register` / `DisposableStore`；`dispose` 顺序为监听器 → 上下文释放 → 模型销毁 |

序列化只写 `{ queryId, text }`：会话、路径、凭据在结构上无法进入布局。反序列化对 `queryId` 做 `[A-Za-z0-9_-]+` 校验，坏数据返回 `undefined` 而不是猜一个标签页。

### 5. 生命周期

- `NyalaQueryEditorInput.dispose()`：清 `modelDisposables`（内容监听）→ `contextService.release(queryId)` → `modelService.destroyModel(resource)`。
- `NyalaQueryContextService` 是上下文的**所有者**：`dispose()` 释放所有仍存活的上下文（即便某个标签页从未关闭），因此窗口关闭不会留下悬空 Emitter。
- `NyalaQueryEditorPane` 在 `setInput` 切换、`clearInput`、`dispose` 三处都解除上一个上下文的 `onDidChangeBinding` 监听；`clearInput` 还把控件模型置空。
- 二次 `restoreProfiles`、重复 `bind`、对已释放上下文 `bind` 都被拒绝或幂等（见测试）。

## 明确不做（N-202 范围）

不实现 N-203 的执行命令与快捷键（`Ctrl/Cmd+Enter`）、N-204/N-205 结果面板与网格、N-206 草稿持久化、N-207 桌面 E2E，也未引入 PostgreSQL/MySQL 或 Agent。`getExecutionBinding()` 与 `setText()` 是为这些后续任务留的最小接口，没有为它们预先造抽象。

## 未采纳的替代方案

1. **一个全局 `currentConnection` 或 `activeConnection` 服务**：两 Tab 串库，直接违反 `06-sql-runtime-safety.md` 第 1 条（拒）。
2. **把 `profileId`/`sessionId` 编码进 URI**（例如 `nyala-query://local/<profile>?db=...`）：路径与会话进入窗口标题与序列化布局，且让「同一查询换连接」变成换 URI，从而丢掉模型与撤销历史（拒）。
3. **让 Pane 自己 `connect`**：编辑器控件会因此持有连接生命周期，关闭标签页的时机与断开时机纠缠在一起（拒）。
4. **断开后自动重连/自动改绑**：用户会对着一个不是自己选的连接执行 SQL，而且旧标签页的事务语义不可控（拒）。
5. **自定义 `EditorInput` 序列化整个上下文**：跨 reload 的会话本就失效（ADR 0006 §4），序列化它只会制造「看起来已连接」的假象（拒）。

## 后果与限制

- 正面：两个标签页的执行目标在类型上就是两个对象；URI 无敏感信息；runtime 换代与连接断开都会让标签页显式变为未绑定；编辑器是原生标签页，Split、分组、恢复、关闭确认都走工作台既有行为。
- 负面：新建标签页默认未绑定，用户必须多一步选择连接；`Change Query Connection` 每次都是显式操作。
- 已知缺口：没有「保存为 `.sql` 文件并保持绑定」的完整 Save As 流（`saveToFile` 已实现但未接命令，留给 N-206）；没有草稿持久化，关闭标签页文本即丢失（N-206）；没有执行命令（N-203）。

## 验证

`src/vs/workbench/contrib/nyala/test/browser/nyalaQueryEditor.test.ts`（17 项，Chromium 实跑）与 `.../test/common/nyalaQueryContext.test.ts`（14 项，node runner）：

- 两个标签页绑不同 Profile，各自 session 独立；重新绑定 A 不影响 B。
- 同一 Profile 上两个查询是不同对象，释放其一不影响另一。
- runtime 换代、runtime 失败、Profile 断开、Profile 被重连四种情况都会解除绑定，理由可读，且不会自动改绑。
- 未绑定标签页不会采用别的 Profile 的连接；`getExecutionBinding()` 为 `undefined`。
- URI 断言逐字段（scheme/authority/path/query/fragment）且断言不含路径与会话；序列化内容断言不含 `alice`、`s_a`、`private.sqlite`。
- 每个 `queryId` 一个模型，语言为 `sql`；关闭后模型被销毁；脏状态随 `markSaved` 变化。
- Pane 切换输入后不再响应旧标签页的绑定变化。
- 命令注册、标题菜单条目（仅 `resourceScheme === nyala-query` 时出现）与 `Nyala: New Query` 走 `IEditorService.openEditor` 均有断言。

**NOT RUN**：桌面原生 E2E（连接→输入→执行→结果→重启）属 N-207；未在 macOS/Linux 上运行。
