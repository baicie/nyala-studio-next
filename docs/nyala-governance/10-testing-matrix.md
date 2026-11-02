# 10 · 测试矩阵与故障注入

## 按层次

| 层 | 单元 | 集成 | E2E |
|---|---|---|---|
| TS/Workbench | View/Command/Editor/Service/Dispose | QueryService↔RPC Bridge Fake | 原生 Electron 启动、Reload、Tab/Tree、Theme/Keyboard |
| IPC/Protocol | framing/schema/error/state | TS Client↔Rust Server | 进程异常、重复事件、半帧、协议版本变更 |
| Rust SQL | SQLite/PG/MySQL driver | 真实 Docker/PostgreSQL/MySQL（若环境可用） | UI 查询、事务、取消、导出 |
| 安全 | Policy 与输入限制 | 只读账户/连接授权/Secret | Agent 拒绝审批、敏感数据脱敏、跨库拒绝 |
| 平台 | path/URI/安装器 | macOS/Windows/Linux 构建 | 安装/启动/卸载/更新回滚 |

## 2026-11-01 Runtime 验收快照

| 范围 | 状态 | 证据与未覆盖项 |
|---|---|---|
| N-104 SQLite Profile/Session | **PASS / 已合入** | PR #33，squash `195475b84b3`；生命周期、无效文件、只读模式、OS access denied、WAL 数据库内容不变、capabilities 精确值与锁等待时限；主线 run `41290936784` 四项必需检查 PASS。Windows 本机测试已跑，但 CI 仅 Linux，Windows 路径未形成平台 CI 门禁；详见 [ADR 0002](../adr/0002-rust-runtime-workspace.md) |
| N-103 Supervisor | **PASS / 已合入** | PR #35，squash `24c3cc7aa23`；spawn/kill/restart/backoff/shutdown、同步 spawn 抛错、帧错误换代、每窗口一个 Runtime、staging 与不重放已测；staging 缓存身份为内容 SHA-256 + POSIX 执行位，红绿对照成立（旧实现 4 个内容回归 FAIL）；Linux CI run `41314270226` `71 passing`，含 `✔ staging follows the source execute bits on POSIX and ignores them on Windows`、真实 Runtime 必跑（`NYALA_RUNTIME_REQUIRED=1`）。Windows 原生 Runtime smoke 5/5 是合并前工作树证据，最终 head 未重跑；macOS 与 Linux 原生桌面 smoke **NOT RUN** |
| 禁用 Chat 的 Agent Host / 词典出站 | **PASS / 已合入** | PR #34，squash `2b73f20285c`；head `a334073f505` 四项必需检查 PASS；Windows 原生 smoke 17/17 PASS，直接 `vscode:restartAgentHost` 被主进程门禁拒绝；真实 enablement 描述符测试 `nyalaAgentHostEnablement.test.ts` 与负向对照（组合树上 1 passing）。一次 Quick Open 超时仍需保留记录；系统级抓包、Linux/macOS 原生、旧 profile、打包版本 **NOT RUN** |

PR #34 与 #35 已于 2026-11-01 合入，N-105/N-106/N-109 随 PR #37（`b9f00ff4326`）合入，N-110 的生成合同随 PR #39（`113a170be69`）合入；但平台覆盖仍未补齐：完整 P1 headless 查询闭环、N-107 的流式游标仍未交付、N-108 的运行中取消/`unknown` 已在分支 `feat/p1-async-execution` 完成并待合入验收；N-104 的原生只读打开不等于 N-109 完成。

## 必测失败场景

- `Query` 下发后 Runtime Crash，用户看到 UNKNOWN 与重试建议，但不自动重放写操作。
- cancel 与 complete 同时到达；未被 Cancel 的远端查询仍在运行时提示真实不确定性。
- 拖动/关闭 SQL Tab 时，相关 Session 不能误杀其他 Tab 的事务；结果 handle 释放。
- 两个 Tab 绑定两个不同数据库，快速切换后不能串库。
- 密码错误/TLS 错误/权限不足/网络抖动/超时/大包/低内存/磁盘不可写。
- Webview 与 SQL 注释含特殊 HTML、不可信文本；不能 XSS/执行越权工具。

## 工作方法

- 优先对应改动的最小测试；上游测试所在路径以当前 Tag 为准，不凭记忆写死命令。
- 每项测试记 SHA、OS、软件版本、环境、真实执行时间、状态和日志/截图。Fail 需要 Root Cause；Not Run 需要 Blocker。
- upstream merge 增加 smoke 验证：VS Code 原生空工作区、编辑、分屏、命令、Extension Host、Webview、Nyala Connections/Agent Task；发布时包含真实安装包验证。
- 稳定测试优先于短期 CI 看板变绿；禁止通过整体 skip/disable 删除测试来解决 Flaky，除非独立 Issue/理由/恢复条件。
