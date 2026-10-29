# 10 · 测试矩阵与故障注入

## 按层次

| 层 | 单元 | 集成 | E2E |
|---|---|---|---|
| TS/Workbench | View/Command/Editor/Service/Dispose | QueryService↔RPC Bridge Fake | 原生 Electron 启动、Reload、Tab/Tree、Theme/Keyboard |
| IPC/Protocol | framing/schema/error/state | TS Client↔Rust Server | 进程异常、重复事件、半帧、协议版本变更 |
| Rust SQL | SQLite/PG/MySQL driver | 真实 Docker/PostgreSQL/MySQL（若环境可用） | UI 查询、事务、取消、导出 |
| 安全 | Policy 与输入限制 | 只读账户/连接授权/Secret | Agent 拒绝审批、敏感数据脱敏、跨库拒绝 |
| 平台 | path/URI/安装器 | macOS/Windows/Linux 构建 | 安装/启动/卸载/更新回滚 |

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
