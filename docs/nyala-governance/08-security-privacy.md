# 08 · 安全、隐私、供应链与许可证

## 安全边界

- 凭证只通过 OS 安全存储/受控 Runtime 引用；不得出现在 renderer state、localStorage、SQL History、任务上下文、日志或 crash report。
- `product.json` 新增云服务/Marketplace/Copilot/Telemetry/Auth/Update 字段都需审计。**Code OSS 源码 ≠ 微软商业服务和品牌可再发行许可**。
- Electron Renderer 与 Node Extension Host/第三方插件不是同一信任域。第三方扩展可能访问文件/网络；官方 DB 工具的 Policy 不能证明整个应用被完全沙箱化。
- IPC input validation + bounded payload + per-request auth/identity/deadline；不得允许未授权进程通过裸 TCP 直接连接本地 Sidecar。
- Webview/HTML 严格 CSP，处理 DB 文本应转义；禁用不必要的危险 Node/DOM API，不加载不受控远端 UI 脚本。

## 供应链

- 执行文件（Codex、Rust Runtime、平台工具）使用固定版本、可信源、哈希/适用签名校验、原子替换、可回滚、清理旧版本。
- 依赖更新优先由明确 PR 记录；发生供应链/安全漏洞时可对有影响的包定向 backport，不因为 Dependabot 报告就无条件批量更新。
- 保留 MIT 源码归属、ThirdPartyNotices、构建依赖许可、图标和产品资产来源清单；发行前审查每个平台所包含物料。
- 用户遥测与云同步默认关闭，开启时说明何种数据、传输目的、保留期限和退出方式。

## 安全发布阻断

- S0：凭证泄露、写库误操作、跨库执行、未经审批 DB 外发/写入、自动重放未知 Commit、更新包未校验。
- S1：可触发远程执行、默认秘密权限扩散、安装脚本误注册 Microsoft 更新源。
- 安全报告记 UTC 时间、影响版本、复现脚本（脱敏）、受影响环境、修补验证和缓解方案；不要把真实用户数据放到公开 Issue。

## 工程说明

本规范是工程目标，部分能力尚未实现。每份 PR 必须写清“实际已强制的约束”和“计划但尚未强制的约束”，避免安全表述越权。
