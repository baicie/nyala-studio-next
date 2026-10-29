# Nyala Studio 2.0 · 从这里开始

> 文档版本：v1.0 · 2026-10-19 · **设计与 P0 Bootstrap 记录**
> 基线：`microsoft/vscode` tag `1.142.0`，SHA `d956e8a6ac5d904486557eea07e1d6bd62a4d36f`，`.nvmrc` = `24.18.0`；当前开发版本为 `0.0.1-dev.0`。
> 当前进度、未完成项与跨机器恢复步骤：[PROGRESS.md](PROGRESS.md)。
> 工程治理规范（提交与 PR、上游同步、证据与门禁、领域安全）：[docs/nyala-governance/INDEX.md](../nyala-governance/INDEX.md)。

## 一句话目标

从 **Code OSS 原生 Electron Workbench** 出发，构建自己愿意日常使用的、SQL-first 的开源桌面 IDE；开发过程系统学习 VS Code Workbench、Extension Host、LSP、桌面多进程和 Rust 数据库执行引擎。Tauri 与极限瘦身独立实验，不拖累正式主线。

## 先读这 6 份

1. [项目约章与范围](docs/01-charter.md)：为什么做、什么不做、版本边界。
2. [架构总览](docs/03-architecture.md)：进程、服务、调用方向与隔离层。
3. [Fork 与首次启动](docs/04-code-oss-bootstrap.md)：真实命令和验证记录。
4. [SQL Runtime 与协议](docs/07-sql-runtime.md)、[RPC](docs/08-ipc-contract.md)：业务底座。
5. [路线图](docs/19-roadmap.md)及[任务拆分](docs/20-backlog.md)：每阶段可验收。
6. [IDE 源码学习地图](docs/21-learning-path.md)：每做一块，理解一块。
7. [分支模型与上游同步](docs/26-branching-and-upstream-sync.md)：日常开发、PR 和 Code OSS Release Tag 同步规则。

## 第一周不要干什么

不要移植 SideX，不要删除 Workbench 模块，不要同时上 SQLite/MySQL/PostgreSQL，不要立刻设计 Agent，不要把 Rust/Tauri 作为 VS Code 能否启动的前置条件，也不要假定 Visual Studio Marketplace 可直接接入。

## 第一周明确做什么

- Fork `microsoft/vscode`；从稳定 Tag `1.142.0` 建立产品分支，完整记录 Tag/SHA/Node/npm/Electron 版本。
- 在 macOS 和 Windows 上至少完成目标主开发平台原生启动（如果只有一种环境，另一种标记为 pending）。
- 验证 VS Code 原始版的 compile/watch、Extension Host、Webview、Editor Split 能力，再修改品牌。
- 变更产品身份（用户数据目录、协议、应用 ID），审计默认云端服务、内置扩展与更新源。
- 做一个最小 `Nyala: Hello Workbench` Command + View Contribution，不访问数据库。
- 记录首次构建日志与 2–3 个源码入口：DI 注册、Contribution 注册、Workbench 启动。
- 将 `P0` 验收表填成真实结果，不允许用预期代替实测。

## 推荐阅读顺序

`01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14 → 15 → 19 → 20 → 21 → 22`，其余为长期治理文档。

## 如何使用 ZIP

本压缩包是**可迁入新 Fork 的设计与流程文件**，但不是 Code OSS 的完整源码。它不会修改 GitHub 上的任何仓库。

- 先在 GitHub Fork 官方 `microsoft/vscode`，或新建保留 upstream Git 历史的产品仓库。
- 建议把本包 `docs/` 拷贝到 Fork 内 `docs/nyala/`；复制前调整相对 Markdown 链接（或者将整包作为 `docs/nyala-kickoff/` 保持链接不变）。
- `AGENTS.md` 与 `PROJECT-README.md` 是**供合并/适配的模板**，不要不经审查覆盖上游仓库现有同名文件。
- `examples/` 是合同示例，不能直接理解为已实现服务；`templates/` 用于 Issue/PR/实验记录。

## P0 成功定义

能够在固定版本的 Code OSS/Electron 中独立启动 Nyala 开发实例；存在一条最小的 Nyala Workbench Command；默认产品身份/敏感服务已列清单；干净代码能够重现开发启动；**此时不要求有数据库 UI**。当前已满足 macOS 开发态条件；Windows/Linux、签名发行和 SQL UI 仍是后续阶段。

## 文档权威度

`docs/03-architecture.md` 是工程边界的权威文档；`docs/19-roadmap.md` 是阶段验收权威；变更须新增/更新 ADR；`AGENTS.md` 为 AI Coding Agent 的约束，若与上游强制规约冲突，遵循更严格的规则并登记原因。
