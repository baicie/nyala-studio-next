# 17 · 开源发行、产品身份、依赖许可与更新

> 工程实施清单，不构成法律意见；发布前应根据当期产品配置、各许可证/服务条款再审计。

## 开源许可

Code OSS `microsoft/vscode` 源码采用 MIT；保留原版权、许可证与 Notice；自有 Nyala 代码许可须确定是否 MIT 或其它兼容许可，依赖含 OSS native/third-party 许可，不能只复制 Code OSS 的 LICENSE 文件就宣称所有资产均授权。官方 Microsoft VS Code 发行版、图标/商标及 Marketplace 服务授权不同于其开源源码。

## 产品身份表

| 字段 | 独立化方向 |
|---|---|
| Product Name | Nyala Studio |
| executable / cli | 独立名称避免覆盖 `code` |
| user data dir | `.nyala-studio`（示意，需按 OS 规范） |
| protocol URI | `nyala://`（示意） |
| bundle id | `dev.nyala.studio`（示意，需实际唯一性审查） |
| Windows AppID | 自有 ID/GUID，不用 Code OSS GUID |
| crash/telemetry/update | 默认不指向微软服务 |
| extension gallery | VSIX 侧载，后续 Open VSX |

`product.json` 不是所有发行字段唯一来源，还须检查 build 脚本、installer、资源、服务字段、内部默认插件和签名配置。

## 发行渠道

- Preview/Stable 两渠道；版本语义、UpdateManifest、回滚策略独立。
- 首发：macOS arm64、Windows x64；Linux/ARM 逐步添加。
- macOS Code Signing/Notarization，Windows 签名/信誉，Linux Desktop Integration 后续。
- 生成 SBOM/许可证清单，扫描 npm/Rust CVE；升级要有校验 SHA/签名，禁止不受信任的 Sidecar。

## P0 实际审计结果（2026-10-19）

当前 `product.json` 和相关启动/构建配置已完成一轮初始化审计：

| 项目 | P0 状态 | 处理与边界 |
|---|---|---|
| 产品身份、数据目录、协议、平台 ID | 已替换为 Nyala | `Nyala Studio`、`.nyala-studio*`、`nyala://` 和独立开发态目录；发行前仍需确认 GUID/Bundle ID 的最终唯一性 |
| Copilot/Chat/Agent 默认入口 | 默认禁用 | `defaultChatAgent` 使用空扩展/供应商 ID，相关账号、entitlement、MCP、quota 和文档 URL 置空；Chat entitlement 在未配置扩展时短路。Copilot 源码仍保留用于上游构建兼容，不代表服务可用或获授权 |
| 同步、Marketplace、自动更新 | 默认关闭/未配置 | 未配置微软 Marketplace、同步和更新 feed；扩展以仓库内置和后续明确的 VSIX/Open VSX 策略为准 |
| 遥测/语音 | 未配置产品服务 | 产品字段中不再提供 voice WebSocket 或微软服务 URL；通用上游遥测代码仍存在，发布前需以最终构建参数和隐私声明复核 |
| 内置调试扩展 | 保留开源上游依赖 | `ms-vscode.js-debug-companion`、`ms-vscode.js-debug`、`ms-vscode.vscode-js-profile-table` 固定版本、SHA 和 GitHub 源码地址；这些是开源代码依赖，不是 Marketplace 在线服务。需在发行物中随附其许可证/NOTICE |
| Webview 外部资源 | 受限 allowlist | 默认外部 Webview CDN 地址已移除；server CSP 中保留的 `vscode-cdn.net` 仅是上游 Webview 运行所需的兼容 allowlist，发布前应决定是否改为本地资源并复核 CSP |
| 许可证/版权 | 保留上游归因 | Code OSS MIT 许可证和 Microsoft/第三方版权信息继续保留；Nyala 自有代码的发行许可与完整 SBOM 仍是发布前任务 |

这份表说明 P0 的默认边界已经落地，不构成微软服务、Marketplace、同步或 Copilot 的再分发授权。

## 外部服务审计

新版 Code OSS 1.142.0 的 `product.json` 含 Agent/Copilot 等默认服务配置字段。**默认保留源码不等于可以直接使用、发行这些服务**。应逐条确认：

1. 是否属于开源可再分发资产？
2. 是否需要微软账号、API 密钥或商业服务协议？
3. 是否有意外联网/遥测/数据上传？
4. 是否需要 UI 开关、删除 build asset 或替换默认源？
5. 不合法/不可用时如何友好降级或禁用？

disabled 配置中的扩展 ID 和 social provider ID 必须为空；尤其不能为 Microsoft provider 保留非空占位值，否则 Chat 的后台探测会把它当成可用认证入口并调用 `getSessions('microsoft', ...)`。

## 发布流程

1. Release Branch 从已通过测试的 `nyala/main` 创建。
2. Lockfile、Rust lock、依赖版本、产物 Hash 固定。
3. 本地构建/至少一个 CI 原生构建，通过 SQL E2E、安全与 License audit。
4. 签名、安装卸载、默认目录隔离、更新/回滚验证。
5. 生成 Release Notes：功能、已知限制、数据存储变更、SQL 安全注意事项。
6. 公开安装包的校验和、开源许可证、隐私声明/联系方式。

## 合规特别提醒

- 使用 Open VSX 时要遵守它的 API 条款与扩展本身的许可证，不保证 VS Code Marketplace 所有扩展可获取。
- 默认不采集数据库连接、SQL、Schema、结果数据。诊断报告需要明示用户选择、脱敏。
- 发行“一个可以执行生产 SQL 的 IDE”意味着安全确认、Secret 管理和错误提示并非可选 UX 美化。
