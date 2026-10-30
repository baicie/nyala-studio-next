# ADR 0002 · Rust Runtime workspace 与 N-101/N-102 的实现约定

- 状态：Proposed（随 `feat/p1-rust-runtime` 的 PR 审核）
- 日期：2026-10-29
- 决策域：Nyala SQL Runtime（`nyala-runtime` sidecar）的目录、依赖与 RPC v1 实现细节
- 上位文档：[`nyala/rpc/README.md`](../../nyala/rpc/README.md)（可执行合同）、[ADR 0001](0001-rpc-contract-v1.md)、设计包 [ADR-0002 Rust Sidecar](../nyala-kickoff/docs/adr/0002-rust-sidecar.md)、[07-sql-runtime.md](../nyala-kickoff/docs/07-sql-runtime.md)

> 编号说明：本目录（`docs/adr/`）与设计包 `docs/nyala-kickoff/docs/adr/` 各自编号。本文是仓库级 ADR 0002，不替代设计包的 ADR-0002。

## 背景

Backlog N-101（Runtime crate + stdio framing）与 N-102（hello / version / error）是 P1 的第一步。合同 `nyala/rpc/v1` 已冻结，但仓库里还没有任何 Rust Runtime 代码，需要决定 crate 放在哪里、依赖什么，以及合同没有写死的几处行为如何实现。本次范围不含 SQLite 驱动（N-104 起）和 Electron Supervisor（N-103）。

## 决策

### 1. 目录：独立的 `rust/` Cargo workspace

```text
rust/
  Cargo.toml          # workspace：edition 2021、rust-version 1.82、lint 策略
  Cargo.lock          # 二进制 crate，锁文件入库
  rustfmt.toml        # hard_tabs，与 cli/rustfmt.toml、.editorconfig 一致
  crates/nyala-runtime/
    src/{framing,protocol,error,server}.rs、lib.rs、main.rs
    tests/{conformance,stdio}.rs、tests/support/mod.rs
```

路径来自已有设计：[03-architecture-ownership](../nyala-governance/03-architecture-ownership.md) 的目录责任表把 `rust/crates/nyala-*` 列为 Runtime/Driver 的规划位置，[03-architecture](../nyala-kickoff/docs/03-architecture.md) 写的是 `rust/crates/{nyala-core,nyala-runtime,nyala-driver-sqlite,...}`，[16-upstream-trimming](../nyala-kickoff/docs/16-upstream-trimming.md) 把 `rust/*` 列为产品修改空间。

- 不放进上游 `cli/`：`cli/` 是 Code OSS 的 `code-cli` crate，加成员会修改上游跟踪文件、增加同步冲突面。`rust/` 不在上游树内，不改任何上游文件。
- 先只有一个 crate，按模块分文件（07-sql-runtime：“MVP 可从一个 `nyala-runtime` crate + 按模块分文件开始”）。`nyala-protocol`、`nyala-core`、驱动 crate 等到出现第二个使用方时再拆。
- `build/filters.ts` 的 hygiene 文件集不含 `rust/**`，所以不需要改上游构建脚本；Rust 代码的格式由 `cargo fmt` 约束。

### 2. 依赖与运行时中立

- 运行依赖只有 `serde_json`；测试依赖只有 `regex`（测试里的 JSON Schema 子集求值器用它执行 `pattern`）。
- 不引入 Tokio：N-101/N-102 没有并发工作，阻塞式读循环足够。异步运行时随执行、取消与超时（N-106/N-108）引入，届时修订本 ADR。
- 领域代码不依赖 Electron、Tauri 或具体流：`server::serve` 接受任意 `Read`/`Write`，`main.rs` 只把 stdin、stdout、stderr 交给它。
- workspace lint：`unsafe_code = "forbid"`；clippy `print_stdout = "deny"`、`dbg_macro = "deny"`，防止日志混入协议流。日志写入注入的 diagnostics 流（生产为 stderr），且不含任何 payload 内容。

### 3. 合同是唯一事实源

- 不手写一套 DTO：envelope 与 params 以 `serde_json::Value` 显式校验。TS/Rust 类型生成是 N-110 的工作，在此之前多一套 DTO 就多一个事实源。
- `error.rs` 的错误表与 `nyala/rpc/v1/error-codes.json` 逐项比对（`tests/conformance.rs`），任何一边单独改动都会让测试失败。
- `tests/conformance.rs` 直接读取 `nyala/rpc/v1/` 下的 schema、错误码表与 `conformance.ndjson`：每条样例经 Rust 编码后逐字节和粘包解码还原；样例与负向对照经同一个 schema 子集求值器校验；每个样例请求交给 `Server`，回复须符合 envelope schema、方法 result schema 与错误码表。不复制任何样例或错误码。

### 4. 合同未写死之处的实现选择

| 情形 | 合同依据 | 本实现 |
|---|---|---|
| 进程退出码 | README §3 只规定 major 不匹配退出码为 2 | `0`：输入在帧边界结束；`1`：流不可信（零长度、超限、帧中途 EOF、I/O 错误）；`2`：`PROTOCOL_MISMATCH` |
| 零长度帧 | §1：回 `INVALID_REQUEST` 后关闭连接 | 回复后以退出码 1 结束 |
| 超限帧 | §1：回 `RESOURCE_LIMIT` 并立即终止 | 读到 4 字节前缀即判定，不等待 payload；回复后以退出码 1 结束 |
| hello 前的帧上限 | §1：客户端在收到 hello 前不得发送超过 1 MiB 的帧 | Runtime 在 hello 成功前按 1 MiB 执行，之后按通告的 `frameMaxBytes`（8 MiB） |
| major 不匹配 | §3 | 先比较 `protocolMajor` 再校验其余参数（其他 major 的 hello 可能字段不同），回 `PROTOCOL_MISMATCH` 后以退出码 2 结束 |
| minor 不同 | §3：按 `features` 协商 | 接受；`features` 只回本构建实现且客户端提供的能力位。本构建尚无驱动，所以返回空数组 |
| 重复 `runtime.hello` | §4：每连接一次，未定错误码 | `INVALID_REQUEST`，连接继续 |
| hello 前调用其他目录内方法 | §3：只允许 hello 与 health，未定错误码 | `PROTOCOL_MISMATCH`（错误码表描述为“能力位缺失”），连接继续 |
| 未协商能力位的方法 | §3：客户端不得调用 | `PROTOCOL_MISMATCH`，连接继续 |
| 不在 v1 目录的方法（含 `transaction.*`） | §2 | `METHOD_NOT_FOUND` |
| 无 `id` 的消息 | §2：通知无响应；v1 没有客户端到 Runtime 的通知 | 静默忽略 |
| 读不出合法 `id` 的 payload（非法 JSON、非 object、id 不符合 pattern、帧错误） | JSON-RPC 2.0 用 `"id": null`；v1 `failure` schema 要求字符串 id | 回 `"id": null`。这是**已知的合同缺口**，见“后续项” |
| `runtimeBuild` | §2 | crate 版本 `0.1.0-dev.0`，与样例一致 |
| `runtime.health` 计数 | §4 | `status: "ok"`，三个计数在 Session/Execution/Result 落地前固定为 0 |

### 5. 工具链

- `rust-version = "1.82"`（代码用到 `Option::is_none_or`）；clippy 的 `incompatible_msrv` 会按这个版本检查 std API 的使用。
- 不加 `rust-toolchain.toml`：本地与 CI 用 stable，避免强制下载特定工具链；需要固定时另行决定。

## 未采纳的替代方案

- **加入 `cli/` workspace**：会修改上游 `cli/Cargo.toml`，计入补丁数并在每次 Code OSS 同步时产生冲突。
- **一次拆出 `nyala-protocol` / `nyala-core` / `nyala-runtime`**：现在只有一个使用方，拆分只增加样板；设计包也建议先单 crate。
- **serde derive DTO**：手写类型与合同并存即两个事实源，违背 README §8，等 N-110 的生成方案。
- **Tokio + 异步 stdio**：此阶段没有并发需求，留到执行与取消落地时再引入。

## 后果

- 新增 Nyala 自有目录 `rust/`，不修改任何上游跟踪文件；`nyala/upstream-base.json` 的 `patchCount` 不变。
- CI：`.github/workflows/nyala-ci.yml` 新增独立的 `Rust runtime` job，在 `rust/` 下跑 `cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`，使用 runner 预装的 stable 工具链，不引入第三方 toolchain action；`product` 与 `client` job 不改。
- 合同缺口（id 为 null 的失败回复）不在本次修改：`nyala/rpc/**` 冻结，修改须走合同变更流程。测试里有一条断言会在合同接受 `"id": null` 时失败，提醒同步更新本 ADR 与测试。

## 后续项

1. **合同**：v1 `failure` 允许 `"id": null`（或另定读不出 id 时的回复规则），同步 schema、`conformance.ndjson`、README 与校验脚本。
2. **合同**：为“重复 hello”“hello 前调用其他方法”写明错误 kind，确认或替换上表的选择。
3. **CI**：Rust job 已随本 PR 加入，只覆盖 `ubuntu-latest` + stable。Windows / macOS runner 与 MSRV 1.82 构建仍未覆盖。
4. **N-103**：Electron Main Supervisor 按上表的退出码区分“流错误”与“版本不匹配”（后者不得重启同一版本）。
5. **N-106 起**：请求 id 复用检测、并发执行、取消竞态；引入异步运行时时修订本 ADR。

## 证据

环境：Windows 11 Pro 10.0.26200（x86_64）· rustc / cargo 1.96.0 · clippy 0.1.96 · Node v24.16.0。

```bash
cd rust
cargo fmt --all --check                                   # PASS
cargo clippy --workspace --all-targets -- -D warnings     # PASS
cargo test --workspace                                    # PASS：单元 30 + conformance 7 + stdio 10
cd ..
npm run nyala:validate-rpc                                # PASS（合同未改）
```

- `tests/stdio.rs` 启动真实的 `nyala-runtime` 进程，通过管道验证：hello/health 往返、逐字节与粘包写入、零长度与超限帧（含 hello 前 1 MiB / hello 后 8 MiB 的边界）、非法 payload 后连接继续、帧中途 EOF、major 不匹配退出码 2、stdout 只有完整帧且日志只在 stderr、payload 内容不出现在 stdout 或 stderr。
- GitHub Actions：`Rust runtime` job 在 `ubuntu-latest` 上执行同样三条命令，真实结果记录在 PR 描述中。
- 未验证：MSRV 1.82 实际构建（本机 1.91.1 工具链损坏、1.80.0 早于 MSRV）记 NOT RUN；macOS 记 NOT RUN。
