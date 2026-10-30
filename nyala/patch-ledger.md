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
| 依赖元数据 | `package.json`、锁文件、Copilot 元数据 | 版本统一为 `0.0.1-dev.0`，作者和禁用服务配置同步。 | npm metadata、compile |
| 服务边界 | `product.json`、`src/vs/platform/product/common/product.ts`、`src/vs/workbench/services/chat/common/chatEntitlementService.ts` | disabled Chat 使用空扩展/供应商 ID，并在未配置扩展时跳过 entitlement 初始化，避免安装占位扩展或后台探测 Microsoft 账户。 | `npm run nyala:validate-product`、typecheck、compile-client |

## 同步记录

| 日期 | 上游 Tag / SHA | 上游增量 | 冲突与处理 | 回归 |
|---|---|---|---|---|
| 2026-10-29 | `1.142.0` `d956e8a6` → `1.143.0` `2d0b7506` | 731 commits / 3431 files | 53 个冲突：46 个纯上游分歧直接取上游版本（我们的差异来自 1.142 发行分支，上游主干已被新实现替代）；7 个含 Nyala 意图手工合并——`package.json`/`package-lock.json`（名称 `nyala-studio-dev`、版本 `0.0.1-dev.0`、两个 nyala 校验脚本）、`extensions/copilot/package.json`+`lock`（engines.vscode 钉在 `^0.0.1-dev.0`）、`.github/workflows/chat-lib-package.yml`（上游已改成 manual-only，Nyala 的分支过滤补丁自然失效，取上游）、debian `postinst.template`/`templates.template`（删 Microsoft apt 段，其余跟上游） | `typecheck-client`、`npm run compile`、`gulp hygiene`、`nyala:validate-product`、`nyala:validate-rpc`、`git diff --check` 全部通过（详见 `nyala/upstream-compatibility.md`） |

同步方法（脚本与产物留在 `sync/code-oss-1.143.0` 分支）：`git merge <tag>` 生成真正的合并提交，
上游全部 731 个提交与历史保持为祖先，不做 squash、不做 rebase。

## 维护规则

后续每次上游同步都应增加一行记录：上游 Tag/SHA、冲突文件、手工处理、回归命令和未覆盖平台。不得把此初始化 patch 当成 SQL 功能或发行签名完成证明。
