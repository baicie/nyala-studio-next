# ADR-0007 · SQL-first / Task-first 双工作区

- Date: 2026-10-29
- Status: **Proposed**（未入仓库，须由独立设计 PR 审核）
- Scope: Agent 产品交互，不改变 SQL MVP 的发布条件

## Context

通用 Coding Agent 的聊天记录与文件修改工作流适合仓库编码，但 SQL IDE 用户需要持续操作结构化对象：Connections、SQL Editor、ResultHandle、Grid、Explain 和 Transaction。把 SQL 工作区简化成聊天 UI 会丢失精确控制、上下文身份和大结果检视能力；完全复用 VS Code 内置 Chat 又会在 Code OSS 上游升级时引入较大侵入面。

## Decision

1. Nyala 保持 SQL Workspace 为默认工作区。
2. 在 P2 SQL 工作流可靠后，开发 Task-first Agent Workspace；它管理 Task/Run/Event/Approval/Artifact，而不是只显示消息数组。
3. 任何 SQL Proposal、Plan、Result 都必须可映射到原生 Workbench Editor/View；Agent 输出仅为可审查候选成果。
4. Agent 不能改变 Query Authority 规则，也不能自动将建议 SQL 投入生产 DB 执行。
5. 通过 Nyala Contribution/DI/EditorInput 实现新 UI，避免修改 Code OSS 内置 Chat 核心。

## Consequences

需要持久 Task/Artifact Domain、事件映射与数据库权限边界，但 SQL IDE 不依赖模型可用性即可正常运行。此 ADR 与 ADR-0006 并存：批准未来交互方向，不授权提前将 Agent 塞入 P1/P2 的交付门槛。

## Alternatives

- Chat-only：不采用，复杂结果/Schema/执行计划的交互成本高。
- 全面 Fork VS Code Chat：不采用，上游同步与内部 API 漂移风险高。
- 完全不提供 Agent：保留为无 AI 发行配置，但不作为唯一长期研究方向。

## Revisit

真实 SQL Workbench 达成 P2 Exit 后，进行原型、可访问性测试与可用性评估；若双模式切换引入不必要复杂度，可将 Agent Workspace 降级为 Task Pane，但继续保留 Task/Artifact 模型。
