# 文档总索引与决策状态

| 编号 | 文档 | 决策/用途 |
|---|---|---|
| 01 | [项目约章](01-charter.md) | 为什么做、Non-goals、约束 |
| 02 | [产品与用户故事](02-product-spec.md) | SQL-first UX 和版本能力 |
| 03 | [系统架构](03-architecture.md) | 进程、层次、服务依赖 |
| 04 | [Fork 与首次启动](04-code-oss-bootstrap.md) | 1.142.0 构建、身份替换 |
| 05 | [Workbench 集成](05-workbench-integration.md) | DI、Contribution、Editor/Views |
| 06 | [UI/UX 规范](06-ui-ux.md) | 布局、信息架构、交互 |
| 07 | [SQL Runtime](07-sql-runtime.md) | Domain、State、Executor |
| 08 | [IPC 合同](08-ipc-contract.md) | Framing、RPC、错误、背压 |
| 09 | [驱动与元数据](09-drivers-metadata.md) | SQLite/PG/MySQL |
| 10 | [SQL 编辑器与 LSP](10-editor-language.md) | 编辑、补全、诊断 |
| 11 | [结果表格](11-result-grid.md) | Grid、大结果与类型 |
| 12 | [安全与信任](12-security.md) | 密钥、只读、权限、日志 |
| 13 | [扩展策略](13-extensions.md) | VS Code API 和 Nyala SPI |
| 14 | [存储与配置](14-storage.md) | Profile、History、恢复、迁移 |
| 15 | [测试与基准](15-testing-performance.md) | CI、E2E、性能、故障注入 |
| 16 | [上游同步与瘦身](16-upstream-trimming.md) | Patch budget、升级策略 |
| 17 | [发行与合规](17-release-compliance.md) | 品牌、签名、市场、许可证 |
| 18 | [Tauri/AI 研究](18-experiments.md) | 实验验收、Agent 约束 |
| 19 | [路线图](19-roadmap.md) | 版本、阶段、Exit Criteria |
| 20 | [任务清单](20-backlog.md) | 任务依赖、验收、优先级 |
| 21 | [学习地图](21-learning-path.md) | 源码、练习与产出 |
| 22 | [质量门禁](22-quality-gates.md) | Definition of Done、PR |
| 23 | [风险清单](23-risks.md) | 风险矩阵与触发条件 |
| 24 | [维护与文档治理](24-maintainer-playbook.md) | 升级、Bug、发布例行操作 |
| 25 | [架构边界与编码规约](25-engineering-rules.md) | 跨层依赖、命名、测试 |
| ADR | [ADR 目录](adr/README.md) | 关键决策与变更历史 |

## 推荐维护流程

重大架构决策先写 ADR → 更新系统设计与 Backlog → 代码改动 → 自动化测试 → 回写真实验证结果。**文档中的预计时间、性能指标不是项目当前事实。**
