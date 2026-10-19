# 12 · 安全、凭证、权限与信任模型

## 威胁模型

需要防范：恶意 SQL/误操作、连接串泄露、错误日志泄露、恶意扩展、被污染的 Webview 结果单元格、被篡改 Sidecar、数据库网络中断导致的未知提交状态、任意路径写出、非法第三方服务调用。

## 最小安全不变量

1. **Credentials 永不明文落盘**：Profile 仅存 `secretRef`；从 OS Keychain/Credential Manager/Secret Service 按平台访问，后续 Linux 不可用时提示用户，而非静默明文 fallback。
2. **Renderer 无长期数据库凭证**：Connection 创建经后端授权的受控桥接；不得将完整 DSN 传入普通 UI telemetry。
3. **Read-only 服务端保证优先**：SQLite 用原生只读、PG/MySQL 借数据库账号权限和受控事务；关键字/AST 检查只是提示，不能等同数据库授权。
4. **写操作明确审批**：针对 DML/DDL/Explain Analyze 等按危险等级提示；用户显式执行可以允许，但 AI 不得绕过。
5. **日志默认脱敏**：不记录 query result、密码、Token、完整 DSN；日志级别 debug 仍执行结构化脱敏。
6. **外部插件非沙箱**：Node Extension Host 自身可能访问文件/网络，不能把内部 API 审批宣传为隔离了恶意扩展。对插件来源/签名/安装提醒做明示。
7. **Webview 最小权限**：严格 CSP、消息 Schema 验证、DOM 转义、禁止用户数据库文本被当 HTML 执行。
8. **任何 SQL 执行只通过单一 Query Authority**，并绑定 Profile、Session、请求来源和授权策略。

## 安全边界示意

```text
Untrusted SQL text / result cells / extension messages
     -> Renderer input validation + CSP
     -> Electron IPC allowlist + origin/window checks
     -> Rust RPC validation + policy + session ownership
     -> DB driver / DB permission
```

各层校验互补；Connection Account 的权限才是远程数据库操作能否真正执行的最终边界。Electron Renderer 应保持 Context Isolation 和 Sandbox（按上游现状审查，避免开启不安全 Node Integration）。

## 操作级别

- `READ`: SELECT、元数据读取；因函数/CTE/锁行为可能有副作用，风险提示不等于权限保证。
- `WRITE`: DML；需要用户知情的连接上下文。
- `SCHEMA`: DDL、特权变更；Protected Profile 必须显式确认。
- `DANGEROUS`: DROP/TRUNCATE、跨库操作、批量无过滤写、Explain Analyze 对 DML；默认需更强审批或限制。

分类失败时保守提示并依赖数据库权限；不许只用 `/^SELECT/` 作为安全策略。

## 事务/取消

- 取消不能证明回滚；异常后显示明确 Unknown。
- `transaction.commit` 不自动重试，必须通过实际 DB 状态恢复或人工核对。
- Sidecar 崩溃后自动重连不等于重试 SQL，更不等于重放 DDL/DML。

## 敏感信息范围

Schema 名称、表结构、SQL 文本、连接历史、导出 CSV、执行计划、截图都可能构成敏感数据。`AI Context Builder` 必须最小化提取、显式授权，第三方模型不在 MVP 默认链路里。

## 发行/更新安全

- Electron/Node/Rust 依赖漏洞扫描、签名/Hash、受控更新通道。
- Sidecar 应作为可信 bundle 打包并校验；禁用从用户任意目录加载未知二进制作为执行引擎。
- 插件扩展源需明确合法性，未知插件展示权限/信任风险。

## P1 威胁测试

输入含 HTML/CSV 公式的数据库内容；试图越权访问另一个 Session 的 ResultHandle；超长帧/损坏 JSON；重复和乱序通知；Sidecar 退出时未完成 DML；日志/错误返回含密码；子进程被恶意替换；Readonly 试图执行带副作用的语句。各项必须有测试与行为说明。
