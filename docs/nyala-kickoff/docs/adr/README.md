# ADR · Architecture Decision Records

所有关键架构决策采用 `Status: Accepted | Proposed | Superseded`；记录日期、背景、决策、代价、备选与触发重新评估的条件。

| ADR | 标题 | 状态 |
|---|---|---|
| [0001](0001-code-oss-electron.md) | Code OSS Fork 与 Electron 主线 | Accepted |
| [0002](0002-rust-sidecar.md) | 独立 Rust SQL Runtime | Accepted |
| [0003](0003-mixed-extension-contribution.md) | Workbench + Extension API 混合 | Accepted |
| [0004](0004-upstream-maintenance.md) | 上游同步、裁剪与实验隔离 | Accepted |
| [0005](0005-sql-scope.md) | SQLite → PG → MySQL、SQL-first | Accepted |
| [0006](0006-no-default-ai.md) | Agent 不作为 MVP 核心 | Accepted |

注：此处 Accepted 指**本设计包中建议冻结的设计决策**，不是代码已经实现；如用户在开工前改变取舍，应更新 ADR 状态。

## v1.1 Proposed ADRs（仅文档提案，未得到仓库批准）

- [ADR-0007: SQL-first / Task-first 双工作区](0007-sql-first-task-first-workspace.md)
- [ADR-0008: Codex app-server 作为可替换 Harness Adapter](0008-optional-codex-app-server-adapter.md)

旧 ADR-0006「AI Agent 和 Tauri 不属于 SQL MVP」**继续保持 Accepted，不覆盖、不删除**。新增提案仅确立远期架构。

仓库级 ADR 另见 [`docs/adr/`](../../../adr/)（当前 [0001 RPC 合同 v1.0](../../../adr/0001-rpc-contract-v1.md)），与本目录编号相互独立；引用时写明目录，避免两个 0001 混淆。
