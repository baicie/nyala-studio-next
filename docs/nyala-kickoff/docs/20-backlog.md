# 20 · 可直接建 Issue 的任务 Backlog

**字段**：`ID / Priority / Dependency / Deliverable / Acceptance / Learning`。P0–P2 应优先完成；每项都要求测试证据，不允许仅创建文件就关闭。

> **v1.1 修订（2026-10-29）**：N-001～N-406 的编号、优先级、依赖与范围保持不变。新增 `N-R*`（基线收尾与 CI）和 `N-A*`（Agent 研究轨道，不属于 SQL MVP，细化原 `N-X05`）。阶段与进入条件见 [19](19-roadmap.md)。

## P0 · Code OSS 基座

| ID | Priority | Depends | 任务 | 验收/证据 |
|---|---|---|---|---|
| N-001 | P0 | - | Fork Tag 1.142.0、锁 SHA/Node/npm | 版本基线文件 + 命令输出 |
| N-002 | P0 | N-001 | 原生 npm install/watch/Electron 启动 | 原生启动截图/日志，失败记录 |
| N-003 | P0 | N-002 | Audit product.json/默认云服务/版权与市场 | service/asset 清单，风险闭环 |
| N-004 | P0 | N-003 | 独立品牌、DataFolder/URI/CLI | 与 VS Code 并存不互相覆盖 |
| N-005 | P0 | N-002 | Hello Workbench Command/View | Reload 后稳定、Disposables 正常 |
| N-006 | P0 | N-005 | 最小 UI/DI 测试与学习笔记 | 源码调用链 + 回归测试 |
| N-007 | P1 | N-004 | CI Baseline, License/SEC scan | PR 可运行必需验证 |

## P1 · Rust SQL Runtime

> 合同基线：[`nyala/rpc/README.md`](../../../nyala/rpc/README.md) 已把协议 `1.0` 固化为可执行合同（envelope schema、错误码表、一致性样例、`npm run nyala:validate-rpc`）。N-101、N-102、N-110 的验收以该合同为准；实现与合同不一致时先改合同再改代码。

| ID | Priority | Depends | 任务 | 验收/证据 |
|---|---|---|---|---|
| N-101 | P0 | N-001 | Runtime crate + Stdio framing | half-frame/oversize/error 测试 · **In Review**（`feat/p1-rust-runtime`，`rust/crates/nyala-runtime`；证据见 [ADR 0002](../../adr/0002-rust-runtime-workspace.md#证据)） |
| N-102 | P0 | N-101 | Hello/version/error protocol | Major 不匹配拒绝 · **In Review**（同 N-101） |
| N-103 | P0 | N-102 | Electron Sidecar supervisor | 退出/重启/清理测试 |
| N-104 | P0 | N-102 | SQLite Profile/Session connect | connect/close/invalid file 测试 |
| N-105 | P0 | N-104 | SQLite metadata | 表/视图/列/permission/refresh |
| N-106 | P0 | N-104 | SELECT 1 / errors / query states | 终态、耗时、错误测试 |
| N-107 | P0 | N-106 | ResultHandle + FetchPage/TTL/release | 大结果缓存限额与过期测试 |
| N-108 | P0 | N-106 | Cancel/Timeout/Runtime killed | Unknown/Cancelled 区分 |
| N-109 | P0 | N-104 | Readonly DB enforced | 尝试实际修改失败 |
| N-110 | P1 | N-107 | Protocol TS/Rust generated contracts | 合同一致性 CI |

**v1.1 验收补充**（只增加检查项，不改 ID、优先级或依赖）：

- N-101：除半包、超限外，还要覆盖粘包、零长度、畸形 JSON 与帧上限；Runtime crate 独立于上游 `cli/`。
- N-102：major 不匹配拒绝连接，minor 差异按合同的版本协商规则处理；日志只写 stderr。
- N-103：spawn / kill / restart / shutdown、重启 backoff，退出后不留孤儿进程。
- N-108：`cancel_requested` 与 `cancelled` 分开报告；`unknown` 状态不自动重放。
- N-109：DML / DDL / 有副作用的 SQL 由数据库原生只读能力拒绝，不以 SQL 正则作为安全边界。
- N-110：以 `nyala/rpc/v1/*` 为单一事实源，TS 与 Rust 两端互通正向和负向样例。

## P2 · SQL Workbench

| ID | Priority | Depends | 任务 | 验收/证据 |
|---|---|---|---|---|
| N-201 | P0 | N-105,N-005 | Connections Tree | 加载/错误/Refresh/离线 |
| N-202 | P0 | N-106,N-005 | Query EditorInput + Context | 两 Tab 不串 profile/session |
| N-203 | P0 | N-202 | Commands & Keybindings | 当前语句/选区、键位冲突测试 |
| N-204 | P0 | N-107 | Basic Result Panel | NULL/类型/截断/耗时/错误 |
| N-205 | P0 | N-204 | Virtualized Grid + Byte Cache | 100k×20 浏览不全 DOM |
| N-206 | P0 | N-202 | Draft persistence/restore | 断电模拟、无自动重放 |
| N-207 | P0 | N-201..206 | SQLite Desktop E2E | 连接→编辑→执行→结果→重启 |
| N-208 | P1 | N-203 | Connection UI accessibility | 键盘、屏读、缩放/主题 |

## P3 · PG & Language

| ID | Priority | Depends | 任务 | 验收/证据 |
|---|---|---|---|---|
| N-301 | P0 | N-104 | PG Driver TLS/Auth/Metadata | 真 PG 集成测试 |
| N-302 | P0 | N-301 | PG Execute/Cancel/Explain | 长查询 Cancel + Plan 树 |
| N-303 | P0 | N-202 | SQL Extension + LSP | PG Schema/列补全/降级 |
| N-304 | P1 | N-205 | Streamed export | CSV/JSON、权限、内存 |
| N-305 | P1 | N-301..304 | PG Real Workflow E2E | 双 Tab 跨库、错误/断线/只读 |

## P4 · Reliability & Distribution

| ID | Priority | Depends | 任务 | 验收/证据 |
|---|---|---|---|---|
| N-401 | P0 | N-301 | MySQL Preview Driver | 核心类型/元数据/查询/取消能力表 |
| N-402 | P0 | N-108 | Transaction ownership & uncertain state | COMMIT 断线测试 |
| N-403 | P0 | N-206 | Query History/privacy settings | 删除与不保存模式测试 |
| N-404 | P0 | N-004,N-207 | Installer/Update/signing audit | 单平台完整 Install/Uninstall |
| N-405 | P1 | N-404 | Windows/macOS native packaging | CI artifact + smoke |
| N-406 | P1 | N-405 | Upstream bump rehearsal | 冲突/工时/回归报告 |

## 延迟/实验（明确不纳入 MVP）

`N-X01` Tauri Workbench Launch PoC；`N-X02` Node Extension Host in Tauri；`N-X03` 包瘦身实验；`N-X04` SQL Performance Lab；`N-X05` Safe SQL Agent/MCP；`N-X06` Driver SPI。

v1.1 起，`N-X05` 细化为下方 `N-A*` 研究轨道。

## 基线收尾与 CI（v1.1 新增）

| ID | Priority | Depends | 任务 | 验收/证据 |
|---|---|---|---|---|
| N-R01 | P0 | N-005, Code OSS 1.143.0 | 1.143.0 原生 Electron Smoke + Reload/Dispose 自动化 | 启动、View、Extension Host、Webview、Reload 的真实日志；环境不允许则记 BLOCKED |
| N-R02 | P0 | 计费或 Runner | `nyala-ci.yml` 真正执行 | `Product baseline` 与 `Client typecheck and hygiene` Job 有实际 step 和结论 |
| N-R03 | P1 | N-R02 | 复核已停用上游 workflow 的恢复路径 | 普通 PR、上游同步 PR、Release、安全扫描的场景矩阵 |
| N-R04 | P1 | 治理 v1.0 | 维护 `PROGRESS.md` 状态快照 | 反映主线 HEAD 与已合并 PR，不重复登记已存在的 CI 校验 |

## Agent 研究轨道（v1.1 新增，非 SQL MVP）

ADR-0006 继续有效。A0 只做设计与 Fake 测试；A1 起必须等对应的 Runtime/Query Authority 任务完成。见 [27](27-agent-platform.md)～[30](30-agent-security-evaluation.md)。

| ID | 阶段 | Depends | 任务 | 验收/证据 |
|---|---|---|---|---|
| N-A001 | A0 | ADR-0006 | 冻结 Task/Run/Event/Artifact 最小接口 | 版本化设计 + FakeHarness 示例；无生产 IO |
| N-A002 | A0 | N-A001 | 定义 Tool Gateway / Policy / Scope | `taskId`、`connectionScope`、`argumentsHash`、`deadline`、`approvalId` 合同 |
| N-A003 | A0 | N-A001 | Codex 适配方式与版本兼容矩阵 | Codex 协议不直接绑定 Nyala 领域模型 |
| N-A101 | A1 | N-104, N-A003 | CodexRuntimeManager PoC（优先用户手动指定二进制） | 本地启动、版本检测、崩溃隔离；没有 Codex 时 IDE 正常启动 |
| N-A102 | A1 | N-A001, N-A101 | Thread/Turn/Event Bridge + MockHarness | 流式、Interrupt、Resume、Backpressure、未知事件 |
| N-A103 | A1 | N-105, N-A002 | Schema/Index/Explain 只读工具 | 脱敏、限额、审计与拒绝路径测试 |
| N-A201 | A2 | P2, N-A102 | Task-first Workbench View | 任务进度、审批、失败、重启恢复 |
| N-A202 | A2 | N-A201 | Artifact 打开到 SQL Editor / Grid / Plan Viewer | `artifactId` 与连接上下文不串库 |
| N-A301 | A3 | P3, N-A103 | SQL Investigator | 可复查的 Plan 证据，稳定的 Eval 数据集 |
| N-A401 | A4 | N-A301 + 只读隔离 | 有界只读查询策略 | scope、approval、timeout、行数上限、外发控制验证 |
| N-A501 | A5 | N-A202 | Native Harness 对照实验 | 成本、性能、安全、维护权衡报告 |

**显式不做**：SQL MVP 不做通用 Shell Agent、自动执行生产写库、云端 Agent、全库上下文、默认上传数据或 Secret、用 Tauri 替换 Electron、未经用户同意下载 Codex。User Trust、License、Auth、供应链审查完成前，Codex 自动分发只是设计候选。

## 看板工作流

`Backlog -> Ready (AC 已写) -> In Progress -> In Review -> Verified -> Done`，Bug 再开 `Regression`。每一张 Done 卡至少链接 PR/提交、测试输出/截图、相关设计或 ADR 更新。
