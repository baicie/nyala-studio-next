# Agent Task Safety Gate

- [ ] Agent Harness、模型 Provider、工具权限与 Nyala Query Authority 分开。
- [ ] 当前任务连接范围明确，Agent 默认不能访问所有数据库。
- [ ] 每个工具调用绑定参数摘要、审批、过期时间、风险等级。
- [ ] Schema/SQL 注释/结果行视为不可信模型输入，具备注入用例。
- [ ] 数据不默认发往远端模型；明确模型/传输目的/脱敏策略。
- [ ] 写入与 `EXPLAIN ANALYZE` 实际执行等危险操作不开放默认自动执行。
- [ ] Shell/FS/MCP 总权限与数据库权限相互独立；测试越权拒绝。
- [ ] Cancel/Crash/Retry 后未知 DB 执行结果不会自动重放。
- [ ] 无 Codex 安装/认证时仍可正常使用 SQL IDE。
