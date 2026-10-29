# P0 · 首 14 天行动清单（按完成情况而非日历强制推进）

> 状态更新：2026-10-29。macOS `1.142.0` 完成 Bootstrap 验收；Windows 11 `1.143.0` 完成开发态原生冒烟（FAIL 11/12，唯一失败项是内置 Markdown 语言功能与开发版本号不兼容）。跨平台发行、SQL 功能和完整回归仍按下方限制推进。

## Day 1–3：可复现的原生上游

- [x] 固定 Code OSS `1.142.0`；当前分支为 `nyala/main`，记录完整 SHA：`d956e8a6ac5d904486557eea07e1d6bd62a4d36f`。
- [x] 按 `.nvmrc` 使用 Node `24.18.0` 与 npm；依赖已安装并完成增量编译。当前 shell 默认 Node 版本不作为验收证据，复现时应显式切换 `.nvmrc`。
- [x] 通过 `scripts/code.sh` 启动原生 Electron；启动验证使用 macOS、`--disable-gpu` 和本地 CDP 连接。
- [x] 已验证空工作区、文本编辑、Split editor、内置 Extension Host 和 Webview 基础渲染；证据与命令见 [bootstrap 记录](../docs/04-code-oss-bootstrap.md) 和 [兼容性报告](../../../nyala/upstream-compatibility.md)。
- [ ] Windows 11 · `1.143.0` 原生冒烟（2026-10-29，`scripts\code.bat` + `scripts/nyala/smoke-electron.ts`）：**FAIL 11/12**。标题、状态栏、Hello Workbench、Connections View、空工作区编辑、Split Editor、最小 Webview（图片预览）、Extension Host、2 次 Reload Window 均 PASS；`vscode.markdown-language-features` 因 `0.0.1-dev.0` 不满足 `vscode-languageclient` 的 `^1.67.0` 激活失败。修复后重跑通过再勾选，见[兼容性报告 Windows 节](../../../nyala/upstream-compatibility.md#windows-11430-原生-electron-冒烟2026-10-29)。

## Day 4–6：产品边界

- [x] 生成 Product Identity / DataFolder / URI Scheme 变更清单，并写入 patch ledger。
- [x] 审计 `product.json`：Copilot/Chat、身份认证、Marketplace/更新入口、外部 URL 和遥测默认值已关闭或置空；保留项与风险见 [release compliance](../docs/17-release-compliance.md)。
- [x] 保留上游 MIT 许可证与归因信息；Nyala 自有代码的独立发行许可仍需在发布前确认。

## Day 7–10：Workbench Hello World

- [x] Register `nyala.hello`，命令面板显示为 `Nyala: Hello Workbench`。
- [x] 注册 `Nyala Connections` View、状态栏入口和占位内容；原生启动后可见并可执行。
- [x] Reload Window 与生命周期回归测试：单元测试 `src/vs/workbench/contrib/nyala/test/browser/nyalaBootstrap.test.ts`（8 passing：单次注册、重复注册不生效、命令重复执行、`ShutdownReason.RELOAD` 后状态栏条目释放并只重建一个、重复 Dispose、Connections View 重建）；Windows `1.143.0` 原生冒烟中 2 次 `Developer: Reload Window` 后状态栏 / Activity Bar / Command Palette 各只有 1 个 Nyala 条目，Hello 与 Connections 正常。原生冒烟脚本尚未接入 CI（CI 受账单阻断）。
- [x] 记录 Workbench 启动 → Contribution → Command → View 的调用入口，见 [Workbench integration](../docs/05-workbench-integration.md) 与兼容性报告。

## Day 11–14：验收与下一阶段设计

- [x] 运行 P0 compile/typecheck/build-fast/hygiene、定向 lint、JSON 检查和脚本语法检查。
- [x] 记录 [patch ledger](../../../nyala/patch-ledger.md) 与第一份 [upstream compatibility report](../../../nyala/upstream-compatibility.md)。
- [x] 更新 P1 RPC 合同：已固化为可执行合同 [`nyala/rpc/README.md`](../../../nyala/rpc/README.md)（v1 envelope schema、错误码表、一致性样例），`npm run nyala:validate-rpc` 通过；Rust Runtime 本身尚未开始实现，实现任务按 [backlog](../docs/20-backlog.md) N-101..N-110 推进。
- [x] 记录限制和恢复计划；P0 Bootstrap 已完成，SQL 功能与跨平台发行不在本次完成范围。
