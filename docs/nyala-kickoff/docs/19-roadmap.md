# 19 · 详细路线图与阶段出口条件

> 这是单人开发 + AI 辅助的规划区间，**不是进度承诺**。推荐先达成可运行的垂直闭环，短迭代、不多线并发。预计 P0–P4 约 12–24 有效周（取决于工作之外实际时间），每阶段按出口条件而非日期完成。

## 路线摘要

| 阶段 | 版本/主题 | 主要成果 | 建议投入 | Exit Criteria |
|---|---|---|---|---|
| P0 | 0.0 · OSS Bootstrap | 官方基线启动、品牌身份、Hello Contribution | 1–3 周 | Electron 可复现启动 + UI 命令 |
| P1 | 0.1-alpha · SQLite Runtime | Rust Sidecar、RPC、SQLite 查询/元数据 | 2–4 周 | headless Rust SQL 端到端测试 |
| P2 | 0.1-beta · SQL Workbench | Connections、Query Editor、Result Grid、Draft | 3–6 周 | 完整 SQLite UI 任务闭环 |
| P3 | 0.2 · PostgreSQL & Language | PG、LSP 补全、Explain、导出 | 3–5 周 | PG 真实数据库稳定闭环 |
| P4 | 0.3 · Stability | MySQL Preview、事务、断线恢复、发行 | 3–6 周 | Preview 可供自己日常使用 |
| P5 | 0.4 · Deepening | SQL 性能实验 / 最小 Agent | 按需 | 可复查的实验闭环 |
| P6 | 1.0 候选 | 文档、发行、上游升级测试 | 由风险决定 | 上游升级 + 多 OS 质量门禁 |
| EX | Tauri/瘦身实验 | 独立 PR/报告，不强制合入 | 独立时间盒 | 定量报告与 ADR |

## v1.1 阶段状态（2026-10-29 快照）

> 状态以 Git/PR/真实测试为准，本表只是快照；证据来源为 [PROGRESS](../PROGRESS.md)、[`nyala/upstream-compatibility.md`](../../../nyala/upstream-compatibility.md) 和 PR #8/#11/#14–#18。本设计修订没有重新运行编译、Electron 冒烟或 SQL 执行。

| 阶段 | 当前状态 | 是否阻塞下一阶段 |
|---|---|---|
| P0 | 基本完成：1.142.0 macOS Electron Smoke 通过；1.143.0 只有 compile/typecheck/hygiene 证据，Electron Smoke 与 Reload/Dispose 自动化仍缺 | 核心 smoke 闭环必须补，不能当发行通过 |
| P1 | RPC v1.0 可执行合同已合并（`nyala/rpc/v1`）；Rust Sidecar 未实现 | P2 正式接入之前至少要有真实 RPC 和查询结果 |
| P2–P4、P6 | 未开始 | 按各自 Exit |
| P5 | 仅有 Agent 设计研究（[27](27-agent-platform.md)–[30](30-agent-security-evaluation.md)），无实现 | **不得阻塞 P1–P4** |
| EX | 不纳入主线 | 独立 ADR，受控时间盒 |

### P0 收尾（N-R01～N-R02）

- **P0-R1**：以 Code OSS 1.143.0 为基线运行真实 Electron 开发态启动，验证 Command Palette、Connections View、StatusBar、Split Editor、Extension Host、最小 Webview，记录平台/Node/npm/commit/日志。
- **P0-R2**：Nyala View 的 Reload Window / Dispose 自动化回归（重复注册、泄漏、状态恢复、错误态）；环境不允许时标 BLOCKED 并保留门禁，不用旧版本 smoke 代替。
- **P0-R3**：`nyala-ci.yml` 中的 `nyala:validate-product`、`nyala:validate-rpc` 与 TypeScript 基线需要真实 runner 运行；计费或额度失败记 BLOCKED，在此之前依靠人工 PR + 本地证据。

## P0（0.0）拆分

**P0.1** 固定 `microsoft/vscode` 1.142.0 Tag / Node 24.18.0 / npm；验证原生 Code OSS 启动（**真实构建之前不能宣称成功**）。

**P0.2** 独立 product.json 品牌、用户数据目录、Scheme、CLI/图标策略；外部云服务/默认 Copilot 审计。

**P0.3** Hello Contribution、Command Palette、View、Status Item；最小改动上游入口；写源码学习笔记。

**P0.4** 开启 lint/build/test P0 质量门禁、原始功能回归、patch ledger；记录第一版包尺寸基准（若已能打包）。

Exit：空工作区 Electron 启动、原生编辑器/命令可用、Nyala 命令可用、产品身份基本隔离。

## P1（0.1-alpha）拆分

**P1.1** Rust crate + Supervisor + stdio Length-prefixed RPC；hello/version + health + error。

**P1.2** SQLite ConnectionProfile/Session，open/test/close，凭证与路径安全（SQLite 不涉及密码）。

**P1.3** SQLite metadata + query execute SELECT1 + invalid SQL + read-only/DML guard。

**P1.4** ResultHandle/fetchPage/release、cancel/timeout、异常子进程重启与未知执行状态。

Exit：不通过 UI 也能跑集成测试；Rust 内核可复用，RPC 编解码/生命周期通过测试。

v1.1 细化：P1.1 的 Rust crate 独立于上游 `cli/`，帧格式、方法与错误码以 [`nyala/rpc/README.md`](../../../nyala/rpc/README.md) 为准，stdout 只承载协议帧。Exit 要求一条可重复的 headless E2E：启动 sidecar → 握手 → 打开临时 SQLite → `SELECT 1` → 分页 → 释放 → 关闭 → 进程退出；并覆盖半包/粘包、帧超限、协议 major 不兼容、进程被杀与只读拒绝的负向测试。没有真实运行证据不能关闭 P1。

## P2（0.1-beta）拆分

**P2.1** SQL Connections Tree 与加载/错误/Refresh 状态。

**P2.2** Query EditorInput/Pane、Context/Command/Keybindings、无文件 Draft/Restore。

**P2.3** Result Grid：第一版列/行、NULL/错误/状态，分页；随后虚拟行列。

**P2.4** UI 与 RPC 连通、E2E：SQLite Query 完整闭环、分屏独立连接、安全测试。

Exit：本人可以在 Nyala 中完成真实 SQLite 查询，重启后草稿恢复，离线可用。

## P3（0.2）拆分

**P3.1** PG TLS/Auth、metadata、Cancel/Timeout、Read-only。

**P3.2** SQL 语言 Extension + Metadata Completion、最小格式化与 Diagnostics。

**P3.3** PG Explain JSON、Plan Tree UI，`EXPLAIN ANALYZE` 风险审批。

**P3.4** 导出、性能基准、功能文档。

Exit：PG 多窗口/多 Tab、不串连接；典型真实 SQL 可编辑执行和对比结果。

## P4（0.3）拆分

**P4.1** MySQL Preview（按 Capability 标注）与 Connection SSL/Metadata。

**P4.2** 事务绑定、Query History、断线恢复、运行中退出确认。

**P4.3** Windows/macOS 签名/安装/更新流程（若尚无证书，Preview 使用明确未签名测试渠道并标注限制）。

Exit：错误/连接损坏/关闭/恢复行为明确，起码一个平台可持续日用。

## P5–P6 与实验

P5 可在 SQL Lab 与最小 Agent 之间二选一，先证明一个真实工作流，不并发搞两条。P6 不能只看版本号：必须做真实上游 Tag 升级演练、安全扫描、许可审查与 E2E。

## v1.1 Agent 轨道 A0–A5（设计提案，与 P 系列不同周期）

[ADR-0006](adr/0006-no-default-ai.md) 继续有效：Agent 不进入 SQL MVP 的交付门槛。下表只规定进入条件，相关 ADR [0007](adr/0007-sql-first-task-first-workspace.md)、[0008](adr/0008-optional-codex-app-server-adapter.md) 仍为 Proposed。

| 轨道 | 进入条件 | 范围 | Exit |
|---|---|---|---|
| A0 Domain Contracts | 可与 P1 并行少量设计 | Task/Run/Artifact、Harness Adapter、Tool Gateway 与审批协议草案；Mock 测试草案 | ADR 评审通过，不改变 SQL 主线优先级 |
| A1 Read-only PoC | P1 Runtime 稳定 + Connection Scope 可用 | Fake Harness + 可选 Codex app-server；只读 metadata/静态 Explain；流式任务与取消 | Harness 可插拔，没有 Codex 二进制时 IDE 正常启动 |
| A2 Task Workspace | A1 事件语义稳定，P2 SQL UI 可用 | Task Timeline / Artifact / Approval View | SQL Proposal 可作为 EditorInput 打开 |
| A3 SQL Investigator | P3 PG Explain/Schema 可用 | 慢查询、索引分析与 SQL 草案 | 可复查证据，准确率/风险率可量化 |
| A4 Safe Executor | Policy + DB 权限 + 审批经实测 | 有界只读 SQL 执行；写操作另立 ADR | 越权/注入/未知状态负向测试通过 |
| A5 Harness Research | A2 稳定 | Native Harness 与 Codex 对照实验 | 有对照数据，不以重写 Codex 为目标 |

范围门：A0 可以现在写设计；A1 及之后不抢占 N-101～N-207 的主线。

## Sprint 模板（建议 2 周）

- 第 1 天：按 Exit Criteria 只选 1 个垂直故事 + 1 个 IDE 学习点。
- 中期：先完成可执行代码与测试，再考虑重构。
- 最后：录制/描述 Demo、更新 ADR/Issue、写“学到了什么”和性能/缺陷证据。

## 停止范围蔓延规则

当前阶段没达到 Exit，除安全关键 Bug 外不接受跨阶段功能。新增复杂需求必须注明替代了哪个低优先级任务；不是把 Roadmap 改得更长就算规划。
