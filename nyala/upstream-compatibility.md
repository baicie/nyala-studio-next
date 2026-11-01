# Nyala P0 Upstream Compatibility Report

更新时间：2026-11-01。报告覆盖 macOS（`1.142.0`）与 Windows 11（`1.143.0`）原生开发环境。初始化基线为 Code OSS `1.142.0` /
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

### 关闭运行时 Chat 与 Microsoft 认证（2026-10-30）

```text
代码          fix/disabled-chat-runtime edfde8418f26494e903a50248d848e6676484b5e（基于 fix/extension-api-version c6488d318dc）；
              工作树只有 nyala/patch-ledger.md 未提交，不影响运行
构建          out/ 由同一源码转译（node build/next/index.ts transpile）
环境          同上（Windows 11 Pro 10.0.26200 x64、Node 24.18.0、npm 11.16.0、Electron 43.7.7）
命令          node --experimental-strip-types scripts/nyala/smoke-electron.ts --evidence %TEMP%\nyala-p0-smoke\electron-20261030-105353-head --reloads 2
```

审计结论（发现 2 的原因）：

1. 开发态把 `extensions/` 下每个目录都当作内置扩展扫描，`extensions/copilot`（`GitHub.copilot-chat`）因此加载并注册默认
   参与者 `github.copilot.editsAgent`；Chat 视图创建会话时，`chatServiceImpl.activateDefaultAgent` 以
   `onChatParticipant:github.copilot.editsAgent` 激活它。上游在 setup 未完成时靠 `defaultChatAgent.chatExtensionId`
   禁用该扩展（`extensionEnablementService.ensureChatExtensionInitialDisabledState`），PR #8 把 ID 置空后这条保护也失效。
2. 激活 `vscode.microsoft-authentication` 的是 copilot-chat：启动时 `getAnyAdoSession` 以 Azure DevOps scope 静默请求
   `microsoft` 会话。核心的 `chatSetupMicrosoftProbe` 没有运行：`provider.microsoft.id` 为空时它不探测，修复前的日志里
   也没有它请求的 Entra scope。`copilot-cloud-agent` 的 "Sign in to GitHub" 错误同样来自 copilot-chat。
3. Chat 视图的 `when` 是 `!chatSetupHidden || chatPanelParticipantRegistered`。`ChatEntitlementService` 遇到禁用的默认
   Agent 直接返回，没有设置 `chatSetupHidden`；账户策略门在启动约 5 秒内又会调用 `setForceHidden(false)`。

修复见 [patch ledger](patch-ledger.md)「内置 Chat 关闭」：产品字段 `skipBuiltinExtensions` 列出 `GitHub.copilot-chat`，
由扩展扫描器与 `VSCODE_SKIP_BUILTIN_EXTENSIONS` 合并处理；产品禁用默认 Chat 时 `chatSetupHidden` 置为 true，
`setForceHidden(false)` 不能撤销。`nyala:validate-product` 在任何带 Chat 贡献点的内置扩展未列入该字段时失败。

`smoke-electron.ts` 新增 5 项检查，共 17 步：

| 检查 | 结果 | 观察 |
|---|---|---|
| 原有 12 步（标题、状态栏、Hello、Connections、空工作区编辑、Split、Webview、Extension Host、内置扩展激活无错误、2 次 Reload） | PASS | 与上一小节相同；每次 Reload 后也检查 Chat |
| disabled Chat 保持隐藏 | PASS | 启动后、按 `Ctrl+Alt+I` 后、2 次 Reload 后都没有 Chat 视图元素，也没有 "Build with Agent" / "Set BYOK utility models" |
| Copilot Chat 与 Microsoft 认证不激活 | PASS | exthost.log 无 `GitHub.copilot-chat`、`vscode.microsoft-authentication` 的激活；没有 `Microsoft Authentication.log` |
| Agent Host 不启动 | FAIL | main.log 有 1 次 `AgentHostProcessManager: agent host started`，见下 |
| NetLog 无非回环主机 | FAIL | 只有 `redirector.gvt1.com` 与其重定向到的 `*.gvt1-cn.com`，请求 `/edgedl/chrome/dict/en-us-10-1.bdic`，见下 |
| 日志未提到非回环主机 | FAIL | 只有 `api.github.com`，全部来自 renderer.log 的 `[AgentHost] No signed-in session resolved for resource: …` |

整体结果：**FAIL（14/17）**。本任务的验收项（无 Chat 视图；`GitHub.copilot-chat`、`vscode.microsoft-authentication`
不激活）全部 PASS。3 个 FAIL 是新增的出口检查发现的其他路径，本分支没有处理，脚本保留这些检查让问题保持可见：

- **Agent Host 仍会启动（FAIL；2026-11-01 已修复，见下一小节）。** renderer 的 `AgentHostPrewarmContribution` 在
  `IAgentHostEnablementService.enabled`（运行时可用且 `chat.disableAIFeatures` 不为 true）时连接 agent host，主进程随即
  启动 utility 进程；agenthost.log 显示它加载 Copilot SDK、Claude、Codex provider。它不受 `defaultChatAgent` 或
  `skipBuiltinExtensions` 控制。`api.github.com` 只出现在认证解析日志里，不能证明发出了请求。
- **Chromium 拼写词典下载（FAIL；2026-11-01 已修复，见下一小节）。** 主窗口 `webPreferences.spellcheck` 为 false，发起方尚未定位。Electron 在
  Windows/Linux 上默认从 Google CDN 下载 Hunspell 词典；候选修复是为 session 设置词典下载地址或关闭 spellchecker（未验证）。
- **出口检查的边界。** NetLog（`--log-net-log`）只覆盖 Chromium 网络栈；Extension Host、Agent Host 等 Node 进程的请求
  不经过它，只能用日志中的主机名作线索；Node inspector 的帮助链接已在脚本中过滤。没有做系统级抓包。

对照运行（证据留在本机 `%TEMP%\nyala-p0-smoke\`，不入库）：

| 运行 | 代码 | Chat 视图 | copilot-chat / Microsoft 认证 | 外部主机 |
|---|---|---|---|---|
| `electron-20261029-220606` | `595db6c10f7`，修复前 | 显示 | 都激活 | 日志：`api.github.com`、`embeddings.vscode-cdn.net`、`login.microsoftonline.com`（当时没有 NetLog） |
| `electron-20261030-014948-negative` | 只有 `chatSetupHidden` 修复，去掉 `skipBuiltinExtensions` | 显示（copilot-chat 注册了 Chat 参与者） | 都激活 | NetLog：`*.vscode-cdn.net`、词典下载；日志：`api.github.com`、`login.microsoftonline.com` |
| `electron-20261030-090727-no-hidden` | 只有 `skipBuiltinExtensions`，`chatEntitlementService.ts` 回退到 `c6488d318dc` | 显示（核心 Chat 视图 "Build with Agent"） | 都不激活 | NetLog：词典下载；日志：`api.github.com` |
| `electron-20261030-105353-head` | `edfde8418f2`，两项修复都在 | 不显示 | 都不激活 | NetLog：词典下载；日志：`api.github.com` |

两个负向对照说明两项改动都必要：只隐藏 Chat 挡不住 copilot-chat 激活和 Microsoft 认证；只跳过内置扩展挡不住核心
Chat 视图。没有可以删掉的部分。

### 关闭 Agent Host 启动与拼写词典下载（2026-11-01）

```text
代码          fix/close-runtime-egress 0ca317a6394c495db160285cef24bc9984cf63b9（基于 nyala/main 01c953e2c70）；工作树干净
构建          npm install（VCToolsVersion=14.42.34433，GITHUB_TOKEN 来自 gh）、npm run electron、npm run build-fast（冷构建），之后 npm run build-fast -- --client-only
环境          Windows 11 Pro 10.0.26200 x64、Node 24.18.0（只在本会话命令的 PATH 前置；nvm 全局仍为 24.16.0）、npm 11.16.0、Electron 43.7.7
命令          node --experimental-strip-types scripts/nyala/smoke-electron.ts --evidence %TEMP%\nyala-p0-smoke\electron-20261101-133607-commit --reloads 2
```

调用链（详见 [ADR 0005](../docs/adr/0005-disabled-chat-runtime-egress.md) 与 [patch ledger](patch-ledger.md)「Agent Host 关闭」「拼写词典下载关闭」）：

1. **Agent Host。** renderer 的 `AgentHostPrewarmContribution` 在 `IAgentHostEnablementService.enabled` 为 true 时创建 `AgentHostPrewarmer`，后者调用 `startAgentHost()`，经 `vscode:createAgentHostMessageChannel` 让主进程 `AgentHostProcessManager` 启动 utility 进程。`enabled` 只看「不是 Web」与 `chat.disableAIFeatures`。`api.github.com` 来自连接建立后 renderer 的 Agent Host 认证解析。修复：`BrowserAgentHostEnablementService` 的运行时可用条件加上 `hasDefaultChatAgent(productService)`。
2. **拼写词典。** 发起方是 Electron 的 session 本身：`Session` 构造函数调用 `SpellcheckService::InitializeDictionaries`，按 profile 偏好 `spellcheck.dictionaries`（为空时按系统 locale 填 `en-US`）加载 Hunspell 词典，本地没有就从 `redirector.gvt1.com/edgedl/chrome/dict/` 下载。这条路径不读 `webPreferences.spellcheck`。修复：`src/mainImpl.ts` 在 `ready` 之前注册 `app.on('session-created', session => session.setSpellCheckerLanguages([]))`。

`smoke-electron.ts` 17 步全部 PASS，退出码 0。与修复前相比只有 3 项出口检查变化：

| 检查 | 修复前（`electron-20261030-105353-head`，`edfde8418f2`） | 修复后（`electron-20261101-133607-commit`，`0ca317a6394`） |
|---|---|---|
| Agent Host 不启动 | FAIL：main.log 有 1 次 `AgentHostProcessManager: agent host started` | PASS：main.log 没有启动记录；user-data 下没有 `agent-host/`，logs 下没有 `agenthost.log` |
| NetLog 无非回环主机 | FAIL：`redirector.gvt1.com` 重定向到 `*.gvt1-cn.com`，下载 `en-us-10-1.bdic`；NetLog 614 个事件 | PASS：NetLog 13 个事件，0 个 `URL_REQUEST_START_JOB`、0 个 `TCP_CONNECT`；`user-data/Dictionaries/` 不存在；`Preferences` 中 `spellcheck.dictionaries` 为 `[]` |
| 日志未提到非回环主机 | FAIL：`api.github.com` | PASS：27 个日志文件中 0 处 |
| 其余 14 步 | PASS | PASS |

**整体结果：PASS（17/17）。** 同一代码在提交前的工作树上（`electron-20261101-131735-egress`）与带 TCP 采样的复跑（`electron-20261101-134456-fixed`）也都是 17/17。

负向对照：每次只去掉一个门控，重建 `out/` 后复跑，结束后恢复源码（恢复前后 sha256 相同）并重建：

| 运行 | 去掉的门控 | 结果 | 出口观察 |
|---|---|---|---|
| `electron-20261101-132616-no-spellcheck-gate` | `mainImpl.ts` 的 `session-created` 一行 | FAIL 16/17 | 只有「NetLog 无非回环主机」FAIL：`gvt1.com`、`redirector.gvt1.com`、`rr4---sn-ni5eln7l.gvt1-cn.com`（663 个事件、4 次 `TCP_CONNECT`）；`Dictionaries/en-US-10-1.bdic` 落盘；偏好为 `["en-US"]` |
| `electron-20261101-132705-no-agenthost-gate` | `hasDefaultChatAgent(productService)` 条件 | FAIL 15/17 | 「Agent Host 不启动」FAIL（main.log 1 次启动）；「日志未提到非回环主机」FAIL（264 处 `api.github.com`）；NetLog 仍无外部主机，因为 Agent Host 是 Node utility 进程，不经过 Chromium 网络栈 |
| `electron-20261101-134650-no-spellcheck-gate`（带 TCP 采样） | 同第一行 | FAIL 14/17 | NetLog 结果同第一行；另有 2 次 Reload 的 Quick Open 输入框 5 秒内未显示，原因未查明，第一次同配置对照没有出现 |

两个对照说明两处门控各自必要，且各自只关闭自己那条路径。

**Node 进程的出站（NetLog 之外）。** 另用 PowerShell 每 250 ms 采样一次 `Get-NetTCPConnection`，范围是所有 `Nyala Studio.exe` 进程（修复后一次运行共 16 个，含 NetworkService 与多个 NodeService utility 进程，即 Extension Host、共享进程等）：

- 修复后（`electron-20261101-134456-fixed`）：只看到 2 条连接，都是 Playwright 到 CDP 端口 `127.0.0.1:9333`。
- 正向对照（`electron-20261101-134650-no-spellcheck-gate`）：除 CDP 外，NetworkService 有 2 条到 `127.0.0.1:7890` 的连接。本机配置了本地代理 `127.0.0.1:7890`（NetLog 的 `proxy_chain` 也是它），所以 Chromium 的外部请求在 TCP 层表现为到回环代理的连接。采样能看到这类连接，修复后的运行中没有。

**边界。** NetLog 只覆盖 Chromium 网络栈。Node 进程的请求只由两项线索覆盖：日志中的主机名，以及 250 ms 一次的 TCP 采样；采样会漏掉短于采样间隔的连接，看不到 UDP/DNS，也看不到不叫 `Nyala Studio.exe` 的子进程（例如 `git.exe`）。没有做系统级抓包。开发启动器 `scripts\code.bat` 在 Electron 启动前运行 `build/lib/preLaunch.ts`，会从 GitHub 同步 3 个内置扩展（本次运行均为本地已是最新，未下载）；它是 `node.exe` 进程，不属于产品，也不在上述观察范围内。每次冒烟都用全新的 `--user-data-dir`。

未验证的项逐条列出：打包版本 NOT RUN；macOS NOT RUN；Linux NOT RUN；Agents 窗口 NOT RUN（注册的是同一个 enablement 服务，按代码推断同样关闭）；远程窗口 NOT RUN；已经下载过词典的旧 profile NOT RUN（按源码推断 `Dictionaries/*.bdic` 留在磁盘上但不再加载）；系统级抓包 NOT RUN；集成浏览器窗口内的拼写与词典行为 NOT RUN（冒烟没有打开集成浏览器）。

两次运行都出现、与本修复无关的日志错误（未处理）：renderer.log 的 `agentSessionsOutput.log ... already exists`，main.log 的 `vscode-regexp-languagedetection/dist/index.js` `ERR_FILE_NOT_FOUND`。修复前的 `electron-20261030-105353-head` 中各有 1 条，修复后各 1 条。

静态检查与单元测试（同一提交）：

```text
npm run typecheck-client                                         PASS（exit 0）
node test/unit/node/index.js
  --run src/vs/platform/extensionManagement/test/node/extensionsScannerService.test.ts
  --run src/vs/workbench/contrib/nyala/test/common/nyalaDisabledChat.test.ts
                                                                 PASS（40 passing，含新增的 hasDefaultChatAgent 用例）
node test/unit/node/index.js
  --run src/vs/workbench/contrib/chat/test/common/chatEntitlementService.test.ts
                                                                 PASS（25 passing）
scripts\test.bat
  --run src/vs/platform/agentHost/test/browser/agentHostEnablementService.test.ts
  --run src/vs/workbench/contrib/nyala/test/browser/nyalaBootstrap.test.ts
                                                                 PASS（14 passing，Electron 单测运行器）
npm run eslint -- <改动的 6 个 TS 文件>                           PASS
node build/hygiene.ts <改动的文件>                                PASS
npm run nyala:validate-product                                   PASS；两个负向对照（各去掉一行门控）按预期 FAIL
git diff --check                                                 PASS
npm run compile（gulp 全量）                                     NOT RUN（build-fast 转译 + typecheck-client 已覆盖改动；compile 不额外验证本补丁）
npm run gulp hygiene（全仓）                                     NOT RUN（只做改动文件的定向 hygiene）
全量单元测试、上游 smoketest                                      NOT RUN（范围外，见 CI 的 Unit tests (node) 与手动 browser-test job）
```

#### 复审修复（PR #34 审核，2026-11-01）

审核指出 Restart 命令仍能拉起 Agent Host，且单测没有覆盖真正的门控。修复：`ElectronAgentHostStarter.start()` 开头用同一谓词拒绝所有 spawn（见 ADR 0005「决策」第 3 条），新增描述符测试，冒烟的「Agent Host stays stopped」在检查日志前先从页面发 `vscode:restartAgentHost`。

已知限制必须写清楚：这一轮本机验证只覆盖了单元测试、`nyala:validate-product` 与静态检查；**更新后的原生冒烟尚未在本机重跑**（下面标 NOT RUN 的项），结论仍以待 CI 与下一次 Windows 冒烟为准。旧的 17/17 证据（`0ca317a6394`，表格与负向对照见上）不包含 restart 检查与 starter 门控，只代表 renderer 门控和拼写门控。

```text
代码          fix/close-runtime-egress（本小节新增内容尚未提交时的快照；不含 restart 冒烟证据）
单元测试      scripts\test.bat
                --run src/vs/workbench/contrib/nyala/test/browser/nyalaAgentHostEnablement.test.ts
                --run src/vs/workbench/contrib/nyala/test/common/nyalaDisabledChat.test.ts
                                                                 PASS（4 passing，Electron 运行器）
              node test/unit/browser/index.js --browser chromium
                --run src/vs/workbench/contrib/nyala/test/browser/nyalaAgentHostEnablement.test.ts
                                                                 PASS（1 passing，浏览器运行器）
              负向对照：把 out/ 中 agentHostEnablementService.js 的 hasDefaultChatAgent 条件去掉后重跑
                Electron 运行器                                     FAIL（disabledChat: true，预期 false），已还原 out/
nyala:validate-product                                           PASS；新增的 starter 门控断言与另外两条同时生效
原生冒烟（含 restart 检查）                                       NOT RUN（本机未重跑；提交后按原命令在 Windows 上补跑）
starter 门控的冒烟负向对照（去掉 starter 判断、保留 renderer 门控，发 restart IPC）  NOT RUN
typecheck-client / 定向 ESLint / hygiene / git diff --check（本轮新增文件）  NOT RUN（提交前在本机执行）
```

本轮未运行的项按项列出：原生冒烟（17 步，含新的 restart 检查）、starter 门控的冒烟负向对照、重启后的 NetLog 与 TCP 采样、macOS/Linux、打包版本、Agents 窗口、远程窗口、旧 profile 的词典行为。

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
2. **禁用的 Chat 在运行时仍然可见，并触发 Microsoft 账户探测（已修复：`fix/disabled-chat-runtime` `f6f1e2489bb`）。**
   修复前窗口右侧显示 Chat 视图（"Build with Agent"、"Set BYOK utility models"）；内置 `GitHub.copilot-chat` 经
   `onChatParticipant:github.copilot.editsAgent` 激活；`vscode.microsoft-authentication` 经
   `onAuthenticationRequest:microsoft` 激活，MSAL 原生 broker 读取了本机 Windows 账户缓存中的已有账户（所请求
   scope 返回 0 个 session）；renderer.log 有 `copilot-cloud-agent` 的 "Sign in to GitHub" 错误。原因与修复见
   「关闭运行时 Chat 与 Microsoft 认证」一节：修复后 Chat 视图不显示，两个扩展都不激活。同一节新增的出口检查发现
   Agent Host 启动和 Chromium 拼写词典下载两条出站路径（当时 FAIL；2026-11-01 由 `fix/close-runtime-egress` `0ca317a6394`
   修复，见「关闭 Agent Host 启动与拼写词典下载」）。该日志含个人账户信息，只留在本机证据目录，
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
- disabled Chat 的运行时边界：产品基线校验证明 `product.json` 中 disabled Chat 的扩展/供应商 ID 为空，且所有带 Chat
  贡献点的内置扩展都列在 `skipBuiltinExtensions` 中；Windows 开发态原生冒烟（`edfde8418f2`）证明 Chat 视图不显示、
  `GitHub.copilot-chat` 与 `vscode.microsoft-authentication` 不激活。它们**不**证明 Nyala 没有出站连接：Agent Host
  仍会启动、Chromium 会下载拼写词典（均为 FAIL，见「关闭运行时 Chat 与 Microsoft 认证」）；Node 进程的请求不经过
  NetLog，也没有做系统级抓包；打包版本与 macOS / Linux 未验证。
- 开发态启动期的出站（2026-11-01 更新）：`fix/close-runtime-egress` `0ca317a6394` 的 Windows 原生冒烟 17/17 PASS，Agent Host 不启动、NetLog 没有外部请求、日志不提到非回环主机，TCP 采样只看到回环连接（见「关闭 Agent Host 启动与拼写词典下载」）。这只覆盖冒烟脚本走过的操作：没有打开文件夹、没有使用 Git/终端/扩展安装/集成浏览器；Node 进程只有日志与 250 ms TCP 采样两项线索，没有系统级抓包；打包版本、macOS、Linux、Agents 窗口与远程窗口未验证。

## 下一步验收

1. ~~为 `Nyala Connections` 增加 Reload/Dispose 自动化测试。~~ 已完成：`nyalaBootstrap.test.ts` 与 `scripts/nyala/smoke-electron.ts`。
2. ~~在目标 Windows 环境完成 `scripts/code.bat`、数据目录隔离和原生启动记录。~~ 已完成开发态启动，见 Windows 1.143.0 节。
3. ~~修复开发版本号导致的内置语言服务激活失败，之后让 `smoke-electron.ts` 的「内置扩展激活无错误」通过。~~ 已完成：`fix/extension-api-version` `6d35da69627`，Windows 原生冒烟 PASS 12/12。
4. ~~审计并关闭运行时 Chat/Copilot 与 Microsoft 认证入口，补网络出口检查。~~ 已完成：`fix/disabled-chat-runtime`
   `f6f1e2489bb`（修复）与 `edfde8418f2`（冒烟检查）。~~下一步关闭 Agent Host 启动与 Chromium 拼写词典下载，让
   `smoke-electron.ts` 的 3 项出口检查通过。~~ 已完成：`fix/close-runtime-egress` `0ca317a6394`，Windows 原生冒烟 PASS 17/17（[ADR 0005](../docs/adr/0005-disabled-chat-runtime-egress.md)）。
5. 在 Linux 与 macOS 上用 `smoke-electron.ts` 复跑 1.143.0 原生冒烟。
6. 在进入 P1 前实现 Rust RPC 合同的半帧、超限、错误和版本不匹配测试。
7. 每次上游升级重新运行本报告中的基础命令与原生冒烟，并更新 [patch ledger](patch-ledger.md)。
