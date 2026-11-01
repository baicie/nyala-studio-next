# Nyala Studio

**Code OSS-based, SQL-first, local-first desktop IDE.**

Nyala 是一个开源学习型 SQL IDE 项目：沿用 VS Code Workbench 原生能力，构建数据库连接浏览器、SQL 编辑器、查询结果工作台和数据库语言服务；数据库操作在受控 Rust Runtime 中执行。项目目标首先是自己日常愿意用，以及理解 IDE 架构，不把商业化作为首要 KPI。

## 当前阶段

**Bootstrap、Windows Reload/Dispose 回归与 Rust SQLite Profile/Session（N-104，PR #33）已进入主线；SQL 查询与 UI 闭环尚未完成。** Runtime Supervisor（N-103，PR #35，`24c3cc7aa23`）与 Agent Host / 拼写词典出站修复（PR #34，`2b73f20285c`）均已合入主线。构建与平台证据见 [bootstrap 记录](docs/04-code-oss-bootstrap.md)和 [进度快照](PROGRESS.md)；本文档不代表跨平台发行通过。

- 基座：Code OSS 固定 release tag（初始候选 `1.142.0`）。
- 主线运行时：Electron + Code OSS Extension Host。
- SQL Engine：Rust 独立进程（Sidecar），以版本化 RPC 通信。
- 功能切片：先 SQLite 完成完整执行闭环，再 PostgreSQL，再 MySQL。
- 扩展：VS Code Extension API 优先；深度 Workbench 界面通过内置 Contribution。
- 实验：Tauri、模块裁剪、AI Agent 都属于后续独立轨道。
- 上游当前同步到 Code OSS `1.143.0`；协议 v1.0 可执行合同在 [`nyala/rpc/`](../../nyala/rpc/README.md)，Rust Runtime 已有 stdio 分帧、hello/health（N-101/N-102）及 SQLite 连接/会话（N-104），尚无查询执行与结果分页。
- Design v1.1 增加了可选 Agent Workspace 的远期设计（[27](docs/27-agent-platform.md)–[31](docs/31-sql-workspace-product.md)），不改变 SQL-first 主线和 MVP 范围。

当前开发版本：`0.0.1-dev.0`。上游固定基线和变更边界见 [`nyala/upstream-base.json`](../../nyala/upstream-base.json)、[patch ledger](../../nyala/patch-ledger.md) 与 [upstream compatibility report](../../nyala/upstream-compatibility.md)。

## 产品 MVP

无需打开文件夹即可：新建本地 SQLite 连接 → 浏览表/列 → SQL 专属编辑器 → 执行当前语句 → 显示结果、错误、耗时 → 取消/超时 → 保存草稿与历史 → 重新启动后恢复。

## 快速入门

先看 `START-HERE.md`，再看 `docs/04-code-oss-bootstrap.md` 和 [分支模型与上游同步](docs/26-branching-and-upstream-sync.md)。Fork 应保留 Code OSS 原始许可与版权通知，品牌身份独立；不要把“更小安装包”作为第一个里程碑。

## 主要模块（规划）

`Nyala Workbench Contribution`、`SQL Application Services`、`Rust SQL Runtime`、`SQL Language Extension/LSP`、`Database Driver Adapters`、`Result Grid`。

## 设计文档

见 `docs/00-index.md`。
