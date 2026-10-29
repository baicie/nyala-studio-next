# 31 · SQL-first Workbench 的专业产品体验（v1.1）

> 这份设计用于防止未来 Agent Workspace 抢走核心专业工具的产品主导地位。

## 1. 专业工作区原则

- SQL 编辑器、连接、查询结果、Schema、Explain、History 是 Nyala 的一等对象，而不是聊天框附属卡片。
- 当前 Tab 的 `profileId + sessionId + sessionGeneration + transactionId?` 明确且可见；切换连接不得静默改变正在执行的目标。
- `SqlExecutionContext` 必须在 Command/EditorInput/QueryService/Rust Runtime 贯通，而不是 mutable global `currentConnection`。
- 执行是显式用户动作；可选择当前语句/选区/文件，执行范围总是可见；危险写操作前展示目标 DB/影响范围。

## 2. 核心交互

| 用户意图 | 主入口 | 专业产物 |
|---|---|---|
| 找表/字段/索引 | Connections Tree / Quick Open | Schema Explorer |
| 写 SQL | 原生 Text Editor / LSP | 可保存 SQL Draft |
| 执行查询 | Command / Keybinding | Query Execution + ResultHandle |
| 查看大量结果 | Grid 虚拟化/分页 | Result Tab，受限导出 |
| 性能分析 | Explain / Query Metrics | Plan Tree + 可审查报告 |
| 长流程分析 | Investigate with Agent | Task Timeline + SQL/Plan Artifacts |

## 3. 结果 Grid 与状态

- 仅按 Page/ResultHandle 拉取；大结果不一次性经过 Electron IPC。
- 正确显示 int64/decimal、NULL、时间与时区、BLOB、截断信息；不得让 JS Number 隐式丢精度。
- 取消与超时之后，UI 能说明已取消/取消待确认/最终状态未知。
- Draft 恢复不能触发 SQL 自动重放；ResultHandle 过期不能自动静默读取生产数据。

## 4. 可选 Agent Workspace 不改变 SQL 安全

Agent 生成 SQL Proposal → 原生 SQL EditorInput → 用户可修改与执行。Agent 可以附 Plan Evidence，但无法替代数据库查询的执行授权。Artifact 打开后保留 connectionScope、sourceRunId、createdAt、schemaSnapshotRef；切换 Tab 连接时需要重新验证范围。

## 5. 首个真正能用的 MVP

`在 Connections 中打开 SQLite → 新建 SQL Tab → SELECT 1 → 在 Grid 看到结果 → 保存 SQL Draft → 重启恢复`。这条故事完成之前，不把桌面 Agent UI 作为核心发布承诺。
