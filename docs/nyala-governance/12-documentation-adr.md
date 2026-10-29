# 12 · 文档、ADR、状态与单一事实源

## 更新触发

- 新模块/接口：更新架构设计、合同与测试矩阵。
- 改动跨进程协议/数据库安全/上游 Core：新 ADR 或修订既有 ADR，注明取舍、兼容性与退出策略。
- Code OSS 同步：更新 upstream-base、patch-ledger、upstream-compatibility、PROGRESS，引用同步 PR。
- 完成阶段：先给出测试证据再勾 Roadmap；“设计完成”“代码实现”“已在本机通过”“多平台交付”分别标识。

## ADR 结构

`Status Proposed|Accepted|Superseded`、Date、Context、Decision、Alternatives、Consequences、Migration、Compatibility/Upstream Cost、Security/Performance、Validation、Links。更改已 Accepted 决策时必须做补充 ADR，而不是直接删除历史。

## Progress 与证据

- `docs/nyala-kickoff/PROGRESS.md` 是快照，不是比 Git 更权威的状态。HEAD/PR/日期不一致时更新快照，并注明旧信息。
- 矛盾顺序：Git HEAD/真实测试结果优先；领域合同次之；权威架构/ADR；最后是临时总结与 Agent 会话记忆。
- 不手动复制整套上游 README/CONTRIBUTING 形成重复；可以在 Nyala 文档做简短指针。

## 文档质量

- 相对链接、命令和路径可在实际 Repo 验证；不要将占位名 `<tag>` 复制为可运行完整指令。
- 禁止包含真实连接字符串、客户名/业务数据/Token；演示数据使用虚拟数据库和脱敏样例。
- 编写时将规范的 MUST、SHOULD、MAY 与阶段计划区分；实验性的目标明确写“建议/可选”。
