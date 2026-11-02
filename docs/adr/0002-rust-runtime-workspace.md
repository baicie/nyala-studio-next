# ADR 0002 · Rust Runtime workspace 与 N-101/N-102 的实现约定

- 状态：Accepted（2026-10-30 随 PR #25 合入 `nyala/main`，squash `7bfc4fc2a68`）
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
    src/{framing,protocol,error,server,connection,sqlite,metadata,query,value}.rs、lib.rs、main.rs
    tests/{conformance,stdio}.rs、tests/support/mod.rs
```

路径来自已有设计：[03-architecture-ownership](../nyala-governance/03-architecture-ownership.md) 的目录责任表把 `rust/crates/nyala-*` 列为 Runtime/Driver 的规划位置，[03-architecture](../nyala-kickoff/docs/03-architecture.md) 写的是 `rust/crates/{nyala-core,nyala-runtime,nyala-driver-sqlite,...}`，[16-upstream-trimming](../nyala-kickoff/docs/16-upstream-trimming.md) 把 `rust/*` 列为产品修改空间。

- 不放进上游 `cli/`：`cli/` 是 Code OSS 的 `code-cli` crate，加成员会修改上游跟踪文件、增加同步冲突面。`rust/` 不在上游树内，不改任何上游文件。
- 先只有一个 crate，按模块分文件（07-sql-runtime：“MVP 可从一个 `nyala-runtime` crate + 按模块分文件开始”）。`nyala-protocol`、`nyala-core`、驱动 crate 等到出现第二个使用方时再拆。
- `build/filters.ts` 的 hygiene 文件集不含 `rust/**`，所以不需要改上游构建脚本；Rust 代码的格式由 `cargo fmt` 约束。

### 2. 依赖与运行时中立

- 运行依赖：`serde_json`；N-104 起加入 `rusqlite`（`bundled`，见 §6），N-105/N-106 起再启用它的 `column_decltype`（结果列的声明类型）与 `hooks`（`progress_handler`，超时靠它结束运行中的语句）两个 feature。测试依赖只有 `regex`（测试里的 JSON Schema 子集求值器用它执行 `pattern`）；集成测试用运行依赖里的 `rusqlite` 生成临时数据库。
- 不引入 Tokio：N-101/N-102/N-104 没有并发工作，阻塞式读循环足够。异步运行时随执行、取消与超时（N-106/N-108）引入，届时修订本 ADR。
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
| minor 不同 | §3：按 `features` 协商 | 接受；`features` 只回本构建实现且客户端提供的能力位。N-106 起本构建实现六个能力位（`sqlite`、`metadata.listObjects`、`query.execute`、`query.cancel`、`result.fetchPage`、`result.release`），最多返回这六个 |
| 重复 `runtime.hello` | §4：每连接一次，未定错误码 | `INVALID_REQUEST`，连接继续 |
| hello 前调用其他目录内方法 | §3：只允许 hello 与 health，未定错误码 | `PROTOCOL_MISMATCH`（错误码表描述为“能力位缺失”），连接继续 |
| 未协商能力位的方法 | §3：客户端不得调用 | `PROTOCOL_MISMATCH`，连接继续 |
| 不在 v1 目录的方法（含 `transaction.*`） | §2 | `METHOD_NOT_FOUND` |
| 无 `id` 的消息 | §2：通知无响应；v1 没有客户端到 Runtime 的通知 | 静默忽略 |
| 读不出合法 `id` 的 payload（非法 JSON、非 object、id 不符合 pattern、帧错误） | JSON-RPC 2.0 用 `"id": null` | 回 `"id": null`。v1 `failure` 已通过 2026-10-30 勘误允许该值（`$defs/failureId`，见 [ADR 0001](0001-rpc-contract-v1.md)） |
| `runtimeBuild` | §2 | crate 版本 `0.1.0-dev.0`，与样例一致 |
| `runtime.health` 计数 | §4 | `status: "ok"`；`activeSessions` 是当前 open 的 Session 数（N-104 起）；`activeExecutions` 为 0（v1 在 `query.execute` 内跑到终态，回复构造时没有运行中的执行，样例会话在 `pendingResults: 1` 时也报 0）；`pendingResults` 是尚未 release 的结果句柄数（N-106 起，样例 rq_002 为 1） |
| `connection.*` 的能力位 | §3：v1 能力位含 `sqlite`，方法目录未写每个方法对应哪个能力位 | 四个 `connection.*` 方法都要求协商出 `sqlite`；hello 前或未协商时回 `PROTOCOL_MISMATCH`，连接继续 |
| 文件级失败的 error kind | 错误码表没有“文件不存在 / 不是 SQLite / 已损坏”；§8 冻结 v1，不能新增 kind | 相对路径、`:memory:`、`file:` URI、不存在、目录或非普通文件、0 字节文件、非 SQLite（`SQLITE_NOTADB`）、损坏（`SQLITE_CORRUPT`）→ `INVALID_PARAMS`。这扩展了表里“params 未通过方法 schema 校验”的含义，见后续项 6 |
| 操作系统拒绝访问 | 同上 | 读文件被拒（`io::ErrorKind::PermissionDenied`）或 SQLite 回 `SQLITE_PERM` / `SQLITE_READONLY` → `PERMISSION_DENIED` |
| 打开探测时库被锁 | 同上；`QUERY_TIMEOUT` 描述为“超过 deadlineMs 或驱动超时” | busy timeout（`OPEN_BUSY_TIMEOUT` = 2 s）到期仍拿不到锁（`SQLITE_BUSY` / `SQLITE_LOCKED`）→ `QUERY_TIMEOUT`。Runtime 一次只处理一个请求，这 2 s 也是其他请求最多被阻塞的时间 |
| 文件级错误的 `retryable` | 错误码表给出默认值 | 一律用表中默认值（以上三个 kind 都是 `false`），`tests/conformance.rs` 逐项比对 |
| `safeDetail` 内容 | §7：不得含文件系统路径中的用户名 | 只写原因（如 `file does not exist`），不含路径，也不转发 SQLite 原文（rusqlite 会把路径拼进 `SQLITE_CANTOPEN` 的消息）。stderr 日志同样不含路径 |
| `connection.test` 打不开库 | §4：结果是 `ok`、`serverVersion?`、`elapsedMs`；`ok:false` 没有原因字段 | 回与 `connection.open` 完全相同的错误响应；成功时 `ok` 恒为 `true`，v1 实现里不会出现 `ok:false`。`serverVersion` 是内置 SQLite 库版本 |
| 文件不存在时是否创建 | 未写 | `open` 与 `test` 都不带 `SQLITE_OPEN_CREATE`，文件不存在时回 `INVALID_PARAMS`，且不会创建数据库文件或其他文件。已存在的 WAL 库见下面“WAL 库的辅助文件”一行 |
| 可接受的路径 | 09-drivers-metadata 提到“文件路径/`:memory:`、符号链接、只读标志”，合同未写 | 只接受绝对路径指向的普通文件。拒绝 `:memory:` 与 `file:` URI（大小写不敏感）、含 NUL 的路径。Windows 只接受盘符绝对路径（`C:\…`）：拒绝 UNC（`\\server\share\…`，会发起 SMB 连接，可能把 NTLM 凭据发给外部主机）、设备路径（`\\?\…`、`\\.\…`）、盘符相对路径（`C:foo`）和根相对路径（`\foo`）；这项检查针对输入字符串，不访问文件系统 |
| 符号链接 | 同上 | `fs::canonicalize` 跟随链接，目录、普通文件、0 字节等检查针对链接目标；Windows 上规范化结果不是 `\\?\<盘符>:\…`（如 `\\?\UNC\…`）时拒绝。打开时加 `SQLITE_OPEN_NOFOLLOW`，防止检查后路径被换成链接，但 SQLite 只在 Unix 上执行该检查 |
| URI 文件名 | bundled 构建定义了 `SQLITE_USE_URI`，即全局开启 URI 文件名 | 打开时不设 `SQLITE_OPEN_URI`；传给 SQLite 的是规范化路径（`/…` 或 `\\?\C:\…`），不可能以 `file:` 开头，所以不会被当作 URI 解析 |
| 非 SQLite 与损坏文件的识别 | 未写 | `sqlite3_open_v2` 不读文件；打开后执行 `SELECT count(*) FROM sqlite_master` 作为探测，读文件头、第 1 页与全部 schema 项。`open` 与 `test` 用同一探测。0 字节文件会被 SQLite 当作空库通过探测，所以在探测前单独拒绝 |
| `readOnly` | §4 | `true` 用 SQLite 原生 `SQLITE_OPEN_READONLY` 打开，不做 SQL 文本检查。`false` 用 `SQLITE_OPEN_READWRITE`；文件在 OS 层只读时 SQLite 会静默降级为只读，打开后用 `sqlite3_db_readonly` 核对，降级即回 `PERMISSION_DENIED`，不报告 `readOnly:false` 的 Session。N-109：写语句由只读模式本身拒绝（DML、DDL、带副作用的语句都是 `READ_ONLY_DENIED`，见后续项 8） |
| WAL 库的辅助文件 | 未写 | `readOnly` 保证不写数据库内容，但不保证目录里不出现新文件：只读连接也要用 `-shm` 索引，WAL 模式的库在目录可写时，SQLite 会在库旁生成 `<库名>-wal` 与 `<库名>-shm`，只读连接关闭时不删除它们。实测（`sqlite::tests::a_read_only_open_of_a_wal_database_leaves_its_content_unchanged`）：只读打开成功并能读出数据，数据库文件逐字节不变，`-wal` 长度为 0，两个辅助文件留在目录里。这是 SQLite 的正常行为，不改打开方式 |
| `sessionId` 分配 | `$defs/id` pattern；§4：`open` 每次返回新 generation | `s_<16 位十六进制><n>`。16 位前缀每个进程不同（`RandomState` 种子加 pid 与时间），不是秘密也不授予任何权限，只保证上一个 Runtime 进程发出的 id 在新进程里是未知的；`n` 是进程内从 1 开始的序号 |
| `sessionGeneration` | §4 | 进程内单调计数器，第 n 个 Session 的 generation 为 n；`(sessionId, generation)` 都由本进程发出且匹配才算有效 |
| generation 不匹配、未知 Session | §4：close 不匹配回 `INVALID_SESSION` | `INVALID_SESSION`，`data.sessionId` 回填请求里的 id；被拒的请求不改变任何 Session。另一进程发出的 id 是未知 id，同样回 `INVALID_SESSION` |
| `connection.close` 幂等 | §4：幂等 | 关闭已关闭的 Session（generation 匹配）再次回 `{"closed": true}`。最多保留 32 个已关闭 Session（`MAX_CLOSED_SESSIONS`），超出时最早关闭的被遗忘，其 id 变为未知（回 `INVALID_SESSION`）。SQLite 关闭失败时 Session 保持 open 并回 `INTERNAL` |
| Session 上限 | §7 只列帧/行/结果限额 | 最多 32 个 open Session（`MAX_OPEN_SESSIONS`），第 33 个 `open` 回 `RESOURCE_LIMIT`，连接继续可用；§1 的“回复后终止进程”只适用于超限帧 |
| `connection.listSessions` | §4：`state` 取 `open` / `closed` / `lost` | 列出 open 与保留的 closed Session，按 generation 排序。v1 实现没有断线重连，不会出现 `lost` |
| `profileId` | §4：`open` 的可选参数，结果不回传 | 按 schema 校验（非空字符串），不保存 |
| `capabilities` | §4 | `driver: "sqlite"`；`readOnly` 为实际打开模式；`cancel: "cooperative"`（N-106 起超时经 SQLite progress callback 结束运行中的语句；`query.cancel` 仍到不了运行中的执行，见下）；`supportsTransactions: false`（v1 没有 `transaction.*`）；`supportsMetadata: true`（N-105 起 `metadata.*` 已实现）。不按一致性样例里的值声明尚未实现的能力 |
| Session 生命周期 | — | `Server` 拥有 Session 注册表；进程退出或 `Server` 被丢弃时关闭全部连接 |

### 5. 工具链

- `rust-version = "1.82"`（代码用到 `Option::is_none_or`）；clippy 的 `incompatible_msrv` 会按这个版本检查 std API 的使用。
- 不加 `rust-toolchain.toml`：本地与 CI 用 stable，避免强制下载特定工具链；需要固定时另行决定。

### 6. SQLite 驱动（N-104）

- 驱动：`rusqlite = { version = "0.40.2", default-features = false, features = ["bundled"] }`，内置 SQLite 3.53.2（source id `2026-06-03 … d6e03d8c`），由 `libsqlite3-sys` 0.38.2 用 `cc` 编译，不依赖系统 SQLite，各平台版本一致。驱动代码在 `src/sqlite.rs`（路径检查、打开、探测、错误映射），Session 注册表与 `connection.*` 在 `src/connection.rs`。单 crate 不变，`nyala-driver-sqlite` 等到第二个驱动出现时再拆。
- 版本：不用 0.41.x，它要求 Rust 1.89 与 edition 2024，高于 workspace 的 `rust-version = "1.82"`；0.40.2 是 edition 2021，未声明 MSRV（README 写“发布时的最新 stable”），所以 1.82 能否构建要靠 CI 补测，见后续项 3。
- `default-features = false` 去掉 `cache`（`hashlink`）和 `ffi-sqlite-wasm-rs`。
- 许可证：`rusqlite`、`libsqlite3-sys` 为 MIT；SQLite 源码为 public domain；新增的传递依赖 `bitflags`、`smallvec`、`fallible-iterator`、`fallible-streaming-iterator`，以及仅构建期的 `cc`、`find-msvc-tools`、`shlex`、`pkg-config`、`vcpkg` 均为 MIT 或 MIT/Apache-2.0 双许可。发行物的第三方许可证清单与 SBOM 仍是发布前任务（17-release-compliance）。
- 供应链：`Cargo.lock` 锁定版本与 checksum，CI 用 `--locked`；本地 `cargo audit`（RustSec advisory DB，1395 条）对 27 个 crate 无告警。
- bundled 构建的编译选项含 `SQLITE_ENABLE_LOAD_EXTENSION=1` 与 `SQLITE_USE_URI`：本实现从不启用扩展加载（不调用 `load_extension_enable`），打开时不设 `SQLITE_OPEN_URI` 并只传规范化路径（见 §4）。
- 打开标志：`READ_ONLY` 或 `READ_WRITE`，加 `NO_MUTEX`（一个连接只在一个线程上用）与 `NOFOLLOW`；不加 `CREATE`、不加 `URI`。busy timeout 为 2 s。

## 未采纳的替代方案

- **加入 `cli/` workspace**：会修改上游 `cli/Cargo.toml`，计入补丁数并在每次 Code OSS 同步时产生冲突。
- **一次拆出 `nyala-protocol` / `nyala-core` / `nyala-runtime`**：现在只有一个使用方，拆分只增加样板；设计包也建议先单 crate。
- **serde derive DTO**：手写类型与合同并存即两个事实源，违背 README §8，等 N-110 的生成方案。
- **Tokio + 异步 stdio**：此阶段没有并发需求，留到执行与取消落地时再引入。
- **rusqlite 0.41.x**：需要 Rust 1.89 与 edition 2024，超出 workspace MSRV。
- **系统 SQLite（不用 `bundled`）**：各平台版本与编译选项不同，Windows 没有现成的系统库，行为无法统一测试。
- **为文件级失败新增 error kind（如 `DATABASE_UNAVAILABLE`）**：§8 冻结 v1，只允许新增可选字段与能力位，合同也没定义客户端遇到未知 kind 时怎么处理；N-104 用现有 kind，缺口记为后续项 6。
- **`connection.test` 打不开时回 `{"ok": false}`**：结果里没有原因字段，UI 无法说明失败原因。

## 后果

- 新增 Nyala 自有目录 `rust/`，不修改任何上游跟踪文件；`nyala/upstream-base.json` 的 `patchCount` 不变。
- CI：`.github/workflows/nyala-ci.yml` 新增独立的 `Rust runtime` job，在 `rust/` 下跑 `cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`，使用 runner 预装的 stable 工具链，不引入第三方 toolchain action；`product` 与 `client` job 不改。
- 合同缺口（id 为 null 的失败回复）已由 2026-10-30 的 v1.0 勘误关闭（`$defs/failureId`，见 [ADR 0001](0001-rpc-contract-v1.md)）；`tests/conformance.rs` 的绊线断言已同步翻转为“schema 接受该回复”。
- N-104：`runtime.hello` 可协商出 `sqlite`，`connection.*` 四个方法可用；Runtime 二进制因内置 SQLite 变大，构建需要 C 编译器（CI 的 `ubuntu-latest` 与本机 MSVC 均已具备）。`nyala/rpc/**` 未改，`patchCount` 不变。
- `tests/conformance.rs` 把一致性样例会话里的 `path` 换成临时数据库、把样例 `sessionId` 换成本进程发出的 id 后整段重放，`connection.*` 的回复须符合方法 result schema，且字段集合与样例响应一致。

## 后续项

1. ~~**合同**：v1 `failure` 允许 `"id": null`~~ 已完成（2026-10-30 勘误）：schema 的 `$defs/failureId`、README §2/§8、ADR 0001 修订记录；`conformance.ndjson` 因校验脚本要求“响应必须匹配前置请求”而无法表达该场景，已在 README §9 说明。
2. **合同**：为“重复 hello”“hello 前调用其他方法”写明错误 kind，确认或替换上表的选择。
3. **CI**：Rust job 已随本 PR 加入，只覆盖 `ubuntu-latest` + stable。Windows / macOS runner 与 MSRV 1.82 构建仍未覆盖。
4. **N-103**：Electron Main Supervisor 按上表的退出码区分“流错误”与“版本不匹配”（后者不得重启同一版本）。
5. **N-106 起**：请求 id 复用检测、并发执行、取消竞态；引入异步运行时时修订本 ADR。
6. **合同**：错误码表缺文件级 kind。`INVALID_PARAMS` 现在也用于“文件不存在 / 不是 SQLite / 已损坏”，`QUERY_TIMEOUT` 也用于打开时的锁等待，都超出了表中描述。`DATABASE_UNAVAILABLE` 一类的新 kind 是后续 minor 修订的候选，需要单独的合同 PR 与 ADR，并先定义客户端遇到未知 kind 的降级规则。
7. **路径安全的已知缺口**：Windows 上映射到网络位置的盘符（`net use Z: \\server\share`）和指向共享的符号链接或 junction，规范化结果可能仍是盘符形式，无法从路径判定为网络位置；`SQLITE_OPEN_NOFOLLOW` 只在 Unix 上生效，Windows 上检查与打开之间存在替换为链接的窗口。需要时可改为打开句柄后用 `GetFinalPathNameByHandle` / `GetFileInformationByHandle` 核对。
8. ~~**N-109**：`readOnly: true` 只依赖 `SQLITE_OPEN_READONLY`，不检查 SQL 文本~~ 已完成（2026-11-02）：DML、DDL（`CREATE` / `DROP` / `ALTER`）与带副作用的语句都由 SQLite 的只读模式拒绝，回 `READ_ONLY_DENIED`，测试同时证明数据与 schema 未被修改、同一会话随后仍可读（`query::tests::a_read_only_session_lets_sqlite_refuse_every_kind_of_write`）。
9. ~~**N-105 / N-108**：`supportsMetadata` 与 `cancel` 分别在 metadata 与中断实现后改为真实值~~ 已完成（N-105/N-106）：`supportsMetadata: true`，`cancel: "cooperative"`。`query.cancel` 本身仍无法中断运行中的执行——v1 逐请求处理，收到 `query.cancel` 时语句已经结束，所以它回 `accepted: false` 与终态；真正的中断（跨线程取消）随 N-108 的异步执行落地。
10. **N-106 留下的合同缺口**：`query.execute` 的结果没有“影响行数”字段，DML/DDL 执行成功时只能回 `{executionId, state: "completed", sequence}` 而无法告知写了几行；客户端需要另查。由 N-110 或下一次 minor 修订评估。
11. **N-107**：结果在内存中整段保留（上限 `MAX_CONCURRENT_EXECUTIONS` 个执行、每个 `maxInitialRows` 行与 16 MiB），`result.fetchPage` 只做前向切片；真正的流式游标与 TTL 到期回收的完整验收属 N-107。当前 TTL（`maxResultTtlSecs`）在每次 fetch/execute 时清理过期句柄。
12. **约束违例没有专用 kind**：v1 错误码表的 19 个 kind 里没有“约束违例”，而 `v1/` 冻结（README §8）。`UNIQUE` / `NOT NULL` / `CHECK` 失败与整数溢出一并报 `SQL_SYNTAX`，并回填 `data.sqlState`（SQLite 扩展结果码：`1555`、`2067`、`1299` 等，语法错误是 `1`），客户端据此区分“文本编译不了”与“数据被拒绝”；`sqlState` 字段 schema 与 README §7 本来就有，样例 rq_009 记录了 `"1"`。`CONSTRAINT_VIOLATION` 一类的新 kind 属后续 minor，需要单独合同 PR 与 ADR。（2026-11-02 决策。）
13. **`result.fetchPage` 受帧上限约束**：回复必须能装进一帧，否则 `write_message` 失败会让整个 runtime 退出、所有会话一起丢失。页面在接近 `frameMaxBytes` 时提前结束并回 `hasMore: true` + `nextCursor`，这不是截断——行仍在句柄里，客户端按 cursor 继续取。单行本身就超过一帧预算时回 `RESOURCE_LIMIT`（`MAX_BLOB_BYTES` = 1 MiB 与 `MAX_RESULT_BYTES` = 16 MiB 已保证不会发生）。

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

### N-104（2026-11-01）

环境同上（Node v24.16.0，`.nvmrc` 要求 24.18.0）。

```bash
cd rust
cargo fmt --all --check                                          # PASS
cargo clippy --workspace --all-targets --locked -- -D warnings   # PASS
cargo test --workspace --locked                                  # PASS：单元 53 + conformance 8 + stdio 17
cargo audit                                                      # PASS：27 个 crate 无 RustSec 告警
cd ..
npm run nyala:validate-rpc                                       # PASS（合同未改）
```

- 单元测试在临时目录里用真实 SQLite 文件覆盖：读写两种模式打开、不存在（且不创建文件）、目录、0 字节、文本文件、文件头被改写、截断到 50 字节与一半、OS 层只读文件的读写请求、OS 拒绝读取（Unix 用 `chmod 000`，Windows 用 `icacls /deny` 拒绝读数据；root 下文件仍可读时跳过并打印原因）、WAL 模式库的只读打开（内容逐字节不变，`-wal`/`-shm` 留在目录里且 `-wal` 为 0 字节）、Unix 上的符号链接与 `/dev/null`；Windows 上的 UNC、`\\?\`、`\\.\`、`C:foo`、`\foo` 字符串判定；SQLite 错误码到 v1 kind 的映射且 `safeDetail` 不含路径；Session 生命周期（含 `capabilities` 五个字段的取值）、generation 不匹配、32 个上限、已关闭 Session 的保留与遗忘。
- `tests/conformance.rs`：一致性样例会话换成临时数据库后整段重放，`connection.test/open/close` 的回复符合方法 result schema、字段集合与样例一致，`connection.open` 的 `capabilities` 逐值比较（`readOnly` 等于请求的打开模式，其余为 `sqlite`/`none`/`false`/`false`）；文件级失败的回复符合 envelope schema 与错误码表且不含路径。
- `tests/stdio.rs` 新增 7 个真实进程测试：test → open → listSessions → close（含重复 close）、generation 不匹配、两个 Runtime 进程的 sessionId 不同且 B 拒绝 A 的 `(id, generation)`、无效路径与损坏文件（Windows 含 UNC、`\\?\`、`C:foo`）、只读降级、另一进程持有排他锁时 `QUERY_TIMEOUT`（`test` 与 `open` 分别计时，各自等满 busy timeout）、第 33 个 Session 回 `RESOURCE_LIMIT` 后连接继续。
- 未验证：MSRV 1.82 构建（本机未装 1.82 工具链）、macOS 记 NOT RUN；Linux 结果以 CI `Rust runtime` job 为准。`#[cfg(windows)]` 的测试（UNC、`\\?\`、`C:foo` 等路径判定，`icacls` 拒绝读取）只在本机 Windows 上跑过，CI 只有 `ubuntu-latest`。

### N-105 / N-106（2026-11-02）

环境同上（Windows 11，cargo 1.96.0；Node v24.16.0，`.nvmrc` 要求 24.18.0）。

```bash
cd rust
cargo fmt --all --check                                          # PASS
cargo clippy --workspace --all-targets --locked -- -D warnings   # PASS
cargo test --workspace --locked                                  # PASS：单元 91 + conformance 8 + stdio 19
cd ..
npm run nyala:validate-rpc                                       # PASS（合同未改：15 methods / 19 error kinds）
git diff --check                                                 # PASS
```

- **新增模块**：`src/metadata.rs`（`metadata.listObjects` / `metadata.describe`）、`src/query.rs`（`query.execute` / `query.getState` / `query.cancel` / `result.fetchPage` / `result.release` 与执行/结果注册表）、`src/value.rs`（cell 转换与 base64）。`connection.rs` 增加 per-session `Executions` 与按 id 前缀路由；`server.rs` 分发新方法并映射能力位；`error.rs` 增加 `data.executionId`。
- **metadata**：对象来自 `sqlite_schema`，按 `(kind, name)` 排序，`sqlite_*` 内部对象被过滤；`cursor` 是不透明 token（`c_<kind>_<b64 name>_<b64 kinds>_<b64 schema|~>`），携带原查询的 kinds 与 schema，换查询复用会回 `INVALID_PARAMS`。`describe` 只覆盖 table/view（index 无自有列），`schema` 必须是 SQLite 实际 attach 的名字；标识符用 `"` 加倍转义后进入 SQL，对象名一律走绑定参数。
- **query**：用 `rusqlite::Batch` 走 SQLite 自己的预编译器切分语句，字符串字面量里的 `;` 不会被误判；`statement`/`selection` 模式遇到第二条语句直接失败，不静默丢掉后半段写语句。`timeoutMs` 经 `progress_handler` 在 VM 内结束语句，执行终态为 `cancelled` 且错误为 `QUERY_TIMEOUT`；会话关闭时的中断为 `QUERY_CANCELLED`；两者都不会误报 `completed`。
- **结果句柄**：每语句一个句柄，`result.fetchPage` 严格前向（`cursor` 是已读行数，回退或跳读回 `INVALID_PARAMS`），`nextCursor` 只在还有未读行时出现；`result.release` 幂等，已释放或未知句柄再取回 `RESULT_EXPIRED`。结果上限沿用广告的 `maxConcurrentExecutions = 4`（v1 里“未释放结果”即“仍开着的执行”），在语句执行**前**拒绝，避免 `INSERT … RETURNING` 写完才发现给不出结果；脚本中途失败会丢弃本次已建句柄，不留无人能引用的内存。
- **合同对齐的一处纠正**：`query.execute` 的失败回复必须是**错误 envelope**（样例 rq_009），执行同时以 `failed`/`cancelled` 保留在注册表里，供 `query.getState` 补偿读（rq_012）。原实现回 `result{state:"failed"}`，不符合样例。
- **`SQL_SYNTAX` 的识别**：bundled SQLite（3.38+）把预编译拒绝的文本报成 `rusqlite::Error::SqlInputError`，其 `sqlite_error_code()` 为 `None`，原实现会落到 `INTERNAL`；现按 `SqlInputError` 优先映射为 `SQL_SYNTAX`（不回传其携带的 SQL 文本）。
- **一致性回放**：`tests/conformance.rs` 仍整段重放 `conformance.ndjson`，新增 `executionId`/`resultId` 的样例→实发 id 映射（样例的 `rs_001` 由 `query.getState` 补偿读取得），`metadata.listObjects` 要求与样例结果逐字段相等，`query.execute`/`result.fetchPage` 分别处理“样例是结果”与“样例是错误”两种形态。
- **stdio 端到端**：新增 `a_query_is_executed_paged_and_released_over_the_pipe`，在真实子进程上覆盖协商六个能力位、metadata 列举与描述、`SELECT` 分页取值、release 幂等与 `RESULT_EXPIRED`、非法 SQL 的 `SQL_SYNTAX` 与 `getState` 的 `failed`、只读会话拒绝 `INSERT`（`READ_ONLY_DENIED`）且数据未被修改；新增 `a_page_too_large_for_a_frame_is_paged_instead_of_ending_the_stream`，2500 行 × 约 4 KiB（约 10 MiB JSON）的结果分多页取完、连接仍健康、进程退出码 0。
- **N-109 只读强制**：`a_read_only_session_lets_sqlite_refuse_every_kind_of_write` 覆盖 `INSERT` / `UPDATE` / `DELETE` / `CREATE TABLE` / `DROP TABLE` / `CREATE INDEX` / `ALTER TABLE`，全部 `READ_ONLY_DENIED`，并证明数据与 schema 未改、同一会话随后仍可读。
- **复审修正（同一轮）**：
  - `result.fetchPage` 的行数受帧上限约束：页面按序列化后的大小切分（`PAGE_ENVELOPE_RESERVE` 为信封预留），超预算即提前结束并回 `hasMore` + `nextCursor`；单行超预算回 `RESOURCE_LIMIT`。原实现按 `limit` 切，一个 9 MiB 的页面会让 `write_message` 失败、`serve` 以退出码 1 结束，连带丢掉所有会话。
  - 无结果列的语句（DML/DDL）在超时或会话关闭时也走 `Stop::load` 的终态：超时报 `QUERY_TIMEOUT`/`cancelled`，不再被映射成 `QUERY_CANCELLED`/`failed`。
  - `constraint` / `TypeMismatch` / `OperationAborted` 单独映射，并给所有数据库侧错误回填 `sqlState`（SQLite 扩展结果码）；`SqlInputError` 也带 `sqlState`，与样例 rq_009 的 `"1"` 一致。
  - `connection.rs::owner()` 改为完整匹配 `<sessionId><e|r><digits>`：第 1 个会话的 id 是第 11 个的前缀，原 `starts_with` 会把第 11 个会话的句柄路由到第 1 个。
  - 空 BLOB 不再产出 `data: ""`（违反 `$defs/cell` 的 `minLength: 1`），改为 `null` cell。
  - `metadata.describe` 的 `nullable` 按 SQLite 真实语义判断：只有 rowid 别名主键（`PRAGMA index_list` 中没有 `origin = 'pk'` 的索引）允许 NULL；`TEXT PRIMARY KEY`、复合键、`WITHOUT ROWID`、`INTEGER PRIMARY KEY DESC` 都不允许。
  - 脚本失败清理句柄时改用结果序号（`ResultSet::sequence`），不再依赖运行前的句柄数量——期间过期的句柄会让计数失真、留下无法引用的句柄。
  - `connection.close` 在数据库关闭失败、会话被放回后调用 `Executions::resume()`，避免残留的 stop 让该会话之后所有语句都报 `QUERY_CANCELLED`。
- 未验证：MSRV 1.82 构建、macOS；Linux 以 CI `Rust runtime` job 为准。

## 修订记录

- **2026-11-02 · N-105 metadata + N-106 查询执行 + N-109 只读强制**：新增 `metadata.rs`、`query.rs`、`value.rs` 与 §4 中 `runtime.health` 计数、`capabilities`、`readOnly` 三行的实际值；header 与 §2 的依赖说明加入 `column_decltype`/`hooks` 两个 rusqlite feature；后续项 8–13；证据。`nyala/rpc/**` 未改（合同保持 15 methods / 19 kinds / 36 definitions）。

- **2026-11-01 · N-104 SQLite Profile & Session connect**：新增 `rusqlite`（`bundled`）运行依赖与 §6；§1 模块列表加入 `connection.rs`、`sqlite.rs`；§2 依赖说明；§4 补充 `connection.*` 的能力位、文件级错误映射、`connection.test` 失败形态、路径安全、`readOnly`、`sessionId` / generation 分配与保留、Session 上限与 `capabilities`；后续项 6–9；证据。决策只增不删，§4 已有各行仅把“本构建尚无驱动”“计数固定为 0”改为 N-104 后的实际行为。`nyala/rpc/**` 未改。
