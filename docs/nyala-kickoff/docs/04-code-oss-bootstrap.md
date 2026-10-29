# 04 · Code OSS Fork、首次构建与品牌初始化

> **v1.1 状态提示**：下面的 1.142.0 构建步骤属于首次 Bootstrap 历史；仓库已同步到 Code OSS **1.143.0**。见文末最新同步说明；1.143.0 原生 Electron Smoke 尚未完成。

> 状态更新：2026-10-19。已在 macOS 开发机完成 Nyala Bootstrap 的编译和原生 Electron 验证。本文记录的是开发态证据，不代表 Windows/Linux 安装包、签名或 SQL 功能已完成。

## 固定上游

上游：<https://github.com/microsoft/vscode>，首个候选 Release：`1.142.0`（2026-10-14）。Tag 存在；Node 推荐遵循该 Tag 的 `.nvmrc`=`24.18.0`；2026 上游官方主流程为 **npm**，不要复用旧 SideX/pnpm，也不要复制旧教程的 Yarn 1 指令。

```bash
# 方案：先在 GitHub 上 Fork microsoft/vscode 到自己名下，再克隆。
git clone https://github.com/<OWNER>/vscode.git nyala-studio
cd nyala-studio
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream --tags
# 保留 upstream 历史，从固定 tag 派生；确保不会意外在 detached HEAD 开发
git switch -c nyala/main 1.142.0
printf 'upstream-tag=%s\nupstream-sha=%s\n' '1.142.0' "$(git rev-parse HEAD)"
cat .nvmrc
```

提示：如果 GitHub Fork 默认分支为 `main`，需自行确定推送分支策略；命令只是创建本地 `nyala/main`，**不意味着已经改变远程默认分支**。

## 环境准备

- Git；Node.js 以 `.nvmrc` 为准（候选 `24.18.0`，例如 `fnm use`）；npm 随指定 Node 发行。
- Python 和本机 C/C++ Build Tools，Node native addons 可能需要 node-gyp 编译。
- Windows：VS Build Tools + 对应 SDK 与 MSVC；macOS：Xcode Command Line Tools；Linux：按官方依赖安装。
- 将项目克隆到**无空格**路径；确保空余磁盘与足够内存（首次构建资源需求较高）。
- 官方前置要求以 <https://github.com/microsoft/vscode/wiki/How-to-Contribute> 为准，因上游可能变化。

## 基线构建（先一个字不改）

```bash
npm install
npm run watch
# 等首次成功编译，保持 watch 运行；在新终端启动
./scripts/code.sh              # macOS / Linux
# 或 .\scripts\code.bat         # Windows PowerShell
```

`npm run watch` 在当前版本含多个 watch 任务，包括扩展与 Copilot 相关任务；具体组成需按 `package.json` 与 `product.json` 审计，**不要把全部上游默认服务自动当作 Nyala 合法可分发特性**。

不要盲目 `git clean -xfd`：该命令会删除未追踪文件。仅在工作树已经备份并理解影响后使用。

## P0 真实验证表（首次启动填写）

| 项目 | 预期 | 实际 | 日志 / PR |
|---|---|---|---|
| upstream tag / full SHA | 1.142.0 / 记录真实 SHA | `1.142.0 / d956e8a6ac5d904486557eea07e1d6bd62a4d36f` | `git rev-parse HEAD`; [upstream-base.json](../../../nyala/upstream-base.json) |
| Node + npm | 匹配 `.nvmrc` | Node `24.18.0` / npm `11.16.0` | 使用 `.nvmrc` 对应 Node；项目脚本为 npm |
| 原生 Electron 启动 | 成功 | macOS 原生 Electron 成功启动；窗口标题为 `Nyala Studio Dev` | `scripts/code.sh`；本地 CDP/Playwright 启动记录 |
| 进入空窗口并编辑文本 | 成功 | 成功打开空工作区并完成文本编辑 | 原生 Workbench smoke |
| Split editor | 成功 | 成功创建 Split editor | 原生 Workbench smoke |
| Extension Host 激活内置扩展 | 成功 | 内置 Extension Host 激活；未覆盖所有内置扩展矩阵 | 原生 Workbench smoke；完整扩展矩阵仍 pending |
| Webview 渲染 | 成功 | 基础 Webview 渲染通过 | Playwright smoke；复杂 Webview/权限场景仍 pending |
| 原生 VS Code 回归 | 无额外修改 | Nyala 入口与产品身份改动后基础编辑器回归通过 | `npm run compile`、`typecheck-client`、`build-fast -- --client-only`、`gulp hygiene`、定向 ESLint |

## 独立产品化（先审计再改）

- `product.json`：短/长名称、applicationName、dataFolderName、URL Protocol、Windows/macOS ID、窗口与更新/扩展服务字段。
- 图标、About、CLI 名称、桌面快捷方式、安装包 ID、用户数据目录等必须避免覆盖 VS Code。
- 审计默认 `Copilot`、Chat/Agent、云端服务、遥测、Authentication、同步、自动更新、内置扩展的**实际代码、许可、外部 URL**。不可以仅改 UI 文案就保留微软商用专属服务调用。
- 使用独立更新签名、独立域名/Manifest。禁用无法合法、稳定接入的服务；默认不启用产品自有遥测。
- 不要复用微软品牌和官方商标、官方 Marketplace 的服务配置；见 [17](17-release-compliance.md)。

## 第一个 Workbench 实验

1. 在 `src/vs/workbench/contrib/nyala/bootstrap/browser/` 实现 `nyala.hello` Command 和 View/Status 项。
2. 查对应 Tag 官方 `workbench.desktop.main.ts` 入口，**仅增加最小 import / registration**，避免一次性改动多处核心。
3. Reload Window、重新打开、重复运行命令，确认有 Dispose/生命周期处理。
4. 记录从 Contribution 到 DI/Command Registry 的源码路径，留一篇学习笔记。

本次实现入口为 `src/vs/workbench/contrib/nyala/bootstrap/browser/nyala.contribution.ts`，由
`src/vs/workbench/workbench.common.main.ts` 引入；View 实现在同目录的
`nyalaConnectionsView.ts`。命令执行时显示 `Nyala Studio Workbench is ready.`，Connections
View 显示 `Nyala connections will appear here.`。

详细改动边界、上游兼容风险和未覆盖项见 [patch ledger](../../../nyala/patch-ledger.md) 与
[upstream compatibility report](../../../nyala/upstream-compatibility.md)。

## 目录级兼容和 CI

新仓库暂时继承官方 ESLint、tsconfig、gulp/npm 构建，不叠加新框架。引入 Rust 后，不修改官方工作流即假设所有 CI 自动覆盖 Rust；为 Rust 单独增加 matrix/test。初期尽量关闭上游 Fork 不适用的自动触发 Actions，按需新建 `nyala-ci`。

## 常见坑

- 使用错误 Node 版本导致 native dependency 编译失败。
- 大规模删除 Copilot/Agent Contribution 导致启动依赖断裂；应先通过产品服务注册/入口排除验证。
- VS Code 的 dev 构建启动成功不代表 release 包具备签名/更新/扩展源。
- macOS arm64 与 Windows x64 构建环境不同，不能在一个平台成功后声称跨平台可用。

## 参考（截至 2026-10-18）

- https://code.visualstudio.com/updates/v1_142
- https://github.com/microsoft/vscode/tree/1.142.0
- https://github.com/microsoft/vscode/wiki/How-to-Contribute
- https://github.com/microsoft/vscode/wiki/Source-Code-Organization

## v1.1 现状修订 · 1.143.0 同步（2026-10-29）

本文件之前关于 1.142.0 的内容属于**初始化历史记录**，不得整体替换。仓库 `nyala/upstream-base.json` 显示已通过真实 Git Merge 同步至 **1.143.0**（`2d0b7506a36c1d6db9a466440131a8e01eab2289`），PR #14 保留上游祖先。同步遇 53 个冲突，其中 7 个涉及 Nyala 的产品意图，由维护者手工处理（见仓库 `nyala/patch-ledger.md`）。

同步 PR 与 `nyala/upstream-compatibility.md` 自报本地 macOS compile / typecheck-client / hygiene / Nyala product + RPC contract 校验通过；**本次升级未完成 Electron Smoke**（依赖下载/安装受阻）。Windows/Linux 安装及发行也未验收。在线 GitHub Actions 因账户计费阻断，无真实运行结论。上述内容以仓库动态记录为准；v1.1 设计修订没有重跑这些检查，不能作为独立测试证据。
