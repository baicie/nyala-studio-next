# 权威资料与基线核对（2026-10-18）

以下链接供项目开工和上游同步时核对。本文档包已核实 Code OSS 1.142.0 为 2026-10-14 Stable Release，所选 Tag 的 `.nvmrc` 为 `24.18.0`，该 Tag `package.json` 使用 npm 脚本；Nyala 当前已在 macOS 开发机完成 Bootstrap 编译和原生 Electron 验证，具体证据见 [bootstrap 记录](docs/04-code-oss-bootstrap.md)。

- VS Code 1.142 Release Notes: https://code.visualstudio.com/updates/v1_142
- Code OSS GitHub Releases: https://github.com/microsoft/vscode/releases/tag/1.142.0
- Tag source: https://github.com/microsoft/vscode/tree/1.142.0
- 官方 Build & Run: https://github.com/microsoft/vscode/wiki/How-to-Contribute
- 官方 Source Code Organization: https://github.com/microsoft/vscode/wiki/Source-Code-Organization
- 产品配置参考: https://github.com/microsoft/vscode/blob/1.142.0/product.json
- Node 版本参考: https://github.com/microsoft/vscode/blob/1.142.0/.nvmrc
- Open VSX: https://open-vsx.org/
- Electron Security: https://www.electronjs.org/docs/latest/tutorial/security
- Tauri Architecture: https://v2.tauri.app/concept/architecture/

注意官方文档可能随时间变化；使用长期 Fork 时，任何引用应冻结版本、Tag 和完整 commit SHA。涉及 Microsoft 发行条款和商标、扩展服务授权时，发布前以对应最新协议审查为准。
