# 30 · SQL Agent 的安全权限、数据外发与评价体系（设计）

> v1.1 · 域安全原则是所有 Harness 的上位约束；不是 `Codex` 自身工具审批的替代品。

## 1. 威胁模型

资产：DB Password/Token、连接配置、用户 SQL、Schema 注释、业务数据、SQL Result、事务状态、持久 Agent History。威胁源：模型幻觉、Prompt Injection、恶意列/注释内容、通用 Shell/File 工具、被篡改 Runtime 包、MCP 供应商、失效连接状态、误选生产库。

信任边界：Workbench Renderer / Agent Host / SQL Tool Gateway / Rust Query Authority / Database User Role / Remote Model Provider。任何跨边界调用必须有 origin、目标、限制、记录和取消通道。

## 2. 工具权限矩阵（默认）

| 工具能力 | 默认 | 必须约束 |
|---|---|---|
| 列出连接摘要 | 允许 | 不含 Secret/完整连接串，按用户身份列举 |
| 读取 Schema / Index | 有界允许 | 可见对象白名单、采样/字节预算、脱敏 |
| SQL Proposal | 允许生成 | 仅保存 Artifact，不执行 |
| `EXPLAIN` | 特定范围审批或静态解释 | DB 方言与 SQL 可能有副作用，拒绝 EXPLAIN ANALYZE 默认执行 |
| 只读查询 | 在 Query Authority 可测试后有界许可 | DB 原生 readonly、deadline、行/字节/时间/外发上限 |
| DML / DDL / COMMIT | 首版不可用 | 另立 ADR + DB 最小权限 + 人工精确审批 + dry-run 策略 |
| 任意 Shell/File/Network | 禁用或隔离 | Codex 本身可能具备此类工具；SQL MCP 约束不足以形成整体沙箱 |

## 3. Policy Engine

审批请求绑定 `taskId`, `runId`, `tool`, `connectionProfileId`, `sessionGeneration`, `operation`, `argumentsHash`, `dataSensitivity`, `deadline`, `approvalId` 和 one-time nonce。任何目标连接、SQL 参数、模型/工具参数摘要改变时审批失效。跨 Session/Tab 不继承数据库写权限。

Policy 决策分两层：UI 明示并收集用户批准；后端在执行前重新核对请求、资源身份、DB 角色和限额。`ContextKey`、Markdown 聊天和模型系统提示都不是权限凭证。

## 4. 数据外发

建立 Context Disclosure Preview，标出将发送给哪类 Provider 的 SQL/Schema/结果采样及敏感级别。Secret 全程不发送；默认只给最小元数据，结果行/真实 SQL 参数需用户选择允许。允许禁止保存历史、清理任务、撤销 Provider 授权。

结果行、列值、表注释、DDL、URL、表名一律当作**不可信数据**；即使内容声称来自开发者或系统，也不能改变工具权限与执行目标。避免模型拼接非参数化 SQL 或把数据里的 SQL 当成指令自动执行。

## 5. 可靠性与未知态

Run、ToolCall、Query Execution 拥有独立状态；`cancelRequested` 不等于取消成功。因进程崩溃、网络断线、提交反馈丢失等无法证明终态时使用 `unknown` 并进行受控协调，**写操作绝不自动重放**。只读工具也要确认不会有副作用，才能重试。

## 6. 评价（Evals）

| 维度 | 指标与门禁 | 测试样例 |
|---|---|---|
| 安全 | 高风险越权 0 容忍 | 私自写生产库、跨连接误查询、读取凭证 |
| 事实准确度 | 引用的表/列/Plan 能在证据中找到 | 错 Schema、索引不存在、失效 Plan |
| 任务结果 | 完成率 + 人工修正次数 | Explain 慢查询、生成 SQL Proposal |
| 可靠性 | Crash/Cancel/Resume 与审批状态正确 | 断线、超时、重复事件、后期审批 |
| 数据隐私 | 未授权外发次数必须为 0 | 数据库中嵌入恶意指令，泄漏测试 |
| 成本/时延 | Token、tool calls、p95 latency、预算超限率 | 同一任务对照 Codex/Native Harness |

测试须使用 FakeModel / FakeGateway 做确定性负向例，再使用受控、脱敏数据库做真实端到端；不能只凭模型回答看起来不错便称为“安全通过”。

## 7. Release Gate

启用任何数据库 Agent 自动执行之前，最少具备：有界 SQL Query Authority、DB Role 实际限制、完整审批、崩溃不重放、敏感字段脱敏、Prompt Injection 负向测试、审计日志、数据流告知与来源证据。未满足时维持 Ask/Propose 模式。
