# ADR 0005 · 产品禁用默认 Chat 时关闭 Agent Host 启动与拼写词典下载

- 状态：Proposed（分支 `fix/close-runtime-egress`，Draft PR 待审）
- 日期：2026-11-01
- 决策域：运行时出站边界（renderer 的 Agent Host 启用判断、Electron 主进程的 session 配置）
- 上位文档：[`docs/nyala-kickoff/docs/25-engineering-rules.md`](../nyala-kickoff/docs/25-engineering-rules.md)（红线 13、15）、[`docs/nyala-governance/03-architecture-ownership.md`](../nyala-governance/03-architecture-ownership.md)、[`docs/nyala-governance/08-security-privacy.md`](../nyala-governance/08-security-privacy.md)
- 编号说明：`0004` 预留给 N-103 Runtime Supervisor，本 ADR 取 `0005`。

## 背景

PR #26 关闭了运行时 Chat 与 Microsoft 认证之后，Windows 原生冒烟 `scripts/nyala/smoke-electron.ts` 为 FAIL 14/17，剩下的 3 项都是出口检查，来自两条与 Chat 设置无关的路径：

1. **Agent Host。** renderer 的 `AgentHostPrewarmContribution`（`src/vs/workbench/services/agentHost/electron-browser/agentHostService.ts`）在 `IAgentHostEnablementService.enabled` 为 true 时创建 `AgentHostPrewarmer`，后者调用 `startAgentHost()`，经 `vscode:createAgentHostMessageChannel` 请求主进程；主进程的 `AgentHostProcessManager` 随即启动 utility 进程（main.log `AgentHostProcessManager: agent host started`）。连接建立后，renderer 的 Agent Host 认证解析针对 `https://api.github.com` 资源查找登录会话（renderer.log `[AgentHost] No signed-in session resolved for resource`）。`enabled` 只看「不是 Web」和 `chat.disableAIFeatures`，与 `product.json` 的 `defaultChatAgent`、`skipBuiltinExtensions` 都无关。
2. **Hunspell 拼写词典。** Electron 每创建一个 session，`Session` 构造函数就调用 `SpellcheckService::InitializeDictionaries`，按 profile 偏好 `spellcheck.dictionaries` 加载词典；偏好为空时 `ElectronBrowserContext` 先按系统 locale 填入 `en-US`。本地 `Dictionaries/` 没有对应文件时，Chromium（`spellcheck_hunspell_dictionary.cc`）从 `https://redirector.gvt1.com/edgedl/chrome/dict/` 下载。这条路径不读 `webPreferences.spellcheck`，所以主窗口设为 false 也会下载；发起方是 default session 本身，不是某个窗口。

两条路径都违背红线 15（不依赖 Microsoft/Copilot 等专有集成）和「用户数据默认不外发」的出站默认。

## 决策

1. `src/vs/base/common/product.ts` 新增 `hasDefaultChatAgent(product)`：`defaultChatAgent.extensionId` 与 `chatExtensionId` 都非空时返回 true。`ChatEntitlementService` 原有的同义内联判断改用它，行为不变。
2. 桌面窗口与 Agents 窗口共用的 `BrowserAgentHostEnablementService`（`src/vs/platform/agentHost/browser/agentHostEnablementService.ts`）把「运行时可用」从 `!isWeb` 改为 `!isWeb && hasDefaultChatAgent(productService)`。产品禁用默认 Chat 时 `enabled` 恒为 false。
3. `src/mainImpl.ts` 在 `app` 的 `ready` 之前注册 `app.on('session-created', session => session.setSpellCheckerLanguages([]))`。`session-created` 与 `Session` 构造函数在同一个任务中同步触发，而下载要等词典文件定位任务的回调；清空偏好触发 `LoadDictionaries` 重建词典列表，挂起的回调随旧词典对象作废。default session 与之后的 partition（含集成浏览器）都经过这里。
4. `npm run nyala:validate-product` 断言上面两行门控仍在源码中，上游同步若丢掉其中一行，Product baseline 检查失败。

## 影响范围

- **Agent Host。** `agentHostEnabled` 上下文键为 false；编辑器窗口的 Restart/Debug/Profile Local Agent Host 命令不可用；Chat 的 Agent Host contribution（`agentHostChatContribution.ts`）进入未启用分支，清空 Agent、历史与模型提供者注册；远程窗口的 `EditorRemoteAgentHostServiceClient` 不启动 Agent Host（Nyala 未验证远程窗口）。这与用户设置 `chat.disableAIFeatures: true` 时的状态相同。配置了默认 Chat Agent 的产品（上游 VS Code）行为不变。Agents 窗口注册的是同一个服务，因此同样关闭，但 Agents 窗口本身未验证；Profile 命令在 Agents 窗口的前置条件不读该上下文键。Web 版 `WebAgentHostEnablementService` 未改，Nyala 当前不发 Web。
- **拼写检查。** Windows/Linux 上所有 session 不再加载 Hunspell 词典：主窗口本来就关闭拼写检查，集成浏览器失去拼写建议与「Add to Dictionary」。macOS 使用系统拼写检查，不下载词典，`setSpellCheckerLanguages` 在 macOS 上是 no-op（Electron 文档），因此不受影响。已有 profile 的偏好在每次启动时被改写为空列表，之前下载的 `Dictionaries/*.bdic` 应留在磁盘上且不再加载。集成浏览器、macOS 与旧 profile 这三点都是按源码与文档推断，未运行验证；冒烟只验证了全新 profile 的主窗口。

## 未采纳的替代方案

Agent Host：

- **只改 `AgentHostPrewarmContribution`**：`src/` 下另有 22 个非测试文件读取 `IAgentHostEnablementService`（包括远程 Agent Host 客户端、Chat 的 Agent Host contribution、Agents 窗口的 provider），上下文键也仍为 true，命令和 UI 继续认为 Agent Host 可用。
- **在主进程拒绝启动（`AgentHostProcessManager` 或 `app.ts`）**：renderer 仍会请求连接，走启动失败通知与错误日志路径，UI 仍认为可用。
- **把 `chat.disableAIFeatures` 的默认值设为 true**：本仓库没有产品级配置默认值机制；而且这是用户可改的设置，用户改回就会重新启动 Agent Host，不构成产品边界。
- **从 `workbench.desktop.main.ts` 去掉 Agent Host 服务注册**：多个 contribution 依赖这些服务，DI 实例化会失败，补丁面更大。
- **在 `agentHostEnablementService.ts` 内联判断空 ID**：与 `chatEntitlementService.ts` 形成两份可能漂移的判断，单元测试只能覆盖其中一份。

拼写词典：

- **`webPreferences.spellcheck: false`**：主窗口已经是 false，挡不住 session 级加载。
- **`session.setSpellCheckerEnabled(false)`**：只改 `spellcheck.enabled`，`LoadDictionaries` 不读它，仍会下载。
- **`setSpellCheckerDictionaryDownloadURL` 指向回环或空地址**：下载机制仍在，每次启动多一次失败请求和错误日志。
- **放进 `CodeApplication.configureSession`（`src/vs/code/electron-main/app.ts`）**：那时 default session 已由 `ProtocolMainService` 创建，错过 `session-created`，事后再清空与已排队的下载存在竞态。
- **Chromium 命令行开关或 feature**：没有找到 Electron 43 中能阻止 `SpellcheckService` 加载词典的公开开关（未穷尽验证，不采用）。

## 后果

- 上游补丁面：新增修改 1 个上游跟踪文件（`agentHostEnablementService.ts`，4 行）；`src/vs/base/common/product.ts`、`chatEntitlementService.ts`、`src/mainImpl.ts` 已在 Patch Ledger 中。按 `nyala/patch-ledger.md` 的计数口径，合并后 `patchCount` 由 `50` 变为 `51`，在合并之后更新 `nyala/upstream-base.json`。
- 上游同步时，`BrowserAgentHostEnablementService` 构造函数与 `mainImpl.ts` 中 `Menu.setApplicationMenu(null)` 附近可能产生小冲突；`nyala:validate-product` 会发现门控被丢掉，时序问题只能由原生冒烟的出口检查发现。
- 上游若新增不读 `enabled` 就调用 `startAgentHost()` 的入口，Agent Host 会重新启动；原生冒烟的「Agent Host stays stopped」会 FAIL。
- 上游若把首个 session 的创建移到 `mainImpl.ts` 注册监听之前，词典保护失效；原生冒烟的 NetLog 检查会 FAIL。

## 迁移与退出

- 无用户数据迁移。删除这两行即恢复上游行为。
- 若 Nyala 将来提供自己的默认 Chat Agent 或 Agent 运行时（`docs/nyala-kickoff/docs/27-agent-platform.md` 起的设计），需要用新 ADR 重新决定 Agent Host 的启用条件，而不是直接删除本补丁。
- 若需要拼写检查，应随产品打包词典或把 `setSpellCheckerDictionaryDownloadURL` 指向 Nyala 控制的地址，并更新本 ADR。

## 安全与性能

减少两条启动期出站路径；不涉及密钥、权限或数据库。Agent Host utility 进程不再启动，启动内存与 CPU 的变化未测量。

## 验证

- 单元测试：`src/vs/workbench/contrib/nyala/test/common/nyalaDisabledChat.test.ts` 覆盖 `hasDefaultChatAgent` 对已发布产品为 false、两个扩展 ID 都设置时才为 true；上游 `agentHostEnablementService.test.ts` 与 `chatEntitlementService.test.ts` 通过。
- `npm run nyala:validate-product`，以及两个负向对照（分别去掉一行门控后断言失败）。
- `npm run typecheck-client`、定向 ESLint 与 hygiene、`git diff --check`。
- Windows 11 原生开发态 `smoke-electron.ts --reloads 2`：17/17 PASS；两个负向对照分别只去掉一个门控，各自对应的出口检查 FAIL。结果记录在 `nyala/upstream-compatibility.md`「关闭 Agent Host 启动与拼写词典下载」。

## 链接

- `nyala/patch-ledger.md`「Agent Host 关闭」「拼写词典下载关闭」
- `nyala/upstream-compatibility.md` Windows 1.143.0 节
- [ADR 0003](0003-extension-api-version.md)（同属产品配置合同的补丁）
