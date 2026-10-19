# 14 · 本地配置、会话恢复、持久化与迁移

## 存储职责分离

| 内容 | 位置/机制 | 安全语义 |
|---|---|---|
| 窗口布局、Workbench UI | 原生 IStorageService | 保持 VS Code 默认行为 |
| Nyala ConnectionProfile | Rust Local Store（可 SQLite） | 含非敏感字段与 secretRef |
| Password/Token/Private Key | OS Keychain / Credential Manager 等 | 不保存在普通 SQLite/JSON |
| SQL Draft | 带版本的本地草稿存储 | 可含敏感查询，应允许关闭保存/清空 |
| Query History | 本地受控 History Store | 默认不保存结果行，支持关闭与清除 |
| Result Cache | 内存 LRU/临时加密文件（未来） | TTL/Size/明确删除 |
| 实验/执行计划报告 | 用户指定的工作区文件 | 明确导出，隐私提示 |

## Profile 结构

`profileId`, `displayName`, `driver`, `target`, `defaultDatabase`, `sslOptions`, `connectTimeoutMs`, `environmentTag`, `secretRef`, `createdAt`, `updatedAt`；任何原生完整 DSN 包含密码的情况需拆分并脱敏。

## Draft 恢复

- 内容变更写 DraftStore（防抖）；存 SchemaVersion / QueryId / DocumentVersion。
- 重启时恢复编辑器 Tab 与内容，但**不自动重放 SQL**、不恢复在执行中的 Transaction 为可操作状态。
- 若曾处于执行状态，显示 `Interrupted`/`Unknown` 历史信息；需要用户重新执行。
- 对 `.sql` 文件采用原生 VS Code 文件保存语义，不另外制造可能冲突的 autosave 逻辑。

## History

- 可按 Profile、日期、SQL 指纹查询；支持收藏、清理与关闭历史记录。
- 默认不保存参数秘密、数据结果；SQL 文本可能含敏感字面量，提供 redact/opt-out，并在第一次启用时说明。
- 生命周期、磁盘配额、失效数据迁移都是必需字段。

## 迁移

所有业务表含 `schemaVersion`；启动迁移必须幂等、可验证、失败回滚/备份。不能因 Profile 迁移失败删除所有 SQL 草稿。每个 Release 发布前测试从至少上一稳定版本迁移。

## 单机与多窗口

- 同一个 Profile 可被多个 Workbench 窗口使用，但 Runtime 的 Session 不共享无限制全局权限。
- 如果单个 Runtime 服务于多个窗口，则每个 RPC request 要有 Window/Client ownership；否则每窗口独立 Runtime 更简单，后续根据资源成本选择。
- 数据存储并发采用 OS File Lock 或 DB Transaction，避免两个窗口同时写配置造成损坏。

## 隐私导出/清理

提供设置中的 `Clear History`、`Clear Caches`、`Forget Credential`、`Export Diagnostics (redacted)`，并明确说明“清除连接”与“清除系统钥匙串条目”是否一起执行。
