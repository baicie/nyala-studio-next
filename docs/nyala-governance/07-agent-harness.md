# 07 · Agent Harness / Codex app-server / MCP 规范

> Agent 非 SQL MVP 的硬依赖。保留 `docs/nyala-kickoff/docs/adr/0006-no-default-ai.md` 原决定，只有真实 Query Authority 和审批机制可测试后再允许有副作用工具。

## 架构

`Nyala Agent Workspace` → `INyalaHarness Adapter` → Codex app-server（可选）/ Native Harness（实验）；Tool Gateway → Policy/Approval → Rust Query Authority → DB。

- Codex App Server 是**外部进程集成**，不能把其 Thread/Turn/Item 直接当作永远不变的 Nyala Domain Model。
- Agent Runtime **可选、可版本固定、可验证安装、可回退**；没有 Codex 二进制时 SQL IDE 必须正常启动。
- App Server 版本、认证/许可、下载来源/哈希/签名、协议兼容、平台包体影响，必须独立验证；不要写“自动安装已完成”除非代码存在。
- Harness 自带 Shell/File/MCP 工具权限与 Nyala DB Tool 权限**互不等价**。数据库最终授权在 Nyala Tool Gateway 和 DB Role。

## Agent 工具开发

- 最小工具：list connections（脱敏）、list schema、describe table、get indexes、propose SQL、静态 explain、保存草案。
- 数据读取需要任务范围/连接范围/行数/时间/字段脱敏/外发策略；写操作默认不开启。
- ToolCall 必须绑定 `taskId`, `connectionScope`, `operation`, `argumentsHash`, `risk`, `approvalId`, `deadline`；审批过期或参数变化需要重批。
- schema comment、表名、查询结果均视为**不可信输入**，不能覆盖开发者规则或权限。
- 模型与 Agent 输出不能直接成为数据库执行命令，先转换为正式 SQL Artifact，供用户审阅。

## Task/Artifact 模型

`Task`（工作目标）≠ `Session`（会话）≠ `Run`（一轮执行）≠ `ToolCall` ≠ `Approval` ≠ `Artifact`。SQL 草案进入原生 Editor、结果进入 Grid、计划进入 Plan Viewer，不仅渲染 Markdown。

## 失败、隐私与可测试性

- Crash/Cancel/Timeout/网络中断：保留事件序号、真实工具执行状态；不要自动重放未知结果的写操作。
- 远端 LLM 前默认不发送 Schema 数据、SQL 参数、结果行；用户授权应标明目的与范围。
- 提供 FakeModel/FakeGateway 的确定性 E2E，覆盖拒绝审批、prompt injection、数据泄露、跨库操作、上下文压缩、重启恢复。
