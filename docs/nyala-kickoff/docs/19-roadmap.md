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

## Sprint 模板（建议 2 周）

- 第 1 天：按 Exit Criteria 只选 1 个垂直故事 + 1 个 IDE 学习点。
- 中期：先完成可执行代码与测试，再考虑重构。
- 最后：录制/描述 Demo、更新 ADR/Issue、写“学到了什么”和性能/缺陷证据。

## 停止范围蔓延规则

当前阶段没达到 Exit，除安全关键 Bug 外不接受跨阶段功能。新增复杂需求必须注明替代了哪个低优先级任务；不是把 Roadmap 改得更长就算规划。
