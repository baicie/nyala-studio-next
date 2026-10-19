# ADR-0005: 首期 SQLite 闭环，其后 PostgreSQL 和 MySQL

- Date: 2026-10-18
- Status: Accepted (design proposal)

## Decision

SQLite 完成第一条完备 Desktop 垂直切片；PostgreSQL 是第一个生产级网络数据库驱动；MySQL 在核心执行/结果/安全体系稳定后进入 Preview。通过 Capability 暴露数据库差异。

## Consequences

初期支持数据库数量少，但能对取消、只读、结果类型、错误语义建立可靠基线。多驱动开发不得阻塞学习 Workbench 的主线。
