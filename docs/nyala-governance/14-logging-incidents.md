# 14 · 日志、排障、故障分级、RCA

## 结构化日志字段

`timeUTC`, `component`, `severity`, `appVersion`, `upstreamTag`, `runtimeVersion`, `correlationId`, `sessionId`, `executionId`, `eventSequence`, `errorCode`, `elapsedMs`。日志不得包含密码、Token、私人连接 URL、任意查询结果行或 SQL 参数；在隐私开启模式中尽量不保存 SQL 正文。

## 跨层追踪

Nyala Renderer/Agent Tool ↔ Electron Supervisor ↔ Rust RPC ↔ DB Driver 保持相同 correlation/request ID；异常时保留 Query 的真实终态、是否仍可能在 DB 端运行。高危未知事务状态以 `UNKNOWN` 呈现，而不是 `FAILED`。

## 严重度

- S0：数据损坏、串库误执行、密钥泄露、错误自动提交/重放。阻断发布、先止损。
- S1：无法启动、核心查询错误、跨进程失控、有远程命令执行风险。阻断相应渠道。
- S2：Results/Explorer/LSP 功能部分失效且有合理 workaround。
- S3：次要视觉、快捷键、文档瑕疵。

## RCA 模板

症状/首次发生时间/受影响 Tag & SHA/最小复现/根因与证据/触发条件/缓解/永久修复/回归测试/未解风险/Owner。Agent 或 dsh 输出的“已修复”只有在真实代码与测试支持时才成立。

## 监控

个人开源工具优先本地诊断与用户主动导出日志，默认不引入遥测；必要时支持“导出脱敏诊断包”。诊断包生成时审计敏感数据。
