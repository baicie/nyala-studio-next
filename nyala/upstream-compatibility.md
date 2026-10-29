# Nyala P0 Upstream Compatibility Report

更新时间：2026-10-29。报告针对 macOS 原生开发环境。初始化基线为 Code OSS `1.142.0` /
`d956e8a6ac5d904486557eea07e1d6bd62a4d36f`，当前同步基线为 `1.143.0` /
`2d0b7506a36c1d6db9a466440131a8e01eab2289`，开发版本为 `0.0.1-dev.0`。

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

## 1.143.0 同步回归（2026-10-29）

同步通过 `git merge 1.143.0` 完成，合并提交保留上游 731 个提交作为祖先（不 squash、不 rebase）。
53 个冲突中 46 个纯上游分歧取上游版本，7 个含 Nyala 意图的文件手工合并，细节见
[`nyala/patch-ledger.md`](patch-ledger.md) 的「同步记录」。

在 Node `24.18.0`、npm `11.16.0` 环境下完成：

```text
npm run typecheck-client               passed
npm run compile                        passed（client + 内置扩展 + copilot）
npm run gulp hygiene                   passed（13622 files）
npm run nyala:validate-product         passed
npm run nyala:validate-rpc             passed
git diff --check                       passed
```

Debian 生命周期脚本另外做了 `bash -n` 与 Copilot marker 计数核对（postinst 1、postrm 1、
rpm spec 2、gulpfile callback 2+1）。

限制：

- 依赖安装使用 `--ignore-scripts`（GitHub Release 下载被网络与速率限制挡住），因此
  `@vscode/ripgrep`、Electron 二进制未下载；本轮没有 Electron 冒烟，只有编译与静态检查证据。
- 依赖需要按 `build/npm/dirs.ts` 在各子目录单独安装；`npm run postinstall` 在本机没有真正落盘。
- Windows/Linux 打包、签名、安装卸载仍未验证；`copilot_shim` 的 Rust 组件未构建。

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
