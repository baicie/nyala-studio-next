# Nyala P0 Upstream Compatibility Report

更新时间：2026-10-19。报告针对 macOS 原生开发环境，基线为 Code OSS `1.142.0` /
`d956e8a6ac5d904486557eea07e1d6bd62a4d36f`，开发版本为 `0.0.1-dev.0`。

## 已执行

在 Node `24.18.0`、npm `11.16.0` 环境下完成：

```text
npm run compile                         0 errors（客户端与内置扩展）
npm run typecheck-client                passed
npm run build-fast -- --client-only    passed
npm run gulp hygiene                    passed
targeted ESLint                         passed
JSON/product identity assertions        passed
bash -n scripts/code.sh                 passed
git diff --check                        passed
```

原生 Electron 通过 `scripts/code.sh` 启动（验证时使用 `--disable-gpu`，并通过本地 CDP
连接 Playwright）。观察到：

- 启动页标题为 `Nyala Studio Dev`；
- Command Palette 中出现并执行 `Nyala: Hello Workbench`；
- 执行后显示 `Nyala Studio Workbench is ready.`；
- `Nyala Connections` View 显示 `Nyala connections will appear here.`；
- 空工作区、文本编辑、Split editor、Extension Host 基础激活和基础 Webview 渲染通过。

## 证据边界

这些结果证明 Bootstrap 主线可编译、可启动且最小 Workbench Contribution 已接入。它们不
证明以下事项：

- Windows/Linux 原生启动、安装卸载、签名、更新和 WSL 完整链路；
- 所有内置扩展、复杂 Webview 权限和多窗口场景；
- SQL Runtime、Rust Sidecar、连接驱动、查询执行或结果网格；
- Reload Window 后的自动化生命周期测试、完整桌面 E2E 和发布包回归；
- 上游 Microsoft 服务、Marketplace 或 Copilot 的可再分发授权。
- 产品配置中的 disabled Chat 不会注册默认扩展/供应商入口，也不会触发 Microsoft 账户探测；该约束由产品基线校验覆盖。

## 下一步验收

1. 为 `Nyala Connections` 增加 Reload/Dispose 自动化测试。
2. 在目标 Windows 环境完成 `scripts/code.bat`、数据目录隔离和原生启动记录。
3. 在进入 P1 前实现 Rust RPC 合同的半帧、超限、错误和版本不匹配测试。
4. 每次上游升级重新运行本报告中的基础命令，并更新 [patch ledger](patch-ledger.md)。
