# Nyala Studio · 项目进度快照

> 快照时间：2026-11-03（`nyala/main` `4532c084134`；原快照 2026-11-03 的 `db514f8837e`，更早为 `b9f00ff4326`、`4b5c38345b8`）· 基线 Code OSS `1.143.0`（`2d0b7506a36c1d6db9a466440131a8e01eab2289`，2026-10-29 由 `1.142.0` 同步）· 开发版本 `0.0.1-dev.0`
> 用途：跨机器移交与断点续做。**状态权威顺序：Git 分支与 PR ＞ 本文档 ＞ 会话记忆**；阶段验收仍以 [19-roadmap.md](docs/19-roadmap.md) 为准。

## 一句话状态

P0 Bootstrap 已完成（macOS 原生启动 + 产品身份 + Hello Workbench + 质量门禁记录），已同步到 Code OSS `1.143.0`（保留上游完整历史），P1 协议的 v1.0 可执行合同已冻结；截至 2026-11-02，PR #8、#11、#13–#43 与 dependabot PR #19/#20 已全部合入 `nyala/main`。**Rust SQL Runtime 的 N-101/N-102（stdio 分帧 + hello/health + 结构化错误，PR #25）、N-104 SQLite Profile/Session（PR #33，squash `195475b84b3`）、N-103 Electron Main Supervisor（PR #35，squash `24c3cc7aa23`）均已合入**；N-105（metadata）、N-106（查询执行 + 结果句柄）与 N-109（只读强制）已随 PR #37（squash `b9f00ff4326`）合入，四项必需检查 PASS。N-107 的核心（句柄、前向分页含帧上限、TTL、release）随该分支落地；N-108 复查发现的「单行超过一帧」缺口已由 PR #43（squash `db514f8837e`）修复——执行在安装句柄时报 `RESOURCE_LIMIT`，不再先 `completed` 再让每页失败。**N-107 仍待办**：流式游标（大结果仍整段驻留内存）与被拒绝结果（超 `maxInitialRows` 的 `INSERT … RETURNING`）收不回已写数据。N-108（跨线程真实取消、`cancel_requested` 与 `cancelled` 分离、`unknown`）已随 PR #41（squash `e90619d396b`）合入，四项必需检查 PASS；N-110（TS/Rust 生成合同）已随 PR #39（squash `113a170be69`）合入：TS 与 Rust 声明由 `scripts/nyala/generate-rpc-contract.ts` 从 `nyala/rpc/v1/` 生成，CI `Product baseline` 运行 `nyala:check-rpc-generated` 检出漂移，Rust 的 kind/code/retryable 直接取生成表（合同增删 kind 未重新生成即编译失败）。不能把连接、metadata 与查询执行视为 Workbench 结果网格或 P1 阶段验收完成。合同 v1.0 有一处勘误：`failure.id` 允许 `null`（PR #27）。Windows 11 `1.143.0` 原生冒烟与 Reload/Dispose 单元测试已合入（PR #23）；内置语言功能激活修复（PR #24，ADR 0003）后为 **PASS 12/12**。运行时 Chat 视图、内置 `GitHub.copilot-chat` 与 Microsoft 认证已关闭（PR #26），两条出站路径已随 PR #34（squash `2b73f20285c`）合入主线，Windows 原生冒烟 **PASS 17/17**。CI 已能真实执行，`nyala/main` 的分支保护要求 4 个 checks。

## 分支与 PR

| 分支 | HEAD | 目标 | 状态 |
|---|---|---|---|
| `nyala/main` | `4532c084134`（2026-11-03 核对） | 稳定主线 | 已合入 #8、#11、#13–#18、#20、#21–#46；#45 为 P1 SQL 正确性加固（`673f8e4c6a0`），#46 为 P2 Runtime Bridge + N-201（`4532c084134`）；#37 为 N-105/N-106/N-109（`b9f00ff4326`），#38 为状态快照收尾（`cff320ad65e`），#39 为 N-110 生成合同（`113a170be69`），#41 为 N-108（`e90619d396b`），#42 为 N-108 状态记录（`cfc2e61ebb3`），#43 为单行超帧修复（`db514f8837e`） |
| `feat/p1-sqlite-session` | `f04316fcb2a` | → `nyala/main`（PR #33） | **MERGED**（squash `195475b84b3`）：SQLite 连接、会话与审核补测 |
| `fix/close-runtime-egress` | `a334073f505` | → `nyala/main`（PR #34） | **MERGED**（squash `2b73f20285c`）：Agent Host 与拼写词典出站路径关闭 |
| `feat/p1-runtime-supervisor` | `66c0e4b4cbc` | → `nyala/main`（PR #35） | **MERGED**（squash `24c3cc7aa23`）：N-103 Runtime Supervisor；staging 缓存改为内容 SHA-256 + 执行位；组合 head 四项必需检查 PASS |
| `chore/dependabot-github-actions`（dependabot） | — | → `nyala/main`（PR #20） | **MERGED**（squash `4b5c38345b8`，2026-11-01）：7 个 GitHub Actions 版本升级；14 个 workflow 文件，其中 4 个此前与 `1.143.0` 一致，`patchCount` 57 → 61 |
| `feat/p1-sqlite-metadata-query` | `c6ccaa5fc16` | → `nyala/main`（PR #37） | **MERGED**（squash `b9f00ff4326`，2026-11-02）：N-105 metadata + N-106 查询执行/结果句柄 + N-109 只读强制；四项必需检查 PASS（`Product baseline`、`Client typecheck and hygiene`、`Rust runtime`、`Unit tests (node)`）；本机 `cargo fmt`/`clippy -D warnings`/`test --workspace --locked`（91 + 8 + 19）与 `nyala:validate-rpc` PASS |
| `feat/p1-rpc-generated-contracts` | `b5c99c5d13b` | → `nyala/main`（PR #39） | **MERGED**（squash `113a170be69`，2026-11-02）：N-110 TS/Rust 生成合同；四项必需检查 PASS（`Product baseline`、`Client typecheck and hygiene`、`Rust runtime`、`Unit tests (node)`，run `41375212220`）；本机 `cargo fmt`/`clippy -D warnings`/`test --workspace --locked`（91 + 8 + 19 + 4）与 `nyala:validate-rpc`/`nyala:check-rpc-generated` PASS |
| `feat/p1-async-execution` | `c67bdabc99f` | → `nyala/main`（PR #41） | **MERGED**（squash `e90619d396b`，2026-11-02）：N-108 per-session worker 线程 + `sqlite3_interrupt`；四项必需检查 PASS（run `41422938946`）；本机 `cargo fmt`/`clippy -D warnings`/`test --workspace --locked`（122 + 6 + 8 + 4 + 19）与 `nyala:check-rpc-generated` PASS。复查修复：关闭会话后的悬空请求、保留区路由与淘汰、`drain` 丢弃帧/EOF、取消排队执行误中断运行中的语句、结果上限快照、脚本失败后的事务残留 |
| `fix/p1-oversize-row` | `c798c1133af` | → `nyala/main`（PR #43） | **MERGED**（squash `db514f8837e`，2026-11-02）：N-107 后续项 13——单行超过一帧时执行在安装句柄时报 `RESOURCE_LIMIT`；四项必需检查 PASS；PR 内新增注册表单测与真实进程端到端用例，提交说明记录了两者在旧实现下的失败形态（本快照只复核了新实现下的 PASS） |
| `sync/code-oss-1.143.0` | 合并 `1.143.0` | → `nyala/main` | 同步分支：真正的 merge commit，上游 731 个提交保持为祖先 |
| `fix/review-audit-findings` | `a8068687464` | → `nyala/main`（PR #8） | **MERGED**（squash `85eee995045`，2026-10-29） |
| `feat/p1-rpc-contract` | `513a34990ae` | → `nyala/main`（PR #11） | **MERGED**（squash `3b17d4e184a`，2026-10-29） |
| `feat/progress-snapshot` | 本文档 | → `nyala/main`（PR #13） | 随本快照合并 |
| `fix/p0-windows-smoke` | `f7cb481013a` | → `nyala/main`（PR #23） | **MERGED**（squash `3a8cbc0b49f`）：Windows 1.143.0 原生冒烟 + Reload/Dispose 单元测试 |
| `fix/extension-api-version` | `38a8b4910b2` | → `nyala/main`（PR #24） | **MERGED**（squash `52664d3b715`）：向扩展报告 Extension API 版本，修复内置语言功能激活失败；ADR 0003 |
| `fix/disabled-chat-runtime` | `12f5c3fd0e9` | → `nyala/main`（PR #26） | **MERGED**（squash `dfa366609c5`）：运行时关闭 Chat 视图、内置 Copilot Chat 与 Microsoft 认证；冒烟增加 Chat 与出口检查 |
| `feat/p1-rust-runtime` | `689a5aaec29` | → `nyala/main`（PR #25） | **MERGED**（squash `7bfc4fc2a68`）：`rust/` Runtime crate（N-101/N-102：分帧、hello/health、结构化错误） |

> Nyala 版 `AGENTS.md`、`scripts/nyala/validate-product.ts`、`.github/workflows/nyala-ci.yml`、`product.json` 的 Chat/认证置空改动已随 **PR #8** 进入 `nyala/main`；`nyala/rpc/` 合同随 **PR #11** 进入。

## 已完成

### P0 · Code OSS 基座

- 基线锁定：Code OSS `1.142.0` / SHA / Node `24.18.0` / npm，补丁口径 34 条记录在 [`nyala/upstream-base.json`](../../nyala/upstream-base.json) 与 [`nyala/patch-ledger.md`](../../nyala/patch-ledger.md)。
- 产品身份：`Nyala Studio` / `nyala-studio` / `.nyala-studio` / `nyala://` / `0.0.1-dev.0`。
- macOS 原生 Electron 启动、编辑器、Split、Extension Host、Webview 冒烟通过（`1.142.0`），见 [`nyala/upstream-compatibility.md`](../../nyala/upstream-compatibility.md)。
- Windows 11 原生 Electron 冒烟（`1.143.0`）：`scripts/nyala/smoke-electron.ts` 经 `scripts\code.bat` 启动。2026-10-29 在 `fix/p0-windows-smoke`（`595db6c10f7`）上为 **FAIL 11/12**，唯一失败项是 `vscode.markdown-language-features` 激活失败；2026-10-30 在 `fix/extension-api-version`（`6d35da69627`）上为 **PASS 12/12**，css/html/json/markdown 语言功能全部激活、Markdown 预览渲染正常。详见兼容性报告 Windows 节。
- Reload / Dispose 自动化回归：`src/vs/workbench/contrib/nyala/test/browser/nyalaBootstrap.test.ts`（2026-11-03 重写后 18 passing，见 P2.2）。
- Hello Workbench：`nyala.hello` 命令 + `Nyala Connections` 视图容器 + 状态栏入口，源码在 `src/vs/workbench/contrib/nyala/bootstrap/browser/`。
- 质量门禁：`npm run compile`、`typecheck-client`、`build-fast --client-only`、`gulp hygiene`、定向 ESLint、JSON/脚本检查（同上报告）。
- 文档落位：设计包 `docs/nyala-kickoff/`、`docs/adr/`、`nyala/patch-ledger.md`。

### 上游同步（2026-10-29）

- 基线 `1.142.0` → `1.143.0`（`2d0b7506`），上游增量 731 commits / 3431 files，用 `git merge` 合并，上游历史完整保留。
- 53 个冲突：46 个纯上游分歧取上游，7 个含 Nyala 意图手工合并（`package.json`/lock、copilot engines、chat-lib workflow、debian postinst/templates）。
- 回归：`typecheck-client`、`npm run compile`、`gulp hygiene`、两个 nyala 校验脚本、`git diff --check` 全部通过。
- 细节见 [`nyala/patch-ledger.md`](../../nyala/patch-ledger.md) 的「同步记录」与 [`nyala/upstream-compatibility.md`](../../nyala/upstream-compatibility.md)。

### P1 · 协议合同（已合并，PR #11）

- `nyala/rpc/README.md`：分帧、envelope、版本协商、15 个 v1 方法、状态机、cell 类型、错误模型、限流、变更策略。
- `nyala/rpc/v1/`：envelope + 方法级 params/result JSON Schema、错误码表、一致性样例。
- `npm run nyala:validate-rpc`：分帧半包/粘包/零长度/超限、schema、请求响应配对、sequence 单调、错误码一致、README 与 schema 防漂移、负向对照。
- ADR：`docs/adr/0001-rpc-contract-v1.md`（随 PR #11 引入，合并后才有该文件）。

### P1.1 · Rust Runtime N-101/N-102（已随 PR #25 合入）

- `rust/` 是独立的 Cargo workspace（不进上游 `cli/`），单 crate `rust/crates/nyala-runtime`：4 字节 LE 分帧（半包、粘包、零长度、超限）、envelope 解析、结构化错误（与 `error-codes.json` 逐项比对）、`runtime.hello`（major 不匹配回 `PROTOCOL_MISMATCH` 并以退出码 2 结束）、`runtime.health`。
- 一致性测试直接读取 `nyala/rpc/v1/`；真实进程测试验证 stdout 只有协议帧、日志只在 stderr。
- 本地证据（Windows 11，cargo 1.96.0）：`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`（47 个）PASS；`nyala-ci.yml` 新增 `Rust runtime` job（ubuntu-latest），结果见本分支的 PR。目录选择、合同未写死之处和合同缺口见 [ADR 0002](../adr/0002-rust-runtime-workspace.md)。

### P1.2 · SQLite Profile/Session N-104（已随 PR #33 合入）

- `connection.test/open/close/listSessions` 使用 `rusqlite` bundled SQLite；仅打开已存在的绝对普通文件，不创建新数据库；拒绝 URI、内存库、目录、无效文件及 Windows UNC/设备路径。
- 会话以 `sessionId` + `sessionGeneration` 标识，最多 32 个打开会话；关闭保留窗口内幂等；错误不包含数据库路径。`readOnly` 由数据库原生打开能力验证，不以 SQL 正则替代权限。
- 审核补测覆盖 OS access denied、WAL 只读打开的数据库内容不变、精确 capabilities 与锁等待时限。WAL 只读打开可能留下 `-wal`/`-shm`，不是“完全无文件副作用”。证据与边界见 [ADR 0002](../adr/0002-rust-runtime-workspace.md)。
- **PASS**：PR #33 最终 head `f04316fcb2a` 的四项必需 CI；合并后主线 run `41290936784` 四项必需检查；Windows 审核复跑 `cargo fmt`、`cargo test`、`cargo clippy`。Windows 专属路径测试尚无 Windows CI 门禁。

### P1.3 · metadata + 查询执行 N-105/N-106/N-109（已随 PR #37 合入）

- `metadata.listObjects`：列 `sqlite_schema` 的表/视图/索引，过滤 `sqlite_*` 内部对象，按 `(kind, name)` 排序；`kinds` 过滤、`limit`（1–1000）、不透明前向 `cursor`（携带原查询的 kinds/schema，换查询复用回 `INVALID_PARAMS`）。
- `metadata.describe`：覆盖表与视图（索引无自有列，回 `INVALID_PARAMS`），返回 `ordinal/name/nativeType/nullable/primaryKey?`；`schema` 必须是 SQLite 实际 attach 的名字；标识符 `"` 加倍转义，对象名走绑定参数。
- `query.execute`：语句切分交给 SQLite 自己的预编译器（`Batch`），字面量里的 `;` 不误判；`statement`/`selection` 遇第二条语句直接失败；成功回 `completed` + 结果 id，失败回**错误 envelope**（`data.executionId`）并把执行以 `failed`/`cancelled` 留在注册表供 `query.getState` 补偿读——与 `conformance.ndjson` rq_009/rq_012 一致。
- `result.fetchPage` 严格前向（cursor = 已读行数），`nextCursor` 仅在还有未读行时出现；一页的序列化大小受 `frameMaxBytes` 约束，超预算即提前结束并给 cursor（不是截断，行仍在句柄里）；单行超一帧回 `RESOURCE_LIMIT`。`result.release` 幂等；已释放/未知句柄回 `RESULT_EXPIRED`。限额（`maxConcurrentExecutions = 4` 个未释放结果）在语句执行前拒绝，脚本中途失败按结果序号丢弃本次已建句柄。
- 超时经 SQLite `progress_handler` 在 VM 内结束语句，终态 `cancelled` + `QUERY_TIMEOUT`（有结果列与无结果列的 DML 都一样）；会话关闭中断为 `QUERY_CANCELLED`；两者都不误报 `completed`。
- **N-109 只读强制**：`SQLITE_OPEN_READONLY` 本身拒绝 DML、DDL 与带副作用的语句（`READ_ONLY_DENIED`），测试证明数据与 schema 未改、同一会话随后仍可读；不以 SQL 正则作为安全边界。
- 错误映射：`SqlInputError` 与数据库侧失败都回填 `data.sqlState`（SQLite 扩展结果码），与样例 rq_009 的 `"1"` 一致；约束违例（`1555` / `2067` 等）因 v1 无专用 kind 而报 `SQL_SYNTAX` + `sqlState`，见 [ADR 0002](../adr/0002-rust-runtime-workspace.md) 后续项 12。
- 其余修正：`capabilities` 为 `cancel: "cooperative"`、`supportsMetadata: true`；`runtime.health` 的 `activeExecutions` 恒为 0、`pendingResults` 为未释放句柄数（与样例 rq_002 一致）；句柄路由按完整 `<sessionId><e|r><digits>` 匹配（第 1 个会话的 id 是第 11 个的前缀）；`metadata.describe` 的 `nullable` 只对 rowid 别名主键为真；空 BLOB 回 `null` cell（`$defs/cell` 要求 `bytes.data` 至少 1 字符）。
- **PASS（本机，Windows 11 / cargo 1.96.0）**：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`（单元 91 + conformance 8 + stdio 19）、`npm run nyala:validate-rpc`、`git diff --check`。**PASS（CI，PR #37）**：`Product baseline`、`Client typecheck and hygiene`、`Rust runtime`、`Unit tests (node)` 四项必需检查。**NOT RUN**：macOS、MSRV 1.82；`nyala/rpc/**` 未改。

### P1.4 · 合同生成声明 N-110（已随 PR #39 合入）

- `scripts/nyala/generate-rpc-contract.ts`：只读 `nyala/rpc/v1/nyala-rpc.v1.schema.json` 与 `error-codes.json`，只用 `node:` 内置模块，以 `node --experimental-strip-types` 运行；遇到未实现的 schema 关键字直接失败（与两个合同校验脚本同策略）。`npm run nyala:generate-rpc` 写出文件，`npm run nyala:check-rpc-generated` 只比较并在漂移时退出 1。
- TS 产物 `src/vs/platform/nyalaRuntime/common/nyalaRuntimeContract.generated.ts`：id 模式、请求/通知方法目录、`NyalaId`、`NyalaCell`、`$defs/error` 派生的错误对象、全部方法的 params/result 接口与按方法名索引的映射，以及错误表 `NYALA_ERROR_KINDS`。`nyalaRuntimeProtocol.ts` 删除手写接口，只保留值检查与客户端自造的三个错误对象（其 kind/code/retryable 现取自生成表）。
- Rust 产物 `rust/crates/nyala-runtime/src/contract.rs`：`REQUEST_METHODS`、`NOTIFICATION_METHODS`、`ID_PATTERN`、19 个 `ErrorKindSpec` 常量；生成器按 rustfmt 规则输出，重新生成不会让 `cargo fmt --check` 失败。`error.rs` 的 `spec()` 从 `contract::` 取 kind/code/retryable，`protocol.rs` 的 `V1_REQUEST_METHODS` 引用生成的目录。
- 绊线：合同增删 kind 或方法而不重新生成时，Rust 编译失败（`contract::` 路径）或 `nyala:check-rpc-generated` 失败；`tests/contract.rs`（4 项）与 `nyalaRuntimeContract.test.ts`（3 项）各自重读合同文件比对生成值。既有 `tests/conformance.rs` 与 `nyalaRuntimeProtocol.test.ts` 继续覆盖正/负向样例。
- **PASS（本机，Windows 11 / cargo 1.96.0 / Node 24.16.0）**：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`（单元 91 + conformance 8 + stdio 19 + contract 4）、`npm run nyala:validate-rpc`、`npm run nyala:check-rpc-generated`、`git diff --check`。**PASS（CI，PR #39）**：`Product baseline`、`Client typecheck and hygiene`、`Rust runtime`、`Unit tests (node)` 四项必需检查（run `41375212220`）。**NOT RUN**：macOS、MSRV 1.82、指定 Node 24.18.0。`nyala/rpc/**` 未改。

### P1.5 · 单行超帧与结果句柄 TTL（PR #43 之后）

- PR #43（squash `db514f8837e`）关闭 ADR 0002 后续项 13：`Executions::finished` 用与 `result.fetchPage` 相同的 `row_budget` 逐行量 JSON，发现某一行本身超过一帧预算时，执行以 `failed` / `RESOURCE_LIMIT` 结束且不安装句柄——客户端在 `query.getState` 看到限额，而不是拿到一个每页都失败的句柄。
- 本轮补测：`query::tests::a_handle_nobody_fetches_expires_after_its_ttl` 用零 TTL 覆盖 `expire()` 的真实回收路径（此前后续项 11 记的 TTL 只有代码路径、没有测试；backlog N-107 的“过期测试”验收项因此关闭）；`tests/stdio.rs::a_query_is_executed_paged_and_released_over_the_pipe` 收尾补上 `connection.close`，与 P1 Exit 的“打开 → 执行 → 分页 → 释放 → 关闭 → 进程退出”一致。
- 帧预算固定使用 `DEFAULT_FRAME_MAX_BYTES` 与 `server::write_message` 同一常量；`runtime.hello` 的 params schema 没有覆盖 limits 的字段，所以两者当前一致（`row_budget` 的文档注释记下了这条不变量）。
- **PASS（本机，Windows 11 / cargo 1.96.0）**：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`（单元 124 + cancellation 6 + conformance 8 + contract 4 + stdio 20）、`npm run nyala:validate-rpc`、`npm run nyala:check-rpc-generated`、`npm run nyala:validate-product`、`git diff --check`。**NOT RUN**：`npm run compile` / `typecheck-client`（工作树无 `node_modules`）、macOS/Linux、MSRV 1.82。

### P1.6 · PR A 空 BLOB 与失败写入语义（`fix/p1-sql-correctness`）

- **空 BLOB**：`value.rs` 不再把 `X''` 编码为 `null` cell；合同 `$defs/cell` 的 `bytes.data` 允许空串（README §6 勘误），TS/Rust 声明重新生成，Rust `conformance.rs` 与 Node `validate-rpc-contract.ts` 各补正/负向 cell 用例。往返语义（NULL、空 TEXT、空 BLOB、1 字节 BLOB、普通 BLOB、超限 BLOB）由 `worker::tests` 与 stdio 端到端用例覆盖。
- **失败写入的诚实上报**：错误信封新增 `data.executionRollback`（`rolled_back` / `unknown`）。探针在真实 SQLite 上确认 `INSERT … RETURNING` 被行数上限截断时写入**已提交**，因此运行时不承诺回滚，失败写入一律报 `unknown`；先前语句已提交的脚本同样报 `unknown`。未做外层事务包装（会改变脚本自身的 `BEGIN`/`COMMIT` 与 `PRAGMA`/`VACUUM` 语义），归于 N-402。
- **只读回归**：`ATTACH` 后对附加库的 DML/DDL 全部 `READ_ONLY_DENIED` 且附加文件未变；`PRAGMA` 边界按实测记录（部分被拒、部分被 SQLite 静默忽略，文件不变）；`file:` URI 提权路径被 `sqlite::resolve` 拒绝且不创建文件。
- **PASS（本机，Windows 11 / cargo 1.96.0）**：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`（单元 135 + cancellation 6 + conformance 8 + contract 4 + stdio 22）、`nyala:validate-rpc`、`nyala:check-rpc-generated`、`git diff --check`。**NOT RUN**：`npm run compile` / `typecheck-client`（无 `node_modules`）、macOS/Linux、MSRV 1.82。

### P2.1 · Workbench Runtime Bridge + N-201 Connections（`feat/p2-connections-foundation`）

- 新通道 `nyalaRuntime`：Renderer → `IMainProcessService` → `NyalaRuntimeChannel` → 该窗口的 `NyalaRuntimeSupervisor` → Rust。只放行六个命令（`getRuntimeState`、`connection.test/open/close`、`metadata.listObjects/describe`），Main 进程按 v1 合同校验参数后才转发；窗口 id 取自 IPC ctx，Renderer 不能指定其他窗口。设计见 [ADR 0006](../../docs/adr/0006-p2-workbench-runtime-bridge.md)。
- 连接身份：`profileId`（Workbench，存 `IStorageService`，只存 path/readOnly/displayName）+ `sessionId`/`sessionGeneration`（Runtime）+ `runtimeGeneration`（Supervisor）+ 窗口绑定。`INyalaConnectionHandle` 携带四者；Runtime 换代后旧 handle 在本地被拒绝，连接标为 `lost`。
- Connections 树（N-201）：选择本地 SQLite 文件 → `connection.test` → `connection.open` → 列出 Tables/Views/Indexes → 展开表时 `metadata.describe` 取列；支持连接/断开/刷新，Loading / Empty / Error / Lost 状态与 aria label。只读会话，不写库。
- 单测：`nyalaRuntimeRequest.test.ts`（白名单参数校验）、`nyalaConnectionService.test.ts`（test→open→catalog 顺序、失败中止、换代失效、profile 解析）与 `nyalaRuntimeChannel.test.ts`（白名单外命令拒绝、无 runtime 窗口返回 `RUNTIME_LOST`、参数错误在触达进程前返回 `INVALID_PARAMS`、两个真实进程互不可见）加入 `Unit tests (node)` job。
- **已合入**：PR #46，squash `4532c084134`（2026-11-03）；rebase 到含 PR #45 的主线后在 head `b85ba3ba68c` 重跑 CI，run `41565681831` 四项必需检查 PASS。
- **PASS（CI，PR #46 首个通过 head `ab8c683c0f9`，run `41554877870`）**：`Product baseline`、`Client typecheck and hygiene`、`Rust runtime`、`Unit tests (node)` 四项必需检查。CI 抓出并修复的缺陷：supervisor 事件前的 runtime generation 未初始化；Supervisor 的 `runtime.hello` 未协商任何 feature（`connection.open` 被回 `PROTOCOL_MISMATCH`）；新源码含非 ASCII 字符。**NOT RUN**：桌面原生 E2E（需 `npm install` + 真实 Electron）、Linux/macOS 原生。

### P2.2 · 合并后安全收尾（`fix/post-merge-safety-closure`，PR #46 之后的修复）

合入后复查发现的三类缺陷，均先写可复现测试、确认旧实现失败，再改实现：

1. **`executionRollback` 被只读失败覆盖（C1）**：`run_statements` 在失败语句只读时直接报 `rolled_back`，于是 `INSERT INTO customers(name) VALUES ('Committed'); SELECT json_extract('not-json','$')` 这种「写已提交、随后只读语句失败」的脚本被报成 `rolled_back`。改为仅 `read_only && !completed_write` 才允许 `rolled_back`；脚本自持 `BEGIN…COMMIT` 后读失败同样报 `unknown`。**没有**用外层事务包住脚本（ADR 0002 后续项 14 记录了为什么那样会改变客户端事务语义）。证据：`worker::tests` 新增 3 条真实 SQLite 用例（直接回读库内容断言写已提交/已回滚）、`tests/stdio.rs` 管道级 `rq_5`。
2. **Profile 身份由路径派生（C2）**：`p_` + 路径替换非法字符会让 `/data/a-b.sqlite` 与 `/data/a/b.sqlite` 塌成同一个 id，后加入的连接顶掉前一个 session。改为 `p_<uuid>` 作为身份、`target.path` 只用于去重，旧 id 在 `restoreProfiles` 时一次性迁移并写回；`addProfile` 改为返回 id。
3. **连接生命周期竞态（C3）**：重叠 connect 会留下无人追踪的 session；打开成功但 catalog 失败会泄漏 session；断线/换代后到达的回复会覆盖新状态；结构化错误在 UI 上退化成 `[object Object]`。改为每 Profile 一个尝试计数器（只有当前尝试能提交，被取代的尝试关闭自己打开的 session）、catalog 失败即关闭（关不掉时保留可 Disconnect 的 handle 且状态为 `error`）、重连前先关旧 session、runtime `failed`/`stopped` 与换代都作废进行中的尝试、错误文本经 `asRuntimeError`/`errorMessage` 还原。
- **测试证据（本机，Windows 11）**：`nyalaConnectionService.test.ts` **31 passing**（FakeBridge + `DeferredPromise` 强制重叠；改实现前该文件 6 条失败，正是旧 API 与旧语义）；`nyalaBootstrap.test.ts` **18 passing**，在 **Chromium（本地 Chrome channel）** 真实运行，覆盖 Connections 树的行派生、DI 装配、空状态、Reload、Dispose、`error`/`lost` 状态与 describe 失败行。
- **PASS（本机）**：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`（单元 138 + cancellation 6 + conformance 8 + contract 4 + stdio 22 = 178）、`nyala:validate-product`、`nyala:validate-rpc`、`nyala:check-rpc-generated`、Nyala 其余 node 套件 47 passing / 1 pending、`git diff --check`。
- **BLOCKED（本机环境）**：`typecheck-client` 需要 `.build/typings/electron.d.ts`，本机离线无法从 GitHub Releases 下载；`tsc` 全项目报 387 条错误，全部来自缺失的 Electron 类型（`electron`/`original-fs` 模块与 `Process.noAsar` 等），**Nyala 文件 0 条**。以 CI 的 `Client typecheck and hygiene` 为准。

### P2.3 · N-202 Query EditorInput + Context（`feat/n202-query-editor-context`）

- 新目录 `src/vs/workbench/contrib/nyala/query/`：`common/nyalaQueryResource.ts`（URI 与编辑器/语言常量）、`common/nyalaQueryEditorInput.ts`（`EditorInput`，只持有身份与对共享文档的引用）、`common/nyalaQueryDocument.ts` / `nyalaQueryDocumentService.ts`（每个 `queryId` 一个文档：模型、脏状态、上下文与引用计数）、`common/nyalaQueryContext.ts` / `nyalaQueryContextService.ts`（绑定与 latest-intent）、`browser/nyalaQueryEditorPane.ts`（`AbstractTextCodeEditor` + 状态行）、`browser/nyalaQuery.contribution.ts`（Pane/Resolver/Serializer/两个命令/标题菜单）。
- 身份与隔离：`queryId` 是 EditorInput 身份，binding 是运行时身份，两者不互推；`NyalaQueryContext` 逐查询一个对象，禁止从全局当前连接推断。四种失效（runtime 换代、runtime 不可用、Profile 断开、Profile 被后台重连）都会 `unbind` 并给出可读理由，且**不自动改绑**。
- URI 只含 uuid：`nyala-query://local/<queryId>`，无 query、无 fragment；路径/会话/凭据只存在于 Profile 与 runtime handle 中。序列化只写 `{ queryId }`（不写 SQL 正文），反序列化校验 id 形态，坏数据拒绝。
- 复用而非重写：`IEditorService.openEditor`、`AbstractTextCodeEditor`（`CodeEditorWidget`）、`IEditorPaneRegistry`/`IEditorResolverService`/`IEditorFactoryRegistry`、`IModelService`；没有新的 Tab 系统、没有改 `EditorService`。
- 命令：`nyala.query.new`（`Nyala: New Query`）与 `nyala.query.changeConnection`（仅对激活的查询标签页生效，标题菜单仅在 `resourceScheme === nyala-query` 时出现）。
- **PASS（本机，Windows 11，Chromium 实跑）**：`nyalaQueryEditor.test.ts` **25 passing**、`nyalaQueryContext.test.ts` **21 passing**、`nyalaBootstrap.test.ts` **18 passing**、`nyalaConnectionService.test.ts` **39 passing**；Nyala 文件 `tsc` **0 错误**；`git diff --check` PASS。
- **NOT RUN**：桌面原生 E2E（N-207：连接→编辑→执行→结果→重启）、macOS/Linux 原生；执行命令（N-203）与结果面板（N-204）本就不在范围。

### P2.4 · 审查修复（PR #49 Phase A + PR #50 Phase B）

**Session 所有权（#49）**：刷新失败不再等同于会话失效。catalog 元数据失败（`PROTOCOL_MISMATCH`、IPC 异常）保留 handle 与可关闭入口；只有 `INVALID_SESSION`/`RUNTIME_LOST` 这类确定失效才丢弃 handle。关不掉的 session 进入 `stranded`，`disconnect`/重连会重试关闭，runtime 换代时清理。`connect()` 在旧 session 关闭未确认前不再打开新 session；打开后异常的清理路径在 `closeSession()` 返回 false 时保留 handle，而不是把唯一引用丢掉。证据：`nyalaConnectionService.test.ts` 新增 8 条确定性用例（FakeBridge 的 `throws`/`holdConnect` 控制顺序），改实现前 5 条失败，现 **39 passing**。

**绑定意图（#50）**：`NyalaQueryContextService.bind()` 引入 latest-intent 计数，覆盖「A 后发先至」「迟到的 A 不覆盖 B」「标签页关闭后的迟到回复」「释放后同 queryId 重建」「bind 期间 runtime 换代」「快速连续选择停在最后一个有效操作」。检查不只在 `await` 前：`connect()` 之后、`context.bind()` 之前都重新校验 intent、context 身份、是否已释放与 runtime 代际。证据：`nyalaQueryContext.test.ts` 新增 6 组用例。

**文本与上下文所有权（#50）**：新增 `NyalaQueryDocument`（每个 `queryId` 一个）与 `NyalaQueryDocumentService`。Input 构造时 `acquire()`、销毁时释放引用；同一 `queryId` 的两个 Input 共享模型与上下文，关闭其一不影响另一；最后一个引用释放才 `destroyModel` 并 `release(queryId)`；重复释放是空操作，已关闭文档拒绝交出模型。Pane 只观察 Document 的上下文，不再自行 `create`/`release`。测试用两个真实 Input 与两个真实 Pane 验证。

**保存策略（#50，B3）**：N-202 明确是 scratch buffer。`save()`/`saveAs()` 抛本地化错误并由工作台显示通知，不再继承「返回 `this` 的静默成功」；脏标签页关闭走 `IEditorCloseHandler`，只给「关闭/取消」；`revert()` 恢复打开时文本；`EditorInputCapabilities.Scratchpad` 使其不进入「全部保存」。序列化只写 `{ queryId }`，**不写 SQL 正文**——布局文件不再成为敏感语句的静默存储；N-206 负责 opt-in 草稿与 `.sql` 文件保存。ADR 0007 §6 记录该决策。

**最终审查收口（#50）**：

1. **切换连接期间没有执行目标**：`NyalaQueryContext` 增加 `bindingState`（`idle`/`switching`）。已绑定 A 的用户显式选择 B 时，`bind()` 在打开 B 之前调用 `beginSwitch()` 清空 binding，因此 `canExecute()` 为 false、`getExecutionBinding()` 为 `undefined`，状态行与标题显示「正在连接 B」。B 成功只绑定 B；B 失败**不恢复 A**，而是保留无绑定并记录 `connection-failed`——用户已表示要离开 A，悄悄接回就是本 ADR 禁止的隐式改绑。重新选择**当前已绑定**的同一 Profile 不经过 `switching`，失败时保留原绑定。乱序返回仍由 per-query intent 决定：迟到的回复既不绑定也不改变状态。关闭标签页、runtime 换代/不可用、Session 失效都会收束切换状态。测试全部用 `DeferredPromise` 控制 connect 完成时机，没有 timeout。
2. **标题与状态栏同步**：`NyalaQueryEditorInput` 订阅共享 Document 的 `onDidChangeBinding` 并触发 `onDidChangeLabel`；Pane 的状态行同样从 Document 的绑定事件派生。两个共享 `queryId` 的 Input 在连接、切换、断开时都各自刷新。
3. **Document 监听器释放**：`NyalaQueryDocumentService` 的每文档 `onDidDispose` 订阅改存 `DisposableMap`，Document 销毁时连同订阅一起移除，订阅数恒等于存活文档数。移除前核对订阅归属，避免清掉同 id 重新打开后新文档的订阅。
4. **陈旧注释修正**：Pane 头部不再声称「保存会写入 `.sql` 文件」，改为明确「N-202 没有文件后端」；Contribution 头部改为「恢复只含 queryId，不恢复正文」，与 ADR 0007 §6 一致。

- **PASS（本机，Windows 11）**：`nyalaQueryEditor.test.ts` **29 passing**（Chromium）、`nyalaQueryContext.test.ts` **29 passing**、`nyalaConnectionService.test.ts` 39 passing、`nyalaBootstrap.test.ts` 18 passing（Chromium）；`build-fast --client-only` PASS；`tsc -p src/tsconfig.json` 中 Nyala 文件 0 错误（全项目 387 条仍为缺失 Electron 类型的既有环境问题）。
- **NOT RUN（具体阻塞）**：原生 Electron smoke。Electron 43.7.7 已从 `%LOCALAPPDATA%\electron\Cache` 装入 `.build/electron`，但应用在开窗前退出（exit 1）：`@vscode/policy-watcher` 的 `.node` 绑定缺失，`NativePolicyService._updatePolicyDefinitions` 在 `ConfigurationService.initialize` 中产生未处理拒绝。离线重建该模块因本机 MSVC 未安装 Spectre 缓解库而失败（MSB8040）；没有通过移除 `SpectreMitigation` 来绕过。桌面原生 E2E 仍属 N-207。

### P2.5 · N-203 Query Execution（`feat/n203-query-execution`，Draft PR #51）

- 设计：新增 [ADR 0008](../../adr/0008-n203-query-execution.md)（执行快照、ExecutionId 身份、状态推进、取消语义、结果租约与上限、Ctrl/Cmd+Enter 与 Monaco 的冲突取舍、Main 进程校验、与 N-204 的最小接口）与 [实施拆分与验收矩阵](docs/32-n203-execution-plan.md)（S1–S6，A1–A28）。审查后按 D1–D4 修订：执行结束不等于结果释放、未知结果诚实报告、取消/校准的身份与版本规则、选区多语句明确拒绝。
- 实现：
  - `query/common/nyalaSqlStatements.ts`：SQL-aware 分割，识别字符串/标识符/注释与 SQLite Trigger 的 `BEGIN … END`（含 `CASE … END`）；无法可靠识别时返回失败而不是猜一个片段。
  - `query/common/nyalaQueryExecution.ts`：不可变快照、状态机、终态冻结、sequence/代际过滤、取消回复不覆盖权威状态、`unknown`/`notSent` 语义。
  - `query/common/nyalaQueryExecutionService.ts`：执行所有权；每 `queryId` 一个非终态执行；发送前注册 pending；关闭后 abandoned 并在迟到回复时取消；结果租约（acquire/release）、每窗口 3 个句柄上限与淘汰、换代本地遗忘、`release` 至多一次；已终止且无结果的旧执行记录会被清理，窗口不会按执行次数累积。
  - `query/browser/nyalaQueryExecution.contribution.ts`：`Nyala: Execute`（Ctrl/Cmd+Enter，选区优先否则当前语句）、`Nyala: Execute Selection`（无默认键）、`Nyala: Execute Script`（Shift+Ctrl/Cmd+Enter）。
  - Main 进程：新增 5 个命令与 `QueryStateChanged` 通知；参数与回复结构校验；`sent`/`answered` 让执行服务区分「确定未执行」与「结果未知」。
- **PASS（本机，Windows 11）**：`nyalaSqlStatements` 18、`nyalaQueryExecution` 17、`nyalaQueryExecutionService` 59、`nyalaQueryContext` 29、`nyalaConnectionService` 39、`nyalaRuntimeRequest` 10、`nyalaRuntimeChannel` 13、`nyalaRuntimeProtocol` 8；浏览器 `nyalaQueryExecution` 10、`nyalaQueryEditor` 29、`nyalaBootstrap` 18；`build-fast` PASS；Nyala 文件 `tsc` 0 错误。
- **红/绿（实测）**：分别回退触发器跟踪、终态冻结、`canExecute` 门禁与未知语义、键位 weight，对应套件出现 4 / 2 / 3 / 1 条失败；恢复后全部通过。
- **复审收口（CHANGES_REQUESTED）**：
  - 早到通知：Main 可能在同一轮先回 `query.execute` 成功帧、再同步派发 `query.stateChanged`，而服务续体尚未运行。按 `executionId` 缓存（最多 16 个执行、每个 8 条），采纳后回放；换代清空、旧代际不入缓存。
  - 结果所有权：被拒收的第 4 个结果显式 `release` 而非丢弃；配额按「保留 + 在途 release」计数，新执行等待淘汰释放完成；关闭已完成查询时脱离 `byQuery`、清空 SQL 快照、释放无租约结果，有租约的结果保留到最后一个消费者；在途 release 的 Promise 拒绝被捕获。
  - IPC 失败：`execute`/`cancel` 的 Promise 拒绝 → `unknown`，不会停在 `queued`；`getState` 拒绝只结束校准；`fetchPage` 拒绝转可读错误；终态 cancel 缺 `resultIds` 时用一次 `getState` 补齐；释放后的租约与换代后的迟到页回复都被拒绝。
  - 空白选区：`hasSelection()` 区分「无选区」与「选了空白/注释」；有选区但没有 SQL 时明确拒绝，绝不退化为执行光标下方语句（例如 `DELETE`）。
  - **证据**：`nyalaQueryExecutionService` 41 passing、Chromium `nyalaQueryExecution` 10 passing；回退上述修复分别出现 7 条 Node 与 1 条 Chromium 失败，恢复后全绿。
- **资源与生命周期收口（F1–F3）**：
  - 配额只在 Runtime 确认后恢复：失败、拒绝投递与不可信答案计入 `unconfirmedReleases`，不虚报；Runtime 自己拒绝或 `{released:true|false}` 才释放；换代清零；仍至多发送一次，不重试。在途 release 会让新执行等待而不是盲发。
  - 无主执行在终态收束：关闭标签页后立即清空 SQL 并脱离 `byQuery`，按 `executionId` 保留到终态；`cancelled`/`completed`/`unknown` 或取消回复到达时清理无租约结果并遗忘记录；有租约的结果保留到最后一个消费者。
  - 元数据校准校验代际、`executionId` 与记录归属；`metadataSettled` 只在成功后置位，失败写入 `metadataUnavailable`；关闭后到达的回复不注册结果。
  - **证据**：`nyalaQueryExecutionService` **59 passing**；回退三处修复出现 13 条失败，恢复后全绿。
- **范围**：Rust 执行器与 `nyala/rpc/**` 未改；未实现结果网格（N-204/N-205）、草稿持久化（N-206）、桌面 E2E（N-207）。
- **CI（HEAD `a0ce7e54a6e`）**：四项必需检查 PASS（[run 41665473827](https://github.com/baicie/nyala-studio-next/actions/runs/41665473827)）；手动 Full test suites PASS（[run 41666261425](https://github.com/baicie/nyala-studio-next/actions/runs/41666261425)）。
- **NOT RUN**：原生 Electron smoke（仍受 `@vscode/policy-watcher` 原生绑定阻塞），不以 Chromium 单测替代。

## 2026-11-01 子会话收尾状态

| PR | 已核对 head / 主线提交 | 状态与证据 |
|---|---|---|
| #32 | squash `01c953e2c70` | **MERGED**；主线 run `41270714546` 四项必需检查 PASS |
| #33 | `f04316fcb2a` → squash `195475b84b3` | **MERGED**；合并树与已审 head 一致，主线 run `41290936784` 四项必需检查 PASS |
| #34 | `a334073f505` → squash `2b73f20285c` | **MERGED**（2026-11-01 14:08Z）；run `41300628923` 四项必需检查 PASS；Windows 原生 17/17 PASS，含直接 `vscode:restartAgentHost` 被主进程拒绝 |
| #35 | `66c0e4b4cbc`（含 #34 的组合 head）→ squash `24c3cc7aa23` | **MERGED**（2026-11-01 14:30Z）；组合 head 四项必需检查 PASS（`Unit tests (node)` Linux 日志 `71 passing`，含 POSIX 执行位用例）；本机组合验证 71 passing / 1 pending、两个浏览器套件 1 + 7 passing、`typecheck-client`、`validate-product`、`validate-rpc`、`git diff --check` PASS |

- **P2 已修复并合入 — PR #35 staging 缓存**：原 `stageNyalaRuntimeExecutable` 仅用文件大小、取整毫秒修改时间和 basename 生成缓存位置，命中只核对大小。两个同名、同大小、同时间戳的不同来源会复用同一副本；同源等长内容变化或缓存等长污染也可能启动旧/错误内容；POSIX 仅补 execute 位时旧缓存权限不更新。
  - 修复（父会话接手，commit `58a30bf4349`）：目录名改为 `<size>-<sha256>`，POSIX 带执行位时追加 `-x`；命中前重算副本 SHA-256 并比较执行位（只比执行位，避免 umask 导致每次重写）；副本从已哈希的字节写出。ADR 0004 §8 同步更新，并补实测耗时（2.37 MB 调试构建：读约 1 ms、SHA-256 约 5 ms、写出约 2 ms）。
  - 红绿对照 **PASS**：退回旧实现时 4 个新增内容回归全部失败；新实现下 CI 单测文件列表 **70 passing / 1 pending**（`NYALA_RUNTIME_REQUIRED=1`，真实 cargo 产物）。`typecheck-client`、定向 ESLint、`nyala:validate-product`、`nyala:validate-rpc`、`git diff --check` **PASS**。
  - POSIX 执行位用例在本机 Windows 被跳过（无 WSL 发行版、Docker daemon 未运行），由 CI 的 Linux `Unit tests (node)` 覆盖并通过（run `41314270226`，日志 `✔ staging follows the source execute bits on POSIX and ignores them on Windows`、`71 passing`）。
  - 本机 `gulp hygiene` 因 `build/gulpfile.hygiene.ts` 在 Windows 上把路径拼成 `D:\D:\…` 而以 `ENOENT` 失败，属本机环境问题；以 CI 的 `Client typecheck and hygiene` PASS 为准。
- **合并权限**：PR #34（`a334073f505`）与 PR #35（`66c0e4b4cbc`）的 squash 合并均按已审 full SHA 执行成功；此前两次 `Merge Without Review` 拒绝未通过任何方式绕过。
- 正式 `patchCount` 已在 PR #34、#35 合入后按 `nyala/main` `24c3cc7aa23` 实测更新为 **57 = 51 个修改的上游跟踪文件 + 6 个新增 Nyala 源文件**（与合并前预测一致）。`nyala/upstream-base.json` 已改为 `patchCount: 57`，`patchCountBasis` 改为 “51 modified upstream-tracked files plus 6 new Nyala source files”；`nyala/patch-ledger.md` 同步。
- PR #35 的集成过程：`58a30bf4349`（P2 修复）→ 合并 `2b73f20285c`（#34 的 squash）得到组合 head `66c0e4b4cbc`，唯一冲突 `nyala/patch-ledger.md` 两侧内容都保留。合并前本机在组合树上跑了 CI 单测文件列表、两个浏览器套件（`nyalaAgentHostEnablement` 1 passing、`nyalaBootstrap` 7 passing）、`typecheck-client` 与产品/RPC 校验。
- 本机证据文件：PR #34 的 `electron-20261101-review-60af7d7-rerun/result.json` 为 17/17 PASS，记录 Node `24.16.0` / npm `11.13.0`（PR 描述写 `24.18.0` / `11.16.0`，不一致，不作为指定 Node 版本的原生验收）；PR #35 的 `nyala-runtime-smoke-4/result.json` 为 5/5 PASS，记录的是 `ebbf44da9c2` 加审核修复的提交前工作树，不是最终 head 上的组合验收。
- **NOT RUN**：Linux/macOS 原生 Electron 冒烟、`scripts/nyala/smoke-runtime.ts` 在最终 head 上重跑、系统级抓包、打包安装与更新链路、Renderer Bridge 与 N-105–N-109。
- 本次收尾核对：`git diff --check`、`nyala:validate-product`、`nyala:validate-rpc`、文档 UTF-8 与相对链接 **PASS**；本机 Node `24.16.0` / npm `11.13.0`，与 `.nvmrc` 的 `24.18.0` 不一致，未把本机结果当作指定版本证据。`Full test suites (manual)` 仍为 SKIPPED，不代表全量测试 PASS。

## 2026-10-30 收口记录（#21–#31 全部合入）

| PR | 分支 | head | CI run | 结果 |
|---|---|---|---|---|
| #22 | `fix/nyala-ci-hygiene-deps` | `fd138d074c5` | 40870342300 | 2/2 → squash `b48a859214a` |
| #23 | `fix/p0-windows-smoke` | `85b141390c0` | 41021663868 | 2/2 → squash `3a8cbc0b49f` |
| #27 | `fix/rpc-failure-id-null` | `bc87c4772c9` | 41022164396 | 2/2 → squash `1b0922d6321` |
| #24 | `fix/extension-api-version` | `284c74242eb` | 41022562593 | 2/2 → squash `52664d3b715` |
| #26 | `fix/disabled-chat-runtime` | `c1cd1365c69` | 41023407944 | 2/2 → squash `dfa366609c5` |
| #25 | `feat/p1-rust-runtime` | `689a5aaec29` | 41024634079 | 3/3（含 Rust runtime）→ squash `7bfc4fc2a68` |
| #21 | `docs/nyala-design-v1.1` | `a1d60e10c02` | 41025472617 | 2/2 → squash `b9639120316` |
| #28 | `ci/unit-test-gate` | `8a47ae404e7` | 41031484168 | 4/4（新增 `Unit tests (node)`）→ squash `e17977fc7b0` |
| #29 | `docs/record-branch-protection` | `52451c6c550` | 41032763612 | 4/4 → squash `e8fb3d3fce3`：记录分支保护开启与 CI 门禁 |
| #30 | `ci/browser-test-manual` | `f02e67dd4d9` | 41048853809 | 4/4（`Browser tests (manual)` 为 SKIPPED）→ squash `2ac10fbc88f` |
| #31 | `ci/upstream-parity-tests` | `7218555963b` | 41075763186 | 4/4（`Full test suites (manual)` 为 SKIPPED）→ squash `2db1dcd73ca`。合并后手动触发的 41076623105 五个 job 均为 success；其中 `Browser unit tests (full suite)` 设了 `continue-on-error`，它的 success 不代表全量浏览器测试通过 |

- 合并方式：逐个 `gh pr merge --squash`；每个分支合并前先用新的 `nyala/main` 更新并重跑 CI，确保 PR diff 只含自身改动（#23 7 files / #24 13 files / #26 11 files / #25 19 files，均无其它 PR 内容泄漏）。
- 合同勘误（新增 PR #27）：`nyala/rpc/v1` 的 `$defs/failureId` 允许 `"id": null`（JSON-RPC 2.0 §5），只放宽 `failure.id`，`$defs/id` 仍要求字符串。Rust 侧绊线断言已翻转为「schema 接受」，`cargo test --workspace --locked` 47 个测试通过。
- 只读治理审查结论：#25 与 #23/#24/#26 均 PASS-WITH-RISK；必须解决项为「CI 无单测门禁」（见缺口 7）、`extensionsScannerService.ts` 与 `chatEntitlementService.ts` 两处超出 1–3 行且未记录否决替代方案的理由；`validate-product` 覆盖缺口见缺口 8。审查曾提出「PR #26 描述缺第 7 个上游文件」，经复核为误判未采纳。
- 合并后校验：`npm run nyala:validate-rpc`（exit 0，36 definitions）、`npm run nyala:validate-product`（`Nyala product baseline is valid.`）在 `nyala/main` 上均通过。
- 分支保护已开启（2026-10-30）：`nyala/main` 要求四个 checks 通过、禁止 force-push 与删除分支，不要求人工 approve；关闭命令见上节。CI 门禁新增 `Unit tests (node)`，实测 `38 passing`（`extensionsScannerService.test.ts`）。
## 未完成 / 已知缺口

1. ~~**CI 仍然跑不出结果（GitHub 账单阻断 + workflow 缺 build/ 依赖）**~~：账单阻断已随仓库转为公开解除；`Hygiene` 因 `nyala-ci.yml` 未安装 `build/` 依赖而失败的缺陷已由 **PR #22** 修复并合入（`b48a859214a`）。
2. ~~**开发版本号与内置语言服务不兼容**~~：已在 `fix/extension-api-version`（`6d35da69627`，已随 PR #24 合入 `nyala/main`）修复。css/html/json/markdown 四个语言功能修复前都因 `vscode-languageclient` 的 semver 检查激活失败；修复后全部激活，Windows 原生冒烟 PASS 12/12。剩余缺口：第三方 VSIX 的 `engines.vscode` 校验仍按 `0.0.1-dev.0`（见 [ADR 0003](../../docs/adr/0003-extension-api-version.md)）；`patchCount` 已于 2026-11-01 由 46 改为 50（见 patch ledger）。
3. ~~**运行时 Chat / Copilot 仍可见**~~：已在 `fix/disabled-chat-runtime`（`f6f1e2489bb`，已随 PR #26 合入 `nyala/main`）修复。原因是开发态把 `extensions/copilot` 当作内置扩展加载，它注册默认 Chat 参与者并静默请求 `microsoft` 会话；另外 `chatSetupHidden` 没有设置。修复后 Windows 原生冒烟中 Chat 视图不显示，`GitHub.copilot-chat` 与 `vscode.microsoft-authentication` 都不激活。**两条出站路径已随 PR #34（squash `2b73f20285c`）合入**：Agent Host 不再启动（renderer 门控 + 主进程 `ElectronAgentHostStarter.start()` 第二层门禁），Chromium 拼写词典下载被 `session-created` 钩子关闭；Windows 原生冒烟 17/17 PASS（含直接 `vscode:restartAgentHost` 被拒），见 [ADR 0005](../adr/0005-disabled-chat-runtime-egress.md)。Linux / macOS 原生复跑与系统级抓包仍 **NOT RUN**。
4. Linux 原生启动，以及所有平台的安装包、签名、更新链路均未验证；macOS 未用 `1.143.0` 复跑。
5. Rust Runtime：N-101/N-102 已随 PR #25 合入 `nyala/main`（squash `7bfc4fc2a68`）；N-104 已随 PR #33 合入（`195475b84b3`），N-103 已随 PR #35 合入（`24c3cc7aa23`）；N-105/N-106/N-109 已随 PR #37 合入（`b9f00ff4326`）；N-107 的句柄/分页（含帧上限）/TTL 随 PR #37 落地，单行超帧已在 PR #43（`db514f8837e`）修复，**流式游标与被拒绝结果收不回已写数据仍未做**；N-108 已随 PR #41 合入（`e90619d396b`；per-session worker 线程 + `sqlite3_interrupt`，`cancel_requested` 独立、`unknown` 不自动重放；`tests/cancellation.rs`）；N-110 已随 PR #39 合入（TS/Rust 生成合同 + CI 漂移检查）；`nyala/rpc` 合同已冻结（PR #11）。CI 的 `Rust runtime` job 随该分支加入，只覆盖 ubuntu-latest（见 [ADR 0002](../adr/0002-rust-runtime-workspace.md)）。
6. Windows 本机（`D:\workspace\git-code\nyala-studio-next`）的 `node_modules` / `out` / `.build` / `build/node_modules` 均不存在（2026-10-30 实测）；其他机器恢复需要重新安装与编译（见下）。
7. **单元测试门禁**：`Unit tests (node)` job 每次 PR 必跑，覆盖 `extensionsScannerService.test.ts` 与 `nyalaDisabledChat.test.ts`（后者在 `test/common/`，node runner 可直接加载），CI 实测 `39 passing`。`nyalaBootstrap.test.ts` 在 `test/browser/`，node runner 明确排除，改由 **`Full test suites (manual)` job 覆盖**（`workflow_dispatch` 手动触发）：该 job 复刻上游 `.github/workflows/pr-linux-test.yml` 的两条命令 `npm run test-node` 与 `npm run test-browser-no-install -- --browser chromium`，外加定向跑 `nyalaBootstrap.test.ts`（Chromium 实测 `7 passing`，run `41048113709`）。上游这条链路跑在自托管 1ES 池（`1ES.Pool=1es-vscode-oss-ubuntu-22.04-x64`）上，本 fork 没有该池，故降级为 GitHub 托管 runner + 手动触发。实测两次：run `41050593662`（45 分钟超时终止）与 run `41056484782`（120 分钟超时终止，此时仍在以**每 30 秒一条**的节奏输出超时（编号 2107–2111），即大量测试在本 fork 配置下持续超时）。结论：**上游全量 `npm run test-node` 在本 fork 的 GitHub 托管 runner 上不可行**，故手动 job 的 node 步骤收窄为 `--runGlob vs/platform/extensionManagement/**/*.test.js`（Nyala 补丁实际触及的领域），浏览器全量套件仍按上游命令保留，实测（run `41073529509`）：**42880 passing / 216 pending / 8 failing，约 10 分钟**。8 条失败已归类：4 条是 `…/upgrade-success` URI 断言期待 `GitHub.copilot-chat` 授权（本 fork 在 `product.json` 里置空，属预期差异）、`GitHub Enterprise URIs must be an array…`、`"undefined" === "not-a-url"`、`12 === 10` 三条与 product 配置相关、1 条 `welcomeOnboarding` 超时。因此该步骤设为 `continue-on-error`，基线固定为 8 条失败——**新增失败仍会在日志里显示，便于对比**。两件未做成的事及原因：①`npm run compile` 与 `compile-client` 在 CI 会因 `extensions/copilot` 的 esbuild、扩展 media 的 tsgo 缺依赖而失败，须先补齐各扩展依赖安装；②smoke（`scripts/nyala/smoke-electron.ts`）需真实窗口，ubuntu runner 不适用。
8. ~~**`validate-product` 扫描范围缺口**~~：已关闭。脚本现在同时扫描 `product.json` 的 `builtInExtensions`：能映射到仓库内 `extensions/<folder>` 的条目沿用同一套 chat 贡献点检查；任何形似 chat/copilot 的条目必须出现在 `skipBuiltinExtensions` 中，否则断言失败。

## 治理与 CI 现状（2026-10-29）

### 已落地

- **治理规范 v1.0**：`docs/nyala-governance/`（16 篇 + INDEX + 5 个 checklist）、3 个 `nyala-*.instructions.md`、`nyala/AGENTS.md`、`src/vs/workbench/contrib/nyala/AGENTS.md`，根 `AGENTS.md` 与 `START-HERE.md` 只做索引追加；见 PR #15。
- **Dependabot 收敛**：github-actions 合并为 1 个分组 PR、三段并发上限 1、github-actions/devcontainers 改 monthly、npm 由 daily 改 weekly；见 PR #16。
- **上游 workflow 降噪**：用 GitHub API 手动停用 8 个在本 fork 无法跑通的 workflow（**不改任何文件**，可逐条恢复）：`pr.yml`、`pr-node-modules.yml`、`codeql.yml`、`telemetry.yml`、`monaco-editor.yml`、`component-fixtures.yml`、`copilot-setup-steps.yml`、`css-order-scan.yml`。
  - 保留：`nyala-ci.yml`（自有门禁）、`chat-lib-package.yml` 与 `chat-perf.yml`（仅手动触发）、`sessions-e2e.yml`（仅手动触发）、`pr-*-test.yml`（仅 `workflow_call`，由已停用的 `pr.yml` 调用）。
  - 恢复单条：`gh api -X PUT repos/baicie/nyala-studio-next/actions/workflows/<workflow-id>/enable`；`gh api repos/baicie/nyala-studio-next/actions/workflows --jq '.workflows[] | "\(.id) \(.state) \(.path)"'` 可查看状态。

### 历史 BLOCKED 项（两项均已关闭）

| 事项 | 历史证据 | 当前状态 | 验收证据 |
|---|---|---|---|
| GitHub Actions 计费阻断 | Run 注解 `The job was not started because recent account payments have failed…`；2026-10-29 的 Run 全部 `failure`/`queued` | **已解除**：仓库转为公开后 Actions 正常启动（PR #22 起的 6 个 PR 均跑出真实 step） | 见下方「2026-10-30 收口记录」的 run id |
| 分支保护 / rulesets 不可用 | `branches/nyala/main/protection` 与 `/rulesets` 曾返回 403 `Upgrade to GitHub Pro or make this repository public` | **已开启**（2026-10-30）：required status checks = `Product baseline`、`Client typecheck and hygiene`、`Unit tests (node)`、`Rust runtime`；`enforce_admins=false`；禁止 force-push 与删除分支；**未要求人工 approve**（单 owner 仓库会自锁） | `gh api repos/baicie/nyala-studio-next/branches/nyala/main/protection` 返回 200 且 contexts 与上面一致 |

关闭分支配保护（如需）：

```bash
gh api -X DELETE repos/baicie/nyala-studio-next/branches/nyala/main/protection
```

### CODEOWNERS 结论

`.github/CODEOWNERS` 全部指向上游微软员工（`@lszomoru`、`@alexdima` 等），在本 fork 中既无强制力也无法真正请求到这些 reviewer。分支保护虽已开启，但**不要求人工 approve**，因此**本次仍不改该文件**（避免无意义的上游 patch）。后续若要引入 Nyala 自有 owner 段，应同时开启 required reviews，否则只是增加同步冲突面。

### 合并纪律（protected branch 生效后）

1. 任何进入 `nyala/main` 的改动必须走 PR，且在 PR 上跑完四个 required checks。
2. 功能 PR 用 Squash；同步类 PR（`sync/code-oss-<tag>`）必须保留上游 Tag 祖先，用 Merge Commit。
3. PR 模板中写明 PASS / FAIL / BLOCKED / NOT RUN，并给出 `git diff --check` 与按改动类型选择的最小验证。

## 下一步（建议顺序）

1. ~~合并 PR #8~~ 已完成（2026-10-29）；产品约束、产品校验脚本与 CI 已在 `nyala/main`。
2. ~~解决 CI 账单~~ 已解除（2026-10-30 仓库转为公开）；`nyala:validate-rpc` 早已在 `nyala-ci.yml` 中，Hygiene 依赖缺口由 PR #22 修复。
3. ~~补 P0 生命周期回归~~ 已在 `fix/p0-windows-smoke` 完成；内置语言服务激活失败已在 `fix/extension-api-version` 修复；运行时 Chat / Microsoft 认证已在 `fix/disabled-chat-runtime` 关闭；两条出站路径已随 PR #34（`2b73f20285c`）合入并关闭。仍需 Linux / macOS 原生复跑，不能用 Windows 结果替代。
4. P1.1：~~Rust crate + stdio framing + hello / health / error~~ 已随 PR #25 合入。N-104 SQLite Profile/Session 随 PR #33（`195475b84b3`）、N-103 Electron Main Supervisor 随 PR #35（`24c3cc7aa23`）合入；N-105 元数据、N-106 查询执行、N-109 只读强制随 PR #37（`b9f00ff4326`）合入，N-108 取消随 PR #41（`e90619d396b`）、N-110 生成合同随 PR #39（`113a170be69`）合入。**P1 剩余**：N-107 的流式游标与被拒绝结果的事务语义（ADR 0002 后续项 11、14），以及 P1 Exit 要求的跨平台复跑。P2 尚未开工。

## 新机器恢复步骤（macOS / Linux）

```bash
git clone https://github.com/baicie/nyala-studio-next.git
cd nyala-studio-next
git fetch --all              # 三个分支都要看，PR 分支不在 main 上
git switch nyala/main        # 或切到 fix/review-audit-findings、feat/p1-rpc-contract
nvm use                      # .nvmrc = 24.18.0
npm install
npm run compile
npm run nyala:validate-rpc   # 纯 Node，无依赖，可先跑
./scripts/code.sh            # 首次会准备 .build/electron
```

- `npm run compile` 生成 `out/`；`./scripts/code.sh` 负责 Electron 下载与启动。
- Rust 侧只需 `cargo`（本机验证 `cargo 1.96.0` 可用）；Nyala Runtime 在 `rust/`（`cd rust && cargo test`），`cli/` 是上游 CLI 资源，不含 Nyala Runtime。
- 校验基线：`npm run compile`、`npm run typecheck-client`、`npm run build-fast -- --client-only`、`npm run gulp hygiene`、定向 ESLint、`git diff --check`。
- 本机（Windows）git-lfs smudge 不可用：`git worktree add` 新检出会在 `extensions/copilot/test/simulation/cache/base.sqlite` 报 `smudge filter lfs failed`。需要新 worktree 前先安装并初始化 git-lfs。

## 新机器恢复步骤（Windows）

2026-10-29 在 Windows 11 Pro 10.0.26200 x64 上实测（Git Bash）：

```bash
nvm install 24.18.0 && nvm use 24.18.0     # nvm-windows
export VCToolsVersion=14.42.34433           # 需指向装有 Spectre 缓解库的 MSVC；VS 2026 默认 14.51 没有，会报 MSB8040
export GITHUB_TOKEN="$(gh auth token)"      # 匿名 GitHub API 额度用完时，ripgrep/Electron 下载会 403
npm install                                 # 不要用 --ignore-scripts
npm rebuild @vscode/sqlite3 native-keymap node-pty kerberos native-is-elevated   # 仅当这些包缺 .node 时
npm run compile
npm run electron
node --experimental-strip-types scripts/nyala/smoke-electron.ts --evidence <不含空格的目录> --reloads 2
```

- 安装中断过的话，先核对上面 5 个包的 `build/Release/*.node`；缺 `vscode-sqlite3.node` 会导致存储无法打开，缺 `keymapping.node` 会让快捷键全部失效。
- Reload / Dispose 单元测试：`scripts\test.bat --run src/vs/workbench/contrib/nyala/test/browser/nyalaBootstrap.test.ts`。

## 目录地图

| 路径 | 作用 |
|---|---|
| `docs/nyala-kickoff/` | 设计包：`docs/01`–`31` 设计文档（含路线图/backlog、Agent 专题）+ ADR 0001–0008 + P0 清单 + 本快照 |
| `docs/adr/` | 架构决策记录（0001：RPC 合同 v1.0；0002：Rust Runtime workspace；0003：Extension API 版本；均已合入） |
| `nyala/` | 产品元数据：upstream-base、patch-ledger、upstream-compatibility、rpc 合同 |
| `scripts/nyala/` | 校验脚本（RPC 合同、产品基线）与原生 Electron 冒烟脚本 `smoke-electron.ts` |
| `src/vs/workbench/contrib/nyala/` | Hello Workbench 贡献与 Connections 占位视图 |
| `rust/` | Nyala Rust Runtime workspace（`crates/nyala-runtime`：分帧、hello/health、SQLite Profile/Session、metadata、查询执行与结果分页/释放、取消与超时；流式游标未做） |

## 移交清理记录（2026-10-28）

- 删除：`out/`、`.build/`、全部 `node_modules/`、`*.tsbuildinfo`、`extensions/*/out|dist`、`.eslintcache`、`.playwright-cli/`、`.claude/`（本地符号链接）。
- 体积：7.3 GB → 1.7 GB（其中 `.git` 1.4 GB，工作树约 300 MB）。
- 回滚了一个未提交的 `cli/Cargo.toml` 本地改动（曾为缩小 target 体积给 `[profile.dev.package."*"]` 与 `[profile.test.package."*"]` 设 `debug = false`）；如仍需要，应作为可追踪补丁重新提交并登记 patch ledger。
- 未提交或未推送的分支：无。
