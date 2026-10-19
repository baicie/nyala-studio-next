# ADR-0003: 内部 Workbench Contribution 与标准 Extension 并用

- Date: 2026-10-18
- Status: Accepted (design proposal)

## Decision

SQL Connections、Query Editor 和 Result Grid 深度集成用 Workbench Contribution；SQL 语言/格式化/LSP 等优先使用稳定 VS Code Extension API。Nyala 专用 SPI 限制在数据库能力。

## Rationale

达到 SQL-first 体验与研究 IDE 核心的目标，同时避免全面修改 Workbench 内核和重造扩展生态。

## Consequences

存在两类 API 的维护职责；内部 Contribution 在上游升级时需要更多回归。对 Proposed API 不承诺兼容第三方扩展。
