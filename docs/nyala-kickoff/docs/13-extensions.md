# 13 · 插件策略与兼容性边界

## 产品原则

**标准 VS Code Extension API 优先；仅在数据库驱动、查询引擎、元数据权限等领域定义最小 Nyala SPI。** 不重新制造 Commands、Keybindings、LSP、Panels、Themes 的通用插件平台。

## 两类扩展

### VS Code Extension

- 语言功能：语法、格式化、补全、Hover、Diagnostics、语言服务器。
- 通用能力：主题、命令、设置、快捷键、Webview、Tree、Notebook（若后续使用）。
- Runtime 仍使用 Node Extension Host；第三方扩展与本机权限的信任边界需面向用户明确说明。

### Nyala Database Capability SPI（未来版本）

只暴露：`listConnections`, `requestMetadata`, `executeReadOnlyQuery`, `registerDriver`, `registerQueryTool` 等严格受控 API；每项有 Capability 和权限语义。API 初期为 internal，不急于稳定对外。

不要随便让插件拿到任意 Rust RPC 通道。建议 External Extension → Nyala Bridge → 授权检查 → Rust Runtime。

## 兼容层

- Extension API 版本以 Code OSS Release 固定；仅对明确的功能列兼容矩阵，不保证所有第三方扩展。实现：`product.json` 的 `extensionApiVersion`（等于基线 Tag）作为 `vscode.version` 报告给扩展，产品版本不变，见 [ADR 0003](../../adr/0003-extension-api-version.md)。
- 私有 Proposed API 不对外承诺稳定；Nyala 内置扩展尽量使用 stable API。
- 完整 Node Extension Host 给开发者扩展以 Node 能力，这**不是**权限沙箱。若未来需运行不可信插件，必须独立设计真正的沙箱与 OS 权限隔离。

## 市场与分发

Code OSS 的 MIT 源码与微软 Visual Studio Marketplace 服务不是一回事。初期仅支持本地 VSIX 安装、内置必要扩展；未来再评估 Open VSX 接入、缓存和许可。禁止将微软 API/Token/Marketplace URL 直接从官方发行版复制到产品中。

## 内置扩展清单（MVP）

- `nyala-sql-language`：Sql Language features（高亮、Formatting、LSP）。
- `nyala-runtime-client`：尽量不暴露为随意的网络 RPC，而是经 Workbench Service 使用。
- Code OSS 内置 JS Debug/Notebook/Copilot 等组件：逐项标记 `keep/disable/remove-at-package`，首版优先禁用入口，不大规模删源码。

## 插件 API 演进检查

1. API 是否必须外部开放？
2. 访问数据库属于 READ/WRITE/SCHEMA 哪个级别？
3. 多 Session 资源归属是否检查？
4. 卸载插件后是否会清理 Result/Listeners/Commands？
5. 安全性是否依赖扩展自觉（必须明确风险）？
6. 上游升级是否改变 Extension Host 或 Proposed API？
