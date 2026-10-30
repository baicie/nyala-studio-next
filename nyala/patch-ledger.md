# Nyala P0 Patch Ledger

更新时间：2026-10-29。基线是 Code OSS `1.143.0`，SHA
`2d0b7506a36c1d6db9a466440131a8e01eab2289`（2026-10-29 由 `1.142.0` /
`d956e8a6ac5d904486557eea07e1d6bd62a4d36f` 同步）。此 ledger 只登记产品差异；SQL Runtime、
连接驱动和结果网格尚未进入主线。

## 计数口径

`nyala/upstream-base.json` 的 `patchCount` 为 `46`：44 个已跟踪的上游文件发生修改，另有 2
个 Nyala Workbench 源文件新增。与运行或打包有关的 `build/` 输入也计入补丁数；`docs/`、
`.github/workflows/nyala-ci.yml`、`scripts/nyala/` 和 `nyala/` 元数据不计入该数字，但仍属于
当前工作树，提交前应随变更审阅。

`46` 是治理 PR #15/#16/#17 合并到 `nyala/main` 后的实测值。相对 1.143.0 同步时的 `45`
只增加 1 个：`.github/dependabot.yml`（新增的上游跟踪文件修改）；`AGENTS.md` 与
`.github/pull_request_template.md` 的修改在同步当时已计入 `45`，治理 PR 只在其上追加内容。
后续每次上游同步、或上游跟踪文件的增删改，都要按同一口径重算，并且只在**合并之后**更新，
避免为未合并的 PR 虚增补丁数。

`fix/p0-windows-smoke` 不改变该数字：它修改的是已计入的 Nyala 自有文件 `nyala.contribution.ts`（只加 `export`），
新增的 `src/vs/workbench/contrib/nyala/test/browser/nyalaBootstrap.test.ts` 是 Nyala 自有测试、不是上游跟踪文件，
`scripts/nyala/smoke-electron.ts` 按口径不计入。没有触碰任何上游跟踪文件。

`fix/extension-api-version` 合并后该数字应由 `46` 变为 `50`：新增修改 4 个此前与 `1.143.0` 一致的上游跟踪文件
（`src/vs/base/common/product.ts`、`localProcessExtensionHost.ts`、`remoteExtensionHost.ts`、`webWorkerExtensionHost.ts`）；
`product.json` 与 `src/vs/platform/product/common/product.ts` 已计入，`scripts/nyala/validate-product.ts` 与
`docs/adr/0003-extension-api-version.md` 按口径不计入。按规则在合并之后再改 `upstream-base.json`。

`fix/disabled-chat-runtime`（基于 `fix/extension-api-version`）不再改变该数字：它修改的上游跟踪文件
`product.json`、`src/vs/base/common/product.ts`、`extensionsScannerService.ts` 及其测试、`chatEntitlementService.ts`
都已计入；新增的 `src/vs/workbench/contrib/nyala/test/common/nyalaDisabledChat.test.ts` 是 Nyala 自有测试，
`scripts/nyala/` 按口径不计入。两个 PR 都合并后 `patchCount` 为 `50`。

## 改动清单

| 范围 | 文件 | 目的与风险 | 验证 |
|---|---|---|---|
| 产品身份 | `product.json`、`src/vs/platform/product/common/product.ts` | Nyala 名称、版本、数据目录、协议、平台 ID；默认 Chat/认证/更新相关 URL 置空。风险是未来新增上游产品字段可能重新引入外部服务。 | JSON 解析、产品字段断言、原生窗口标题 |
| 启动与目录 | `src/mainImpl.ts`、`src/vs/platform/environment/**`、`src/vs/workbench/services/environment/**` | 使用 Nyala 数据目录并保持 dev 目录隔离。风险是不同渠道迁移策略尚未定义。 | Electron 启动、目录字段检查 |
| 内置扩展扫描 | `src/vs/platform/extensionManagement/**`、`src/vs/server/node/extensionsScannerService.ts` | 适配 Nyala 数据目录和禁用的自动更新扩展列表。风险是未覆盖完整扩展安装矩阵。 | 定向扩展扫描测试、compile |
| Workbench 入口 | `src/vs/workbench/workbench.common.main.ts` | 只增加 Nyala Contribution 入口。风险集中在上游入口冲突，升级时优先解决。 | compile、原生 Workbench smoke |
| Nyala Contribution | `src/vs/workbench/contrib/nyala/bootstrap/browser/nyala.contribution.ts`（新增） | `nyala.hello`、Command Palette、状态栏和 Connections 容器/命令。生命周期使用 Workbench contribution 与 Disposable。`NyalaStatusContribution` 导出供单元测试注册到独立的 contributions registry。 | 命令执行、状态栏、View 显示；`nyalaBootstrap.test.ts`；Windows 原生冒烟（含 2 次 Reload Window） |
| Connections View | `src/vs/workbench/contrib/nyala/bootstrap/browser/nyalaConnectionsView.ts`（新增） | 只提供占位 View，不连接数据库。 | 原生 View smoke；`nyalaBootstrap.test.ts` 覆盖 Reload 后重建 |
| 品牌/脚本/资源 | `README.md`、`scripts/code.{sh,bat}`、`resources/**`、`build/**`、`eslint.config.js` | CLI、WSL、Web manifest、Linux/Debian/RPM/Snap 元数据、Windows 资源和开发产物品牌同步；移除 Linux 安装脚本添加 Microsoft apt 源的逻辑。风险是实际各平台包尚未构建安装。 | shell/json 检查、hygiene、diff check |
| Debian packaging | `resources/linux/debian/postinst.template`、`resources/linux/debian/templates.template` | 删掉 postinst 中的 Microsoft apt 源注册与签名 key 写入、以及模板里的 `add-microsoft-repo` 问询；保留上游的 symlink/alternatives/mime/desktop 与 Copilot CLI 提示。1.143 同步后不再通过 gulpfile 移除 debconf 模板（旧做法会让新 postinst 的问询变成未注册模板）。 | postinst `bash -n`、模板 marker 计数、hygiene |
| 依赖治理 | `.github/dependabot.yml` | 合并 GitHub Actions 的分组更新（1 个 PR）、并发上限 1、github-actions/devcontainers 改 monthly、npm 由 daily 改 weekly，降低 CI 不可用期间的依赖 PR 噪声。风险是上游同步时该文件产生小冲突，按行保留 Nyala 段即可。 | YAML 解析（ruby/python）、字段断言（groups/limits）、`git diff --check` |
| 扩展 API 版本 | `src/vs/base/common/product.ts`、`src/vs/workbench/services/extensions/electron-browser/localProcessExtensionHost.ts`、`src/vs/workbench/services/extensions/common/remoteExtensionHost.ts`、`src/vs/workbench/services/extensions/browser/webWorkerExtensionHost.ts`、`product.json`、`src/vs/platform/product/common/product.ts` | 新增可选字段 `extensionApiVersion`（= 基线 Tag `1.143.0`），三个 Extension Host 把它作为 `vscode.version` 交给扩展，缺省回退 `version`；产品版本仍为 `0.0.1-dev.0`。修复内置 css/html/json/markdown 语言服务因 `vscode-languageclient` semver 检查而激活失败。风险：每次上游同步必须改为新 Tag（校验脚本强制）；第三方 VSIX 的 `engines.vscode` 校验仍用产品版本。见 [ADR 0003](../docs/adr/0003-extension-api-version.md)。移除条件：产品版本本身满足 `^1.x`，或上游提供独立 API 版本字段。 | `npm run nyala:validate-product`（含 2 个负向对照）、typecheck-client、compile、Windows 原生探针（4 个语言服务激活、Markdown 预览渲染）、`smoke-electron.ts` |
| 依赖元数据 | `package.json`、锁文件、Copilot 元数据 | 版本统一为 `0.0.1-dev.0`，作者和禁用服务配置同步。 | npm metadata、compile |
| 服务边界 | `product.json`、`src/vs/platform/product/common/product.ts`、`src/vs/workbench/services/chat/common/chatEntitlementService.ts` | disabled Chat 使用空扩展/供应商 ID，并在未配置扩展时跳过 entitlement 初始化，避免安装占位扩展。空 ID 本身挡不住内置扩展：见下一行。 | `npm run nyala:validate-product`、typecheck、compile-client |
| 内置 Chat 关闭 | `product.json`（`skipBuiltinExtensions`）、`src/vs/base/common/product.ts`（新增可选字段；该文件已由「扩展 API 版本」一行计入）、`src/vs/platform/extensionManagement/common/extensionsScannerService.ts`、`src/vs/workbench/services/chat/common/chatEntitlementService.ts`；测试 `src/vs/platform/extensionManagement/test/node/extensionsScannerService.test.ts`（已计入），以及 Nyala 自有的 `src/vs/workbench/contrib/nyala/test/common/nyalaDisabledChat.test.ts`（新增，不是上游跟踪文件） | 开发态把 `extensions/` 下每个目录都当作内置扩展扫描，打包的 `GitHub.copilot-chat` 因此加载、注册默认参与者 `github.copilot.editsAgent`，并在启动时经 `getAnyAdoSession` 静默请求 `microsoft` 会话（激活 `vscode.microsoft-authentication`）。上游原本靠 `defaultChatAgent.chatExtensionId` 在未完成 setup 时禁用该扩展，空 ID 让这条保护也失效。修复：产品字段 `skipBuiltinExtensions` 与环境变量 `VSCODE_SKIP_BUILTIN_EXTENSIONS` 语义相同，由扫描器合并处理，开发态与打包态都生效；产品禁用默认 Chat 时 `ChatEntitlementService` 置 `chatSetupHidden=true`，且 `setForceHidden(false)`（账户策略门）不能撤销。风险：上游新增带 Chat 贡献点的内置扩展时，`nyala:validate-product` 会失败，需要把它加进列表。 | `nyala:validate-product`（扫描 `extensions/*/package.json` 的 Chat 贡献点）、定向单测、`typecheck-client`、原生冒烟 |

## 同步记录

| 日期 | 上游 Tag / SHA | 上游增量 | 冲突与处理 | 回归 |
|---|---|---|---|---|
| 2026-10-29 | `1.142.0` `d956e8a6` → `1.143.0` `2d0b7506` | 731 commits / 3431 files | 53 个冲突：46 个纯上游分歧直接取上游版本（我们的差异来自 1.142 发行分支，上游主干已被新实现替代）；7 个含 Nyala 意图手工合并——`package.json`/`package-lock.json`（名称 `nyala-studio-dev`、版本 `0.0.1-dev.0`、两个 nyala 校验脚本）、`extensions/copilot/package.json`+`lock`（engines.vscode 钉在 `^0.0.1-dev.0`）、`.github/workflows/chat-lib-package.yml`（上游已改成 manual-only，Nyala 的分支过滤补丁自然失效，取上游）、debian `postinst.template`/`templates.template`（删 Microsoft apt 段，其余跟上游） | `typecheck-client`、`npm run compile`、`gulp hygiene`、`nyala:validate-product`、`nyala:validate-rpc`、`git diff --check` 全部通过（详见 `nyala/upstream-compatibility.md`） |

同步方法（脚本与产物留在 `sync/code-oss-1.143.0` 分支）：`git merge <tag>` 生成真正的合并提交，
上游全部 731 个提交与历史保持为祖先，不做 squash、不做 rebase。

## 维护规则

后续每次上游同步都应增加一行记录：上游 Tag/SHA、冲突文件、手工处理、回归命令和未覆盖平台。不得把此初始化 patch 当成 SQL 功能或发行签名完成证明。
