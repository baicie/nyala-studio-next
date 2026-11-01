# ADR 0005 · 产品禁用默认 Chat 时关闭 Agent Host 启动与拼写词典下载

- 状态：Proposed（分支 `fix/close-runtime-egress`，Draft PR 待审）
- 日期：2026-11-01
- 决策域：运行时出站边界（renderer 的 Agent Host 启用判断、主进程的 Agent Host 进程启动、Electron 主进程的 session 配置）
- 上位文档：[`docs/nyala-kickoff/docs/25-engineering-rules.md`](../nyala-kickoff/docs/25-engineering-rules.md)（红线 13、15）、[`docs/nyala-governance/03-architecture-ownership.md`](../nyala-governance/03-architecture-ownership.md)、[`docs/nyala-governance/08-security-privacy.md`](../nyala-governance/08-security-privacy.md)
- 编号说明：`0004` 预留给 N-103 Runtime Supervisor，本 ADR 取 `0005`。

## 背景

PR #26 关闭了运行时 Chat 与 Microsoft 认证之后，Windows 原生冒烟 `scripts/nyala/smoke-electron.ts` 为 FAIL 14/17，剩下的 3 项都是出口检查，来自两条与 Chat 设置无关的路径：

1. **Agent Host。** renderer 的 `AgentHostPrewarmContribution`（`src/vs/workbench/services/agentHost/electron-browser/agentHostService.ts`）在 `IAgentHostEnablementService.enabled` 为 true 时创建 `AgentHostPrewarmer`，后者调用 `startAgentHost()`，经 `vscode:createAgentHostMessageChannel` 请求主进程；主进程的 `AgentHostProcessManager` 随即启动 utility 进程（main.log `AgentHostProcessManager: agent host started`）。连接建立后，renderer 的 Agent Host 认证解析针对 `https://api.github.com` 资源查找登录会话（renderer.log `[AgentHost] No signed-in session resolved for resource`）。`enabled` 只看「不是 Web」和 `chat.disableAIFeatures`，与 `product.json` 的 `defaultChatAgent`、`skipBuiltinExtensions` 都无关。置 false 只挡住这一条请求：主进程还有三个不读它的 `spawn` 入口——`vscode:restartAgentHost`（`restartAgentHost()` 发送，`AgentHostProcessManager.restart()` 无条件 `_start()`）、企业 OTel 策略变化（`AgentHostOTelPolicyState.update()` 返回 true 时经 `_onRequestRestart` 触发同一条 `restart()`，前提是宿主已在运行）、以及 `app.ts` 在 `VSCODE_GENERATE_NODE_COMPILE_CACHE=1` 或 `VSCODE_MEASURE_NODE_COMPILE_CACHE=1` 时调用的 `agentHostProcessManager.start()`。三者最终都经过 `ElectronAgentHostStarter.start()`。
2. **Hunspell 拼写词典。** Electron 每创建一个 session，`Session` 构造函数就调用 `SpellcheckService::InitializeDictionaries`，按 profile 偏好 `spellcheck.dictionaries` 加载词典；偏好为空时 `ElectronBrowserContext` 先按系统 locale 填入 `en-US`。本地 `Dictionaries/` 没有对应文件时，Chromium（`spellcheck_hunspell_dictionary.cc`）从 `https://redirector.gvt1.com/edgedl/chrome/dict/` 下载。这条路径不读 `webPreferences.spellcheck`，所以主窗口设为 false 也会下载；发起方是 default session 本身，不是某个窗口。

两条路径都违背红线 15（不依赖 Microsoft/Copilot 等专有集成）和「用户数据默认不外发」的出站默认。

## 决策

1. `src/vs/base/common/product.ts` 新增 `hasDefaultChatAgent(product)`：`defaultChatAgent.extensionId` 与 `chatExtensionId` 都非空时返回 true。`ChatEntitlementService` 原有的同义内联判断改用它，行为不变。
2. 桌面窗口与 Agents 窗口共用的 `BrowserAgentHostEnablementService`（`src/vs/platform/agentHost/browser/agentHostEnablementService.ts`）把「运行时可用」从 `!isWeb` 改为 `!isWeb && hasDefaultChatAgent(productService)`。产品禁用默认 Chat 时 `enabled` 恒为 false。
3. 主进程的 `ElectronAgentHostStarter`（`src/vs/platform/agentHost/electron-main/electronAgentHostStarter.ts`）增加 `IProductService` 构造参数，并在 `start()` 开头用同一谓词拒绝启动。所有 spawn 都经过 `start()`——窗口连接、`vscode:restartAgentHost` 触发的 `restart()`、企业 OTel 策略触发的 `_onRequestRestart`、以及 `app.ts` 的编译缓存启动——所以这一处同时覆盖 renderer 之外的三条入口。抛出的是 `new AgentHostStartError(..., true)`（fatal）而不是普通 `Error`：`AgentHostProcessManager._start()` 的 catch 只记录 `failed to start agent host` 并重新抛出，`restart()` 与 `_onRequestRestart` 的处理函数把它降到日志级；但 `app.ts` 在 `ready` 之前 `await` 的 `agentHostProcessManager.start()` 会把 fatal 错误抛给 `main.ts` 的 `quit()`，因此在编译缓存模式下进程会报错退出，而不是继续运行一个没有 Agent Host 的窗口。`app.ts:807-813` 在 `VSCODE_GENERATE_NODE_COMPILE_CACHE=1` 或 `VSCODE_MEASURE_NODE_COMPILE_CACHE=1` 时无条件调用 `agentHostProcessManager.start()`；Nyala 的 `product.json` 没有 `quality`，`shouldGenerateNodeCompileCache()` 为 false（`build/lib/nodeCompileCache.ts`），打包流程不会设置它，`VSCODE_MEASURE_NODE_COMPILE_CACHE` 在仓库内也没有设置者，外部设置时会在启动阶段失败而不是静默启动宿主。
4. `src/mainImpl.ts` 在 `app` 的 `ready` 之前注册 `app.on('session-created', session => session.setSpellCheckerLanguages([]))`。`session-created` 与 `Session` 构造函数在同一个任务中同步触发，而下载要等词典文件定位任务的回调；清空偏好触发 `LoadDictionaries` 重建词典列表，挂起的回调随旧词典对象作废。default session 与之后的 partition（含集成浏览器）都经过这里。
5. `npm run nyala:validate-product` 断言上面三处门控仍在源码中，上游同步若丢掉其中一处，Product baseline 检查失败。

## 影响范围

- **Agent Host。** `agentHostEnabled` 上下文键为 false；编辑器窗口的 Restart/Debug/Profile Local Agent Host 命令不可用；Chat 的 Agent Host contribution（`agentHostChatContribution.ts`）进入未启用分支，清空 Agent、历史与模型提供者注册；远程窗口的 `EditorRemoteAgentHostServiceClient` 不启动 Agent Host（Nyala 未验证远程窗口）。这与用户设置 `chat.disableAIFeatures: true` 时的状态相同。配置了默认 Chat Agent 的产品（上游 VS Code）行为不变。Agents 窗口注册的是同一个服务，因此同样关闭，但 Agents 窗口本身未验证；Profile 命令在 Agents 窗口的前置条件不读该上下文键。Web 版 `WebAgentHostEnablementService` 未改，Nyala 当前不发 Web。
- **主进程的其余入口。** `vscode:restartAgentHost` 由 `ElectronAgentHostStarter` 的监听器接住并触发 `restart()`，`_start()` → `start()` 直接抛出，于是 `_onRequestRestart` 的处理函数记录 `AgentHostProcessManager: failed to restart agent host`，不产生 utility 进程；企业 OTel 策略这条同样只走到失败日志。窗口连接请求（`vscode:createAgentHostMessageChannel`）会收到带 `fatal: true` 的错误响应，renderer 的 `AgentHostPrewarmer` 放弃这次预启动。编译缓存模式下整个应用在启动阶段退出（见「决策」第 3 条）。
- **`missionControlSharingService.ts:292` 的 `startAgentHost()`。** `MissionControlSharingService._configure()` 在开头检查 `!this._enabled || !this._usesMissionControl() || this._entitlement.sentiment.hidden`，任一成立就直接返回；`_enabled` 初值要求 `_usesMissionControl()`，另一个入口 `setEnabled(true)` 也先检查同一个 `sentiment.hidden`。`sentiment.hidden` 读的是 `chatSetupHidden` 上下文键，PR #26 起 `ChatEntitlementService` 在 `hasDefaultChatAgent` 为 false 时把它设为 true 并直接返回，账户策略门 `setForceHidden(false)` 也撤销不了。因此这条调用在 Nyala 中不会执行；即使执行，也只会在 renderer 请求连接，最终被主进程门控拒绝。远程窗口的 `EditorRemoteAgentHostServiceClient.startAgentHost()` 读 `enabled`，由第 2 条决策关闭。
- **拼写检查。** Windows/Linux 上所有 session 不再加载 Hunspell 词典：主窗口本来就关闭拼写检查，集成浏览器失去拼写建议与「Add to Dictionary」。macOS 使用系统拼写检查，不下载词典，`setSpellCheckerLanguages` 在 macOS 上是 no-op（Electron 文档），因此不受影响。已有 profile 的偏好在每次启动时被改写为空列表，之前下载的 `Dictionaries/*.bdic` 应留在磁盘上且不再加载。集成浏览器、macOS 与旧 profile 这三点都是按源码与文档推断，未运行验证；冒烟只验证了全新 profile 的主窗口。

## 未采纳的替代方案

Agent Host：

- **只改 `AgentHostPrewarmContribution`**：`src/` 下另有 22 个非测试文件读取 `IAgentHostEnablementService`（包括远程 Agent Host 客户端、Chat 的 Agent Host contribution、Agents 窗口的 provider），上下文键也仍为 true，命令和 UI 继续认为 Agent Host 可用。
- **只在主进程拒绝启动、不改 renderer 门控**：renderer 仍会请求连接，UI 仍认为可用，每次预启动都要走一遍失败日志与错误通知；本 ADR 仍然保留 renderer 门控，主进程门控是第二层，不替代它。
- **只让 `AgentHostProcessManager.restart()` 拒绝**：restart 是 `_start()` 的四个入口之一，单改它挡不住 `app.ts` 的 `start()` 与窗口连接；而且要判断「产品是否禁用 Chat」就得把 `IProductService` 注入 manager，等于把门控放在更深、更难被 `nyala:validate-product` 断言的位置。放在 starter 里，所有入口共用同一判断。
- **只在 renderer 的 `restartAgentHost()` 里判断**：主进程的 `vscode:restartAgentHost` 监听器来自任何窗口的任意 IPC，renderer 侧的检查只是约定，不能构成主进程边界；OTel 策略变化与编译缓存两条也不经过它。
- **改 `src/vs/code/electron-main/app.ts`（在 `createInstance` 附近加条件，或把 `agentHostProcessManager.start()` 包起来）**：分支 `fix/…` 与 PR #35 在该文件约 780 行附近改动重叠，合并顺序会把冲突推到别人身上；`app.ts` 已在 Patch Ledger 中，但那个文件与 Agent Host 的启动策略耦合最松，改它反而把补丁铺得更宽。
- **上游子类覆盖模式**：在 `workbench.desktop.main.ts`、`sessions.desktop.main.ts` 里用 Nyala 子类替换 `registerSingleton(IAgentHostEnablementService, …)` 与 starter 工厂。这两个文件此前与 `1.143.0` 一致，改动即 +2；还要新增 `src/` 下的非测试源文件（子类本身，每个 +1），所以补丁面至少是 +2 个上游文件加新增源文件，大于本方案的两个上游文件各改一处；而且上游改构造参数签名时子类会静默漂移。否决。
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

- 上游补丁面：新增修改 2 个此前与 `1.143.0` 一致的上游跟踪文件——`agentHostEnablementService.ts`（+5/−1）与 `electronAgentHostStarter.ts`（+8/−0）；`src/vs/base/common/product.ts`、`chatEntitlementService.ts`、`src/mainImpl.ts` 已在 Patch Ledger 中（+0）；没有新增 `src/` 下的非测试源文件。按 `nyala/patch-ledger.md` 的计数口径，合并后 `patchCount` 由 `50` 变为 `52`，在合并之后更新 `nyala/upstream-base.json`。
- 上游同步时，`BrowserAgentHostEnablementService` 构造函数、`ElectronAgentHostStarter` 的构造函数与 `start()` 开头、以及 `mainImpl.ts` 中 `Menu.setApplicationMenu(null)` 附近可能产生小冲突；`nyala:validate-product` 会发现门控被丢掉，时序问题只能由原生冒烟的出口检查发现。
- 上游若新增不经过 `ElectronAgentHostStarter.start()` 的启动方式（例如另一个 starter 或直接 `UtilityProcess`），主进程门控不覆盖；renderer 门控仍挡住自己的请求，原生冒烟的「Agent Host stays stopped」会 FAIL。
- 上游若在 renderer 新增不读 `enabled` 就调用 `startAgentHost()` 的入口（`missionControlSharingService.ts:292` 是现有一例），主进程门控会让这次请求失败而不是启动；smoke 在同一一步里通过 IPC 触发 restart，覆盖了这条路径，但不覆盖新的 renderer 入口。
- 上游若把首个 session 的创建移到 `mainImpl.ts` 注册监听之前，词典保护失效；原生冒烟的 NetLog 检查会 FAIL。

## 迁移与退出

- 无用户数据迁移。完整回滚：删除 `src/vs/base/common/product.ts` 的 `hasDefaultChatAgent`；`chatEntitlementService.ts` 删掉该 import，第 456 行恢复为内联的 `!productService.defaultChatAgent?.extensionId || !productService.defaultChatAgent.chatExtensionId` 判断；`agentHostEnablementService.ts` 删掉 `hasDefaultChatAgent` 与 `IProductService` 两个 import、构造函数里的 `@IProductService productService` 参数，`super` 的第一个实参改回 `!isWeb`；`electronAgentHostStarter.ts` 删掉同样两个 import、构造函数里的 `@IProductService private readonly _productService` 参数与 `start()` 开头的判断；`src/mainImpl.ts` 删掉 `session-created` 一行；`scripts/nyala/validate-product.ts` 删掉三条门控断言。恢复后与新 ADR 一起撤销本文件。
- 若 Nyala 将来提供自己的默认 Chat Agent 或 Agent 运行时（`docs/nyala-kickoff/docs/27-agent-platform.md` 起的设计），需要用新 ADR 重新决定 Agent Host 的启用条件，而不是直接删除本补丁。
- 若需要拼写检查，应随产品打包词典或把 `setSpellCheckerDictionaryDownloadURL` 指向 Nyala 控制的地址，并更新本 ADR。

## 安全与性能

减少两条启动期出站路径；不涉及密钥、权限或数据库。Agent Host utility 进程不再启动，启动内存与 CPU 的变化未测量。

## 验证

- 单元测试：`src/vs/workbench/contrib/nyala/test/common/nyalaDisabledChat.test.ts` 覆盖 `hasDefaultChatAgent` 对已发布产品为 false、两个扩展 ID 都设置时才为 true；`src/vs/workbench/contrib/nyala/test/browser/nyalaAgentHostEnablement.test.ts` 从 `getSingletonServiceDescriptors()` 取出桌面工作台注册的 `IAgentHostEnablementService` 描述符，用空 ID 的产品服务实例化，断言 `enabled.get() === false`——覆盖的是真正的门控，而不是谓词本身。两个 Nyala 测试都在 Electron 运行器与浏览器运行器中通过；去掉 `agentHostEnablementService.ts` 的门控后，描述符测试按预期失败（负向对照）。上游自带的 `agentHostEnablementService.test.ts` 直接构造基类并传入 `runtimeAvailable`，不覆盖本产品的门控，不作为证据。
- `npm run nyala:validate-product`，以及三个负向对照（分别去掉一处门控后断言失败）。
- `npm run typecheck-client`、定向 ESLint 与 hygiene、`git diff --check`。
- Windows 11 原生开发态 `smoke-electron.ts --reloads 2`：17/17 PASS。其中的「Agent Host stays stopped」在检查日志前先从页面发送 `vscode:restartAgentHost`，并等待 main.log 出现 `failed to restart agent host`，因此覆盖了「Restart Local Agent Host 拉起 Agent Host」这条路径。负向对照分别去掉一处 renderer 或拼写门控，各自对应的出口检查 FAIL；去掉 starter 门控但保留 renderer 门控时，同一 IPC 会记录 `agent host started` 并使该步 FAIL。结果记录在 `nyala/upstream-compatibility.md`「关闭 Agent Host 启动与拼写词典下载」。

## 链接

- `nyala/patch-ledger.md`「计数口径」中 `fix/close-runtime-egress` 一段，以及「Agent Host 关闭」「拼写词典下载关闭」两行
- `nyala/upstream-compatibility.md` Windows 1.143.0 节
- [ADR 0003](0003-extension-api-version.md)（同属产品配置合同的补丁）
