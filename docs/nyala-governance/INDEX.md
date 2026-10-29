# Nyala Governance · 规范索引

**定位：** 在不破坏 Code OSS 上游可合并性的前提下，补齐 Nyala 自身的工程流程、质量记录、领域安全和 Agent 协作约束。

## 单一事实源与冲突处理

1. 安全/许可证/实际运行行为优先于任何文档宣称；存在冲突时必须停下并记录。
2. `docs/nyala-kickoff/docs/26-branching-and-upstream-sync.md` 是 Git/上游规则权威；本目录 `01`、`02` 为操作细化，不能悄悄修改合并策略。
3. `docs/nyala-kickoff/docs/25-engineering-rules.md` 是工程架构权威；本目录 `03`、`04`、`06`～`10` 为细化。
4. `docs/nyala-kickoff/docs/22-quality-gates.md` 是现有 DoD 权威；本目录 `05`、`11` 补足测试矩阵与证据格式。
5. `.github/copilot-instructions.md` 与 `.github/instructions/*.instructions.md` 是 Code OSS 代码风格/可访问性/生命周期的上游约束；本目录不重复排版/通用语法约定。
6. `nyala/rpc/v1/*` 为 RPC v1 合同；任何新增错误/方法先变更合同与 conformance，不由本目录另创 Schema。
7. 新领域约束若和既有权威不一致，先开 ADR 或治理 PR，同步修正；**不按“新文档覆盖旧文档”处理**。

## 内容

| 文档 | 主题 |
|---|---|
| [01](01-git-history-and-pr.md) | PR、提交粒度、Merge/Squash、第一父历史 |
| [02](02-upstream-compatibility.md) | Code OSS Tag 同步、冲突、Patch Ledger |
| [03](03-architecture-ownership.md) | 目录所有权、架构边界、最小补丁 |
| [04](04-engineering-style.md) | Workbench/TS、Rust、协议质量要求 |
| [05](05-ci-evidence.md) | CI、跳过/阻断、证据等级、失败分类 |
| [06](06-sql-runtime-safety.md) | 数据安全、事务、只读、连接身份 |
| [07](07-agent-harness.md) | Agent 工具、审批、上下文与审计 |
| [08](08-security-privacy.md) | Credential、隐私、供应链、权限 |
| [09](09-ui-ux-performance.md) | 主题、可访问性、Grid、性能 |
| [10](10-testing-matrix.md) | 单测、集成、桌面、升级回归 |
| [11](11-release-versioning.md) | 版本、平台、发行、回滚 |
| [12](12-documentation-adr.md) | 文档、ADR、进度、决策与例外 |
| [13](13-dependency-and-workflow-governance.md) | Dependabot / Workflow 降噪 |
| [14](14-logging-incidents.md) | 日志、证据、故障分级、RCA |
| [15](15-dev-environments.md) | 环境、构建、实验与学习路线 |
| [16](16-contributor-guide.md) | 新人、Issue、PR、Definition of Ready |

## 最小实践

- 日常：一条垂直任务、一个短期分支、一个 PR、记录运行过的测试。
- 上游：稳定 Tag、Merge 保留祖先、Patch Ledger、回归记录。
- 数据库：受控 Runtime，明确 Connection/Session/Transaction/Execution/Result ID；不容许串库、无审批写入。
- Agent：工具权限放在 Harness 外；不将聊天当成权限证明。
- 发布：真实安装/启动/卸载/签名与版权审计，不以 TS 编译作为发行完成。
