# 04 · TypeScript Workbench、Rust 与 RPC 实现规范

## TypeScript / Workbench

- 直接遵循 `.github/copilot-instructions.md`、`.github/instructions/coding-guidelines.instructions.md`、`disposable.instructions.md`、`source-code-organization.instructions.md`。本文件**不覆盖**微软的 import/order/localization/test 风格。
- 注册 `Action2`、`ViewPane`、`EditorInput/EditorPane`、Workbench Contribution 时遵守当前 Tag 的真实 API；**先查看仓库用例，不从老版本记忆猜**。
- 所有监听器与异步资源使用 `Disposable` / `_register`，窗口 Reload/Editor close/取消后确认无孤儿任务。
- 公共 `common` 协议不得引用 Renderer DOM/Electron Node；跨进程返回类型需可序列化、有上限。
- VS Code 主题使用现有 token/Codicon、键盘/Context Key、localize；不要对外部 HTML 拼接敏感结果。
- 新 UI 使用原生 View/Editor 而非为了局部功能整体引入 SPA 框架。React 只在受控、可清理、性能评估通过的子区域使用。

## Rust

- `Result<T, DomainError>` 优于用户输入导致 panic；对所有外部输入做体积、类型、超时校验。
- 每个 Session/Transaction/ResultHandle 明确生命周期与所有权；事务关联物理连接，不能透明换成池中另一个连接。
- Secret 在日志中脱敏，Debug/Tracing 不能打印密码、Token、行数据；密钥通过 OS Secret Provider/可审计 IPC 引用。
- SQL 驱动能力在 Capability Matrix 声明，SQLite/PG/MySQL 不假装拥有相同取消、查询计划或分页语义。
- `Cargo.lock` 与 Rust Toolchain 政策按实际 Workspace 判断；未建 crate 前不要虚构构建命令。

## RPC

- 协议原点是 `nyala/rpc/v1/`：Length-prefixed framing、Hello/version negotiation、error map、conformance。
- TS/Rust 测试必须包含半帧、粘包、零长度、超限、非法方法、版本不匹配、请求 ID 复用、断线与取消竞态。
- 禁止无上限一次性传输结果，使用 ResultHandle + fetchPage + release；完整类型保存 Null/Decimal/BigInt/Date/Binary。
- 方法兼容性破坏需要新 major 与 ADR，不可悄悄更改 v1 字段含义。

## Code Review

必须说明：入口与 API 选择、数据流、生命周期、异常路径、测试证据、引入/移除的上游补丁、性能/安全影响。
