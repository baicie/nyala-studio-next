# ADR-0006: AI Agent 和 Tauri 不属于 SQL MVP

- Date: 2026-10-18
- Status: Accepted (design proposal)

## Decision

先交付 SQL Editor/Result/Connections；仅保留 Agent Tool API 的可扩展边界，不引入模型供应商/自动执行工具链。Tauri 也不是主线交付条件。

## Rationale

主要动机是个人使用和 IDE 架构学习，而非营销竞争。过早引入 AI、Tauri 会混淆根因并挤占 SQL/Workbench 研究时间。

## Revisit

当 0.2–0.3 已稳定、自有 Query Authority、安全与审批具备测试后，可独立立项最小 Agent；当 Electron 基线有实际体积/内存测量后可开展 Tauri 实验。
