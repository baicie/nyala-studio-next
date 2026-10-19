# ADR-0002: Rust SQL Core 作为独立 Sidecar

- Date: 2026-10-18
- Status: Accepted (design proposal)

## Context

希望学习 Rust + 桌面多进程，未来探索 Tauri，同时确保数据库执行状态/安全和结果缓存不与 UI 交织。

## Decision

Electron Main 监督独立 Rust 进程；stdio 4-byte length prefix + UTF-8 JSON、版本协商 RPC；SQL Domain 保持 Runtime-neutral。数据库连接和结果仅由 Runtime 管理。

## Alternatives

Electron Node Driver（生态成熟但与 Rust 探索目标不符）；N-API Native Addon（ABI 耦合、崩溃隔离较差）；本地 HTTP server（端口/鉴权管理复杂）。

## Consequences

必须做 RPC contract、故障恢复、背压与 Resource Registry；少量性能损耗换进程隔离与未来迁移空间。流控性能不足时可增加共享内存/二进制编码能力，但需要基准数据和 ADR。
