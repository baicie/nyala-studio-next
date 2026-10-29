# ADR-0008 · 可插拔 Agent Harness；Codex app-server 仅作为候选适配器

- Date: 2026-10-29
- Status: **Proposed**（待 PoC 及供应链审查）
- Scope: Agent Host、认证、协议兼容、Runtime Manager

## Context

从零开发通用 Agent Loop 会抢占 SQL Runtime 和 Workbench 的优先级；直接绑定 Codex Thread/Turn/Item 则使 Nyala 的 UI、数据与模型实现强耦合。用户通常不会预装 Codex，可分发性和本地认证须单独设计。

## Decision

1. Nyala `INyalaHarness` 领域接口与 RuntimeManager 独立；第一阶段优先以用户指定的 Codex 可执行文件、`codex app-server` 进程做只读 PoC，不把 Codex Rust Core 合入仓库。
2. `CodexAdapter` 将具体协议版本的事件映射成 Nyala Task/Run/Artifact；不把 Codex 的内部枚举作为 Nyala 持久模型。
3. 未来才考虑经过合法性/来源/签名/哈希审核的按需安装；用户无 Codex 时 SQL IDE 完全可用。
4. Agent Tool Gateway/Policy/Approval/数据库角色是 Nyala 所有 Harness 共同的边界；Codex Shell/File 权限单独限制，不能因 SQL MCP 是只读就误认整体安全。
5. 真实模型认证及数据外发须明确告知和授权，不默认发送连接凭证、全库 Schema、结果行。

## Consequences

多一层 Adapter / 事件映射，换来上游隔离、供应商切换与独立版本升级能力。正式采用前必须验证具体 Codex 版本的协议、Windows/macOS/Linux 二进制可用性、license/Notices、模型认证机制、回滚与错误恢复。

## Alternatives

- 直接使用 VS Code 内置 Chat：保留可作为通用编程辅助入口，但不承担 SQL 专用 Agent Task 业务状态。
- Fork Codex Core：短期不采用，维护成本与更新风险较高。
- 自研通用 Harness：仅作为 A5 独立实验，在有实际任务 Eval 数据后做对照。

## Revisit

A1 PoC 出现强不兼容、受限许可/分发要求、API 不稳定或过高部署成本时，切换仅使用外置 Runtime 或独立 Mock/Native Harness，不反向迫使 SQL 业务层重构。
