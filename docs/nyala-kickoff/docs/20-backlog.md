# 20 · 可直接建 Issue 的任务 Backlog

**字段**：`ID / Priority / Dependency / Deliverable / Acceptance / Learning`。P0–P2 应优先完成；每项都要求测试证据，不允许仅创建文件就关闭。

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
| N-101 | P0 | N-001 | Runtime crate + Stdio framing | half-frame/oversize/error 测试 |
| N-102 | P0 | N-101 | Hello/version/error protocol | Major 不匹配拒绝 |
| N-103 | P0 | N-102 | Electron Sidecar supervisor | 退出/重启/清理测试 |
| N-104 | P0 | N-102 | SQLite Profile/Session connect | connect/close/invalid file 测试 |
| N-105 | P0 | N-104 | SQLite metadata | 表/视图/列/permission/refresh |
| N-106 | P0 | N-104 | SELECT 1 / errors / query states | 终态、耗时、错误测试 |
| N-107 | P0 | N-106 | ResultHandle + FetchPage/TTL/release | 大结果缓存限额与过期测试 |
| N-108 | P0 | N-106 | Cancel/Timeout/Runtime killed | Unknown/Cancelled 区分 |
| N-109 | P0 | N-104 | Readonly DB enforced | 尝试实际修改失败 |
| N-110 | P1 | N-107 | Protocol TS/Rust generated contracts | 合同一致性 CI |

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

## 看板工作流

`Backlog -> Ready (AC 已写) -> In Progress -> In Review -> Verified -> Done`，Bug 再开 `Regression`。每一张 Done 卡至少链接 PR/提交、测试输出/截图、相关设计或 ADR 更新。
