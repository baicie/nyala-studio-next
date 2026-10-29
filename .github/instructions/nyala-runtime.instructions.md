---
description: 'Nyala IPC/Rust/SQL execution contract and database security; applies to the Nyala runtime namespace.'
applyTo: 'nyala/rpc/**,rust/crates/nyala-*/**,scripts/nyala/**'
---

# Nyala Runtime Instructions

- Read `docs/nyala-governance/04-engineering-style.md` and `06-sql-runtime-safety.md`.
- `nyala/rpc/v1/` schema/error catalog/conformance is the protocol source of truth; no independent conflicting DTO set.
- Keep Rust domain independent of Electron/Tauri; expose bounded and validated RPC with version negotiation, cancellation, structured error and explicit ResultHandle lifecycle.
- Never treat SQL regex or a UI toggle as a read-only security boundary. No uncertain write/COMMIT auto-replay; explicit connection/transaction ownership.
- Do not log credentials, query parameters, sensitive row data or model-private contexts.
- Test partial frames, timeouts, disconnects, concurrency, large results and database-specific capabilities.
