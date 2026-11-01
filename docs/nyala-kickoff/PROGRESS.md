# Nyala Studio · 项目进度快照

> 快照时间：2026-11-01（`nyala/main` `195475b84b3`；原快照 2026-10-29）· 基线 Code OSS `1.143.0`（`2d0b7506a36c1d6db9a466440131a8e01eab2289`，2026-10-29 由 `1.142.0` 同步）· 开发版本 `0.0.1-dev.0`
> 用途：跨机器移交与断点续做。**状态权威顺序：Git 分支与 PR ＞ 本文档 ＞ 会话记忆**；阶段验收仍以 [19-roadmap.md](docs/19-roadmap.md) 为准。

## 一句话状态

P0 Bootstrap 已完成（macOS 原生启动 + 产品身份 + Hello Workbench + 质量门禁记录），已同步到 Code OSS `1.143.0`（保留上游完整历史），P1 协议的 v1.0 可执行合同已冻结；截至 2026-11-01，PR #21–#33 已全部合入 `nyala/main`。**Rust SQL Runtime 的 N-101/N-102（stdio 分帧 + hello/health + 结构化错误，PR #25）与 N-104 SQLite Profile/Session（PR #33，squash `195475b84b3`）已合入**；N-103 Supervisor 已在 Draft PR #35 完成实现并提交审核修复；最终复核新增 staging 缓存身份/权限 P2，正在修复，尚未合入。N-105–N-110 未交付，不能把连接能力视为查询执行、结果分页或 P1 阶段验收完成。合同 v1.0 有一处勘误：`failure.id` 允许 `null`（PR #27）。Windows 11 `1.143.0` 原生冒烟与 Reload/Dispose 单元测试已合入（PR #23）；内置语言功能激活修复（PR #24，ADR 0003）后为 **PASS 12/12**。运行时 Chat 视图、内置 `GitHub.copilot-chat` 与 Microsoft 认证已关闭（PR #26），冒烟扩展到 17 步后为 **FAIL 14/17**：Chat 相关项全部 PASS，这是 PR #26 的历史结果；两条出站路径已在 Ready PR #34 修复并记录 Windows 原生冒烟 **PASS 17/17**（含直接 restart IPC 检查），但修复尚未合入主线。CI 已能真实执行，`nyala/main` 的分支保护要求 4 个 checks。

## 分支与 PR

| 分支 | HEAD | 目标 | 状态 |
|---|---|---|---|
| `nyala/main` | `195475b84b3`（2026-11-01 核对） | 稳定主线 | 已合入 #8、#11、#13–#18、#21–#33；该 HEAD 的主线 CI 四项必需检查 PASS |
| `feat/p1-sqlite-session` | `f04316fcb2a` | → `nyala/main`（PR #33） | **MERGED**（squash `195475b84b3`）：SQLite 连接、会话与审核补测 |
| `fix/close-runtime-egress` | `a334073f505` | → `nyala/main`（PR #34） | **Ready / 未合入**；四项必需检查 PASS，Windows 原生冒烟 17/17 PASS |
| `feat/p1-runtime-supervisor` | `8938b6e22c4` | → `nyala/main`（PR #35） | **Draft / 需修 P2 / 未合入**；已包含 N-104，集成 head 四项必需检查 PASS 但未覆盖 staging 缓存缺陷；Windows 5/5 是先前分支 smoke 证据 |
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
- Reload / Dispose 自动化回归：`src/vs/workbench/contrib/nyala/test/browser/nyalaBootstrap.test.ts`（8 passing）。
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

## 2026-11-01 子会话收尾状态

| PR | 已核对 head / 主线提交 | 状态与证据 |
|---|---|---|
| #32 | squash `01c953e2c70` | **MERGED**；主线 run `41270714546` 四项必需检查 PASS |
| #33 | `f04316fcb2a` → squash `195475b84b3` | **MERGED**；合并树与已审 head 一致，主线 run `41290936784` 四项必需检查 PASS |
| #34 | `a334073f505` | **未合入**；run `41300628923` 四项必需检查 PASS；Windows 原生 17/17 PASS，含直接 `vscode:restartAgentHost` 被主进程拒绝；Quick Open 曾发生一次不稳定，详见 PR 与分支兼容性报告 |
| #35 | `8938b6e22c4` | **未合入 / 需修 P2**；已包含 N-104 主线，run `41307225775` 四项必需检查 PASS、Node 67 passing；最终复核发现 staging 缓存身份与权限缺陷，旧绿灯不覆盖该缺陷，待修复重验；Windows 5/5 为此前审核修复工作树证据 |

- **FAIL — PR #35 最终代码复核（P2）**：`stageNyalaRuntimeExecutable` 仅用文件大小、取整毫秒修改时间和 basename 生成缓存位置，命中只核对大小。两个同名、同大小、同时间戳的不同来源会复用同一副本；同源等长内容变化或缓存等长污染也可能启动旧/错误内容；POSIX 仅补 execute 位时旧缓存权限不更新。父会话已核对集成 head `8938b6e22c4` 仍保留该逻辑及原测试的等长污染复用断言，未将代理结论直接当作复现结果。已交回原 N-103 子会话修复缓存身份/内容/权限校验并补红绿回归；目前未修复，不能依据现有 CI PASS 判定可合。
- **BLOCKED — 合并权限**：用户已明确允许继续合并；PR #34 已成功标记 Ready，但随后 squash 合并仍被客户端权限策略以 `Merge Without Review` 拒绝，未合入。PR #34/#35 都不得登记为已合入，也未改分支保护或通过其他会话绕过拒绝。
- 正式 `patchCount` 仍为 **50**，因为 PR #33 不改计数范围内文件。待 PR #34/#35 实际合入后，重新逐文件核算；当前候选增量为 #34 的 2 个上游文件，以及 #35 的 1 个上游文件 + 4 个 Nyala 源文件，合计预测 **57 = 51 + 6**，不是原先的 56。正式计数只在合并后更新。
- PR #35 已推送集成 head `8938b6e22c4c324ac725954bab689918f8ec6d3d`：两个父提交为原审核修复 `4eb0326e2e22d620029d70db8044e2e5e8c8ce8f` 与 N-104 主线 `195475b84b38f47fb2129a5b02d624141a873e38`。祖先检查与差异核对确认 SQLite 原样带入、Supervisor 源码和既有修复未变。原子会话报告 Windows Runtime 重建、client build、67 项定向测试与 diff 检查 PASS；本会话另核对新 head 的 CI run `41307225775`：四项必需检查 PASS，日志含 `NYALA_RUNTIME_REQUIRED=1`、真实 Runtime/staging 套件和 `67 passing`。这补齐的是 N-103 与 N-104 的集成，不是与 PR #34 的组合验证；后者仍 **NOT RUN**。此前两个候选分支的 ledger 冲突尚待 PR #34 合入后解决。PR 描述更新被子会话客户端权限策略拒绝，未绕过；当前以 Git 提交、CI 与本文记录为准。
- 本机证据文件已核对：PR #34 的 `electron-20261101-review-60af7d7-rerun/result.json` 为 17/17 PASS，记录 Node `24.16.0` / npm `11.13.0`，与该 PR 描述中的 `24.18.0` / `11.16.0` 不一致；不将它视为指定 Node 版本的原生验收。PR #35 的 `nyala-runtime-smoke-4/result.json` 为 5/5 PASS，记录 `ebbf44da9c2` 加审核修复的提交前工作树与 Node `24.16.0`，不是新 head 上的组合验收。
- 本次本地收尾仅修正状态文档；`git diff --check`、`nyala:validate-product`、`nyala:validate-rpc`、8 份文档的 UTF-8 与相对链接检查 **PASS**。本机 Node `24.16.0` / npm `11.13.0`，不等于 `.nvmrc` 的 `24.18.0`；没有把这次纯文档验证算作指定版本的编译或原生证据。未重跑 Electron 冒烟或全量编译。`Full test suites (manual)` 仍为 SKIPPED，不代表全量测试 PASS；Linux/macOS 原生 smoke、打包、Renderer Bridge 与查询执行仍未验收。

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
3. ~~**运行时 Chat / Copilot 仍可见**~~：已在 `fix/disabled-chat-runtime`（`f6f1e2489bb`，已随 PR #26 合入 `nyala/main`）修复。原因是开发态把 `extensions/copilot` 当作内置扩展加载，它注册默认 Chat 参与者并静默请求 `microsoft` 会话；另外 `chatSetupHidden` 没有设置。修复后 Windows 原生冒烟中 Chat 视图不显示，`GitHub.copilot-chat` 与 `vscode.microsoft-authentication` 都不激活。**主线仍有出站路径**：Agent Host 启动及 Chromium 拼写词典下载在 PR #26 历史冒烟中 FAIL；Ready PR #34 已修复两条路径并记录 Windows 17/17 PASS，但截至本快照未合入，不能关闭主线缺口。
4. Linux 原生启动，以及所有平台的安装包、签名、更新链路均未验证；macOS 未用 `1.143.0` 复跑。
5. Rust Runtime：N-101/N-102 已随 PR #25 合入 `nyala/main`（squash `7bfc4fc2a68`）；N-104 已随 PR #33 合入（`195475b84b3`），N-103 已在 Draft PR #35 完成实现与审核修复、尚未合入；N-105–N-110 未交付；`nyala/rpc` 合同已冻结（PR #11）。CI 的 `Rust runtime` job 随该分支加入，只覆盖 ubuntu-latest（见 [ADR 0002](../adr/0002-rust-runtime-workspace.md)）。
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
3. ~~补 P0 生命周期回归~~ 已在 `fix/p0-windows-smoke` 完成；内置语言服务激活失败已在 `fix/extension-api-version` 修复；运行时 Chat / Microsoft 认证已在 `fix/disabled-chat-runtime` 关闭；两条出站路径修复在 Ready PR #34（`a334073f505`）等待合并权限；合入后仍需 Linux / macOS 原生复跑，不能用 Windows 结果替代。
4. P1.1：~~Rust crate + stdio framing + hello / health / error~~ 已随 PR #25 合入。N-104 SQLite Profile/Session 已随 PR #33 合入；接下来完成 Ready PR #34/#35 的审核、组合验证与 squash 合并，再推进 N-105 元数据、N-106 查询执行及后续任务。

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
| `rust/` | Nyala Rust Runtime workspace（`crates/nyala-runtime`：N-101/N-102/N-104；尚无查询执行与结果分页） |

## 移交清理记录（2026-10-28）

- 删除：`out/`、`.build/`、全部 `node_modules/`、`*.tsbuildinfo`、`extensions/*/out|dist`、`.eslintcache`、`.playwright-cli/`、`.claude/`（本地符号链接）。
- 体积：7.3 GB → 1.7 GB（其中 `.git` 1.4 GB，工作树约 300 MB）。
- 回滚了一个未提交的 `cli/Cargo.toml` 本地改动（曾为缩小 target 体积给 `[profile.dev.package."*"]` 与 `[profile.test.package."*"]` 设 `debug = false`）；如仍需要，应作为可追踪补丁重新提交并登记 patch ledger。
- 未提交或未推送的分支：无。
