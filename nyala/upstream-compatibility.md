# Nyala P0 Upstream Compatibility Report

更新时间：2026-10-30。报告覆盖 macOS（`1.142.0`）与 Windows 11（`1.143.0`）原生开发环境。初始化基线为 Code OSS `1.142.0` /
`d956e8a6ac5d904486557eea07e1d6bd62a4d36f`，当前同步基线为 `1.143.0` /
`2d0b7506a36c1d6db9a466440131a8e01eab2289`，开发版本为 `0.0.1-dev.0`；报告给扩展的 Extension API 版本为 `1.143.0`
（`product.json` 的 `extensionApiVersion`，见 [ADR 0003](../docs/adr/0003-extension-api-version.md)）。

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
  1.143.0 的原生 Electron 冒烟在 Windows 上补做，见下一节。
- 依赖需要按 `build/npm/dirs.ts` 在各子目录单独安装；`npm run postinstall` 在本机没有真正落盘。
- Windows/Linux 打包、签名、安装卸载仍未验证；`copilot_shim` 的 Rust 组件未构建。

## Windows 1.143.0 原生 Electron 冒烟（2026-10-29）

这是 `1.143.0` 的第一份原生启动证据，也是第一次在 Windows 上验证。macOS `1.142.0` 的结果不能代替本节。

### 环境

```text
代码          nyala/main 48f99b1916b829410a55f0586db8edd460c63ba4，加分支 fix/p0-windows-smoke 的工作树改动
上游基线      1.143.0 / 2d0b7506a36c1d6db9a466440131a8e01eab2289
系统          Windows 11 Pro 10.0.26200 x64
Node / npm    24.18.0（nvm-windows 安装并切换，原 shell 为 24.16.0）/ 11.16.0
Electron      43.7.7（npm run electron，按 build/checksums/electron.txt 校验）
C/C++ 工具链   Visual Studio 2026 18.7，平台工具集 v145，MSVC 14.42.34433，Windows SDK 10.0.26100.0
```

### 安装与构建

| 步骤 | 结果 | 说明 |
|---|---|---|
| `nvm install 24.18.0`、`nvm use 24.18.0` | PASS | |
| `npm install`（第 1 次） | FAIL | `@vscode/native-watchdog` 报 `MSB8040`：v145 默认的 MSVC 14.51 没有 Spectre 缓解库，本机只有 14.42 带 `lib/spectre/x64`。 |
| `npm install`（第 2 次，`VCToolsVersion=14.42.34433`） | FAIL | 原生模块编译通过；`@vscode/ripgrep` 的 postinstall 请求 `api.github.com` 得到 403，匿名额度 60/60 已用完。 |
| `npm install`（第 3 次，另加 `GITHUB_TOKEN`） | PASS | 退出码 0，未使用 `--ignore-scripts`；`build/npm/dirs.ts` 所列子目录全部安装，`rg.exe` 落盘。 |
| 原生模块核对 | FAIL → PASS | 第 3 次安装后 `@vscode/sqlite3`、`native-keymap`、`node-pty`、`kerberos`、`native-is-elevated` 没有 `.node`（推测是前两次中断留下的包没有重跑 install 脚本）。对这 5 个包 `npm rebuild` 后全部生成。`@vscode/fs-copyfile` 的 `binding.gyp` 在非 macOS 上是 `type: none`，没有 `.node` 属正常。 |
| `npm run compile` | PASS | 0 errors（client、内置扩展、copilot）。 |
| `npm run electron` | PASS | Electron 43.7.7 下载并通过 checksum。 |
| `node build/lib/preLaunch.ts` | PASS | 从 GitHub 同步 3 个内置扩展（js-debug、js-debug-companion、js-profile-table）。 |

### 静态检查与单元测试

```text
npm run compile                                    PASS（0 errors）
scripts\test.bat --run src/vs/workbench/contrib/nyala/test/browser/nyalaBootstrap.test.ts
                                                   PASS（8 passing，Electron 单测运行器）
ESLint（本分支改动的 3 个文件）                     PASS
node build/hygiene.ts（本分支改动的 3 个文件）      PASS
npm run nyala:validate-product                     PASS
npm run nyala:validate-rpc                         PASS
git diff --check                                   PASS
npm run typecheck-client                           NOT RUN（compile-src 已对 src/tsconfig.json 做类型检查，0 errors）
npm run gulp hygiene（全仓）                       NOT RUN（只改 3 个文件，已做定向 hygiene）
npm run build-fast -- --client-only                NOT RUN
npm run smoketest（上游 smoke 套件）               NOT RUN（需从 GitHub 克隆 vscode-smoketest-express；本次用 Nyala 自有 smoke）
全量单元测试                                       NOT RUN
```

`nyalaBootstrap.test.ts` 覆盖：命令、Command Palette 条目、View 容器与 View 各注册一次；同 ID 的命令、容器、View
重复注册不会产生第二份；`nyala.hello` 连续执行两次各弹一条通知；新建 contributions registry 并以
`ShutdownReason.RELOAD` 模拟 Reload Window 后，状态栏条目被释放、新窗口只重建一个；contribution 重复 Dispose
只释放一次；Connections View 在 Reload 后重建且只有一条占位文本。

### 原生冒烟

```bash
node --experimental-strip-types scripts/nyala/smoke-electron.ts --evidence <不含空格的目录> --reloads 2
```

脚本通过 `scripts\code.bat`（其他平台为 `scripts/code.sh`）启动，使用独立的 `--user-data-dir`、`--extensions-dir`、
`--logsPath`，加 `--disable-gpu` 和 `--remote-debugging-port=9333`，再用 `playwright-core` 经本地 CDP 驱动窗口；
证据目录里有 `result.json`、每步截图和全部日志。所有步骤 PASS 时退出码才为 0。

第 4 次运行（`electron-20261029-220606`）：

| 检查 | 结果 | 观察 |
|---|---|---|
| 窗口标题 | PASS | `Nyala Studio Dev` |
| 状态栏入口 | PASS | 1 个条目，文本 `Nyala`，aria-label `Nyala Studio` |
| `Nyala: Hello Workbench`（连续 2 次） | PASS | Command Palette 中 1 个条目；每次执行都弹出 1 条 `Nyala Studio Workbench is ready.` |
| Nyala Connections View | PASS | `View: Show Nyala Connections` 打开，显示 `Nyala connections will appear here.`，Activity Bar 1 个入口 |
| 空工作区文本编辑 | PASS | 未打开文件夹（Explorer 0 行）；新建无标题文件、切换为 Markdown、输入 2 行文本 |
| Split Editor | PASS | 2 个 editor group |
| 最小 Webview | PASS | 内置图片预览（custom editor webview）打开 `resources/win32/code_150x150.png`，`iframe.webview.ready`，图片按 150x150 渲染 |
| Extension Host 激活 | PASS | renderer.log 有 `Started local extension host with pid …`；exthost.log 记录 12 次 `_doActivateExtension` |
| 内置扩展激活无错误 | FAIL | `vscode.markdown-language-features`：`The language client requires VS Code version ^1.67.0 but received version 0.0.1-dev.0`，见发现 1 |
| Reload Window 第 1 次 | PASS | `Developer: Reload Window` 后新文档恢复；状态栏、Activity Bar、Command Palette 各 1 个 Nyala 条目；Hello 弹 1 条通知；Connections 占位正常 |
| Reload Window 第 2 次 | PASS | 同上 |
| renderer.log 无 Nyala 错误 | PASS | 0 条 |

整体结果：**FAIL（11/12）**。Nyala 自有入口与 Reload 生命周期全部 PASS；唯一的失败项是上游内置扩展与 Nyala
开发版本号不兼容。

运行历史（同一 SHA 与工作树；原始证据留在本机 `%TEMP%\nyala-p0-smoke\`，不入库）：

| 运行 | 结果 | 原因与处理 |
|---|---|---|
| `electron-20261029-213949` | FAIL 2/11 | 5 个原生模块未构建：缺 `vscode-sqlite3.node` 导致存储无法打开，缺 `native-keymap` 导致键盘布局为 null、Ctrl+Shift+P 无响应。rebuild 后重跑。 |
| `electron-20261029-215449` | FAIL 8/11 | 冒烟脚本缺陷：语言选择列表是虚拟列表，不先过滤就找不到 `Markdown`。已修正脚本。 |
| `electron-20261029-215852` | FAIL 10/11 | Markdown 预览打不开，原因即发现 1。Webview 检查改用不依赖语言服务的图片预览，并新增「内置扩展激活无错误」检查，让该问题在每次运行中保持可见。 |
| `electron-20261029-220606` | FAIL 11/12 | 见上表。 |
| `electron-20261030-002545` | PASS 12/12 | 分支 `fix/extension-api-version` 的提交 `6d35da69627`（修复发现 1），见下一小节。 |

### 修复发现 1 后复跑（2026-10-30）

```text
代码          fix/extension-api-version 6d35da69627723e9fd20c8f202eb8a32c1e0b875（基于 fix/p0-windows-smoke 595db6c10f7），工作树干净
构建          npm run compile 0 errors；out/ 由该提交编译
环境          同上（Windows 11 Pro 10.0.26200 x64、Node 24.18.0、npm 11.16.0、Electron 43.7.7）
命令          node --experimental-strip-types scripts/nyala/smoke-electron.ts --evidence %TEMP%\nyala-p0-smoke\electron-20261030-002545 --reloads 2
```

`smoke-electron.ts` 的 12 个步骤全部 PASS，退出码 0。与 11/12 那次相比只有一处变化：「内置扩展激活无错误」
由 FAIL 变为 PASS（0 次激活失败）；exthost.log 记录 14 次 `_doActivateExtension`，其中
`vscode.markdown-language-features` 激活成功，并带起 `vscode.markdown-math` 与 `vscode.mermaid-markdown-features`。
其余 11 步的观察与上表相同。

**整体结果：PASS（12/12）。**

`smoke-electron.ts` 不打开 css/html/json 文件，也不打开 Markdown 预览，所以另用一个临时 CDP 探针（不入库）在同一提交、
同一 `out/` 上补查：打开一个含 `sample.css`、`sample.html`、`sample.json`、`sample.md` 的文件夹，经 Quick Open 逐个打开，
等 exthost.log 出现对应扩展的 `_doActivateExtension` 后再查 `Activating extension … failed`，最后执行
`Markdown: Open Preview to the Side` 并在 webview frame 里读 `h1`。修复前（`595db6c10f7`）与修复后（`6d35da69627`）的结果：

| 检查 | 修复前 | 修复后 |
|---|---|---|
| `vscode.css-language-features` | FAIL（`requires VS Code version ^1.91.0 but received version 0.0.1-dev.0`） | PASS |
| `vscode.html-language-features` | FAIL（同上） | PASS |
| `vscode.json-language-features` | FAIL（同上） | PASS |
| `vscode.markdown-language-features` | FAIL（`^1.67.0`） | PASS |
| Markdown 预览 webview | FAIL（60 秒内没有渲染出标题） | PASS（webview 渲染出 `h1` `Nyala probe`） |
| exthost.log 中的激活失败 | 4 个扩展 | 0 |

### 发现

1. **开发版本号让内置语言功能激活失败（已修复：`fix/extension-api-version` `6d35da69627`，PASS 12/12）。**
   Extension Host 把 `IProductService.version`（`0.0.1-dev.0`）作为 `vscode.version` 交给扩展（`localProcessExtensionHost.ts`）。
   `markdown-language-features` 打包的 `vscode-languageclient` 8.0.2 用 semver 检查 `^1.67.0`，因此激活失败，
   Markdown 预览与语言服务都不可用。`css`/`html`/`json-language-features` 打包的 `vscode-languageclient`
   10.1.1 有同样的检查（`^1.91.0`）；2026-10-30 的探针确认这三个扩展在修复前同样激活失败（见上一小节对照表）。
   产品版本从 P0 起就是 `0.0.1-dev.0`，macOS `1.142.0` 冒烟很可能也有此问题但没有发现（未复核）。
   修复见 [ADR 0003](../docs/adr/0003-extension-api-version.md)：`IProductConfiguration` 新增可选的
   `extensionApiVersion`（`product.json` 与无源回退配置设为 `1.143.0`），三个 Extension Host 报告
   `extensionApiVersion ?? version`；用户可见的产品版本仍是 `0.0.1-dev.0`，`nyala:validate-product` 断言该字段等于
   `nyala/upstream-base.json` 的 `tag`。修复后 css/html/json/markdown 四个语言功能全部激活，Markdown 预览渲染正常。
   仍未覆盖：第三方 VSIX 的 `engines.vscode` 校验依旧使用 `0.0.1-dev.0`（ADR 0003「后果」）；macOS / Linux 未复跑。
2. **禁用的 Chat 在运行时仍然可见，并触发 Microsoft 账户探测（未修复）。** 窗口右侧显示 Chat 视图
   （"Build with Agent"、"Set BYOK utility models"）；内置 `GitHub.copilot-chat` 经
   `onChatParticipant:github.copilot.editsAgent` 激活；`vscode.microsoft-authentication` 经
   `onAuthenticationRequest:microsoft` 激活，MSAL 原生 broker 读取了本机 Windows 账户缓存中的已有账户（所请求
   scope 返回 0 个 session）；renderer.log 有 `copilot-cloud-agent` 的 "Sign in to GitHub" 错误。这与下文「disabled
   Chat 不会触发 Microsoft 账户探测」的结论相反。本次没有做网络出口审计。该日志含个人账户信息，只留在本机证据目录，
   不入库、不引用。
3. **Windows 构建前置条件。** 所用 MSVC 版本必须装有 Spectre 缓解库（VS Installer → 单个组件），或用
   `VCToolsVersion` 指向已装有该库的版本；GitHub 匿名 API 额度用完时，ripgrep 与 Electron 下载需要
   `GITHUB_TOKEN`；安装中断后要核对原生模块的 `.node` 是否生成，缺失时执行 `npm rebuild <包名>`。
4. **数据目录。** 运行中没有写 `~/.vscode-oss-dev`，`--user-data-dir` 生效；但 shared storage 固定写到
   `~/.nyala-studio-shared-dev`，不受 `--user-data-dir` 控制。

## 证据边界

这些结果证明 Bootstrap 主线可编译、可启动且最小 Workbench Contribution 已接入。它们不
证明以下事项：

- Linux 原生启动，以及任何平台的安装卸载、签名、更新和 WSL 完整链路（Windows 只验证了开发态 `scripts\code.bat` 启动）；
- 所有内置扩展、复杂 Webview 权限和多窗口场景（Windows 上只验证了 css/html/json/markdown 语言功能激活与 Markdown 预览，见 Windows 节发现 1）；
- 第三方 VSIX 的 `engines.vscode` 兼容判断：它仍按产品版本 `0.0.1-dev.0` 校验，见 ADR 0003「后果」；
- SQL Runtime、Rust Sidecar、连接驱动、查询执行或结果网格；
- 完整桌面 E2E、上游 smoke 套件和发布包回归（Reload Window 生命周期已有单元测试与 Nyala 原生冒烟覆盖）；
- 上游 Microsoft 服务、Marketplace 或 Copilot 的可再分发授权。
- 产品基线校验只证明 `product.json` 中 disabled Chat 的扩展/供应商 ID 为空；Windows 原生运行时观察到 Chat 视图、
  `GitHub.copilot-chat` 激活和 Microsoft 认证扩展的账户探测（见 Windows 节发现 2），因此**不能**再宣称运行时不会触发
  Microsoft 账户探测。

## 下一步验收

1. ~~为 `Nyala Connections` 增加 Reload/Dispose 自动化测试。~~ 已完成：`nyalaBootstrap.test.ts` 与 `scripts/nyala/smoke-electron.ts`。
2. ~~在目标 Windows 环境完成 `scripts/code.bat`、数据目录隔离和原生启动记录。~~ 已完成开发态启动，见 Windows 1.143.0 节。
3. ~~修复开发版本号导致的内置语言服务激活失败，之后让 `smoke-electron.ts` 的「内置扩展激活无错误」通过。~~ 已完成：`fix/extension-api-version` `6d35da69627`，Windows 原生冒烟 PASS 12/12。
4. 审计并关闭运行时 Chat/Copilot 与 Microsoft 认证入口，补网络出口检查。
5. 在 Linux 与 macOS 上用 `smoke-electron.ts` 复跑 1.143.0 原生冒烟。
6. 在进入 P1 前实现 Rust RPC 合同的半帧、超限、错误和版本不匹配测试。
7. 每次上游升级重新运行本报告中的基础命令与原生冒烟，并更新 [patch ledger](patch-ledger.md)。
