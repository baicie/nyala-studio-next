# 11 · 版本号、发行渠道、构建与回滚

## 版本边界

- `Code OSS upstream version` 与 `Nyala product version` 分开记录，例如 upstream `1.143.0`、Nyala `0.0.1-dev.0`。
- 发布通道建议 `dev`、`preview`、`stable`；不同 channel 的 DataFolder/URI/应用身份应考虑隔离，迁移有明确选择。
- Rust Runtime / RPC major / Agent Runtime 各自有兼容版本，不能把所有版本都隐式绑定为一个数字。
- CHANGELOG 只记录 Nyala 产品变化；上游升级记 Tag、PR、兼容性重大差异与完整来源链接，避免复制几百条微软 commit 到产品发布说明。

## 发行门禁

- Check Code OSS License/ThirdPartyNotices/icon/font/asset and Codex runtime redistribution if bundled。
- 本机/CI 构建目标平台实际 Installer，安装、启动、SQL 完整闭环、关机退出、卸载/升级后数据迁移、Rollback。
- macOS 签名/公证、Windows 安装/签名、Linux RPM/DEB/Snap 具体渠道分别维护；缺签名不可声称“已正式稳定发行”。
- 软件更新端点、扩展市场、Telemetry、账号登录、Issue URL 必须指向被许可且真实存在的 Nyala 服务，不可继承微软产品身份。
- Security Release：先修安全/回补，有 Release Note 与原子更新计划，不在安全回补 PR 混入性能/格式化大改。

## 升级/回滚

- 保存元数据迁移策略（单向/可回退）、备份、用户配置数据库 schema version、不能无提示清空旧数据。
- 下载应用更新/Agent Runtime 都固定版本、完整性校验、异常回滚；低可信渠道采用明确 Preview 标签。
- 源码 Tag + lockfile +构建日志+测试矩阵+SBOM/许可证清单，达到可复现审查的最低要求。
