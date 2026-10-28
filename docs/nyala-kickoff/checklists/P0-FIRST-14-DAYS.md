# P0 · 首 14 天行动清单（按完成情况而非日历强制推进）

> 状态更新：2026-10-19。已完成的是当前 macOS 开发环境中的 Bootstrap 验收；跨平台发行、SQL 功能和完整回归仍按下方限制推进。

## Day 1–3：可复现的原生上游

- [x] 固定 Code OSS `1.142.0`；当前分支为 `nyala/main`，记录完整 SHA：`d956e8a6ac5d904486557eea07e1d6bd62a4d36f`。
- [x] 按 `.nvmrc` 使用 Node `24.18.0` 与 npm；依赖已安装并完成增量编译。当前 shell 默认 Node 版本不作为验收证据，复现时应显式切换 `.nvmrc`。
- [x] 通过 `scripts/code.sh` 启动原生 Electron；启动验证使用 macOS、`--disable-gpu` 和本地 CDP 连接。
- [x] 已验证空工作区、文本编辑、Split editor、内置 Extension Host 和 Webview 基础渲染；证据与命令见 [bootstrap 记录](../docs/04-code-oss-bootstrap.md) 和 [兼容性报告](../../../nyala/upstream-compatibility.md)。

## Day 4–6：产品边界

- [x] 生成 Product Identity / DataFolder / URI Scheme 变更清单，并写入 patch ledger。
- [x] 审计 `product.json`：Copilot/Chat、身份认证、Marketplace/更新入口、外部 URL 和遥测默认值已关闭或置空；保留项与风险见 [release compliance](../docs/17-release-compliance.md)。
- [x] 保留上游 MIT 许可证与归因信息；Nyala 自有代码的独立发行许可仍需在发布前确认。

## Day 7–10：Workbench Hello World

- [x] Register `nyala.hello`，命令面板显示为 `Nyala: Hello Workbench`。
- [x] 注册 `Nyala Connections` View、状态栏入口和占位内容；原生启动后可见并可执行。
- [ ] Reload Window 与生命周期回归测试：当前已验证首次启动和重复命令，需补自动化测试后关闭此项。
- [x] 记录 Workbench 启动 → Contribution → Command → View 的调用入口，见 [Workbench integration](../docs/05-workbench-integration.md) 与兼容性报告。

## Day 11–14：验收与下一阶段设计

- [x] 运行 P0 compile/typecheck/build-fast/hygiene、定向 lint、JSON 检查和脚本语法检查。
- [x] 记录 [patch ledger](../../../nyala/patch-ledger.md) 与第一份 [upstream compatibility report](../../../nyala/upstream-compatibility.md)。
- [x] 更新 P1 RPC 合同：已固化为可执行合同 [`nyala/rpc/README.md`](../../../nyala/rpc/README.md)（v1 envelope schema、错误码表、一致性样例），`npm run nyala:validate-rpc` 通过；Rust Runtime 本身尚未开始实现，实现任务按 [backlog](../docs/20-backlog.md) N-101..N-110 推进。
- [x] 记录限制和恢复计划；P0 Bootstrap 已完成，SQL 功能与跨平台发行不在本次完成范围。
