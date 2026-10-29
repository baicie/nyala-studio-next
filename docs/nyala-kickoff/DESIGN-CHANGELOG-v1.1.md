# Nyala 设计修订日志 · v1.0 → v1.1

| 类别 | 文件 | 变更要点 | 对现有仓库的落位策略 |
|---|---|---|---|
| 基线与阅读 | `START-HERE.md`, `PROJECT-README.md`, `docs/00-index.md` | 双基线、状态边界、Agent 入口 | RECONCILE：不覆盖 |
| 关键架构 | `docs/03-architecture.md` | 明确 Agent Platform 可选、SQL Query Authority 为唯一执行入口 | RECONCILE |
| P0 历史 | `docs/04-code-oss-bootstrap.md` | 记录 1.143.0 同步及未完成烟测 | RECONCILE，保留历史基线 |
| SQL/IPC | `docs/07-sql-runtime.md`, `docs/08-ipc-contract.md` | 优先遵从仓库的 `nyala/rpc/v1`，定义侧车非闭环现状 | RECONCILE |
| UX | `docs/06-ui-ux.md` | 双 Workspace，SQL-first，非 Chat-only | RECONCILE |
| 实验 | `docs/18-experiments.md` | Agent A0/A1 实验门槛，Codex 可选进程 | RECONCILE |
| 路线 | `docs/19-roadmap.md`, `docs/20-backlog.md` | 状态、真实 Exit Criteria、A0–A5 扩展任务 | RECONCILE |
| 质量 | `docs/22-quality-gates.md` | 证据等级 / CI 账单 / smoke | RECONCILE |
| 新专题 | `docs/27`–`31` | Agent Platform、Task Workspace、Runtime Manager、Policy/Eval、SQL 交互 | ADD（若不存在） |
| 新 ADR | `docs/adr/0007`, `0008` | 产品交互和 Harness 结构；不替代 0006 | ADD；遇已有编号必须换未占号 |
| 索引 | `docs/adr/README.md` | 新 ADR 索引 | RECONCILE |
| 管理 | `docs/26-branching-and-upstream-sync.md` | 引用仓库既有权威规范 | REFERENCE ONLY，严禁覆盖 |
| 遗留 | `reference/legacy-rpc-examples/*`, `reference/AGENTS-v1.0-legacy-template.md` | 保留 v1.0 历史，防误用 | NEVER INSTALL |

**旧包缺失 26 号文档**，而当前仓库已经拥有详细的 26 号分支与同步规则。因此本快照的 26 号仅提供指针，不替代仓库文件。原 ZIP 的 Agent 指令亦已转存 reference，避免覆盖最新根 `AGENTS.md`。
