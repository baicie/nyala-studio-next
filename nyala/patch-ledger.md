# Nyala P0 Patch Ledger

更新时间：2026-10-19。基线是 Code OSS `1.142.0`，SHA
`d956e8a6ac5d904486557eea07e1d6bd62a4d36f`。此 ledger 只登记本次初始化的产品差异；SQL
Runtime、连接驱动和结果网格尚未进入主线。

## 计数口径

`nyala/upstream-base.json` 的 `patchCount` 为 `34`：32 个已跟踪的上游文件发生修改，另有 2
个 Nyala Workbench 源文件新增。与运行或打包有关的 `build/` 输入也计入补丁数；`docs/` 和
`nyala/` 元数据不计入该数字，但仍属于当前工作树，提交前应随变更审阅。

## 改动清单

| 范围 | 文件 | 目的与风险 | 验证 |
|---|---|---|---|
| 产品身份 | `product.json`、`src/vs/platform/product/common/product.ts` | Nyala 名称、版本、数据目录、协议、平台 ID；默认 Chat/认证/更新相关 URL 置空。风险是未来新增上游产品字段可能重新引入外部服务。 | JSON 解析、产品字段断言、原生窗口标题 |
| 启动与目录 | `src/mainImpl.ts`、`src/vs/platform/environment/**`、`src/vs/workbench/services/environment/**` | 使用 Nyala 数据目录并保持 dev 目录隔离。风险是不同渠道迁移策略尚未定义。 | Electron 启动、目录字段检查 |
| 内置扩展扫描 | `src/vs/platform/extensionManagement/**`、`src/vs/server/node/extensionsScannerService.ts` | 适配 Nyala 数据目录和禁用的自动更新扩展列表。风险是未覆盖完整扩展安装矩阵。 | 定向扩展扫描测试、compile |
| Workbench 入口 | `src/vs/workbench/workbench.common.main.ts` | 只增加 Nyala Contribution 入口。风险集中在上游入口冲突，升级时优先解决。 | compile、原生 Workbench smoke |
| Nyala Contribution | `src/vs/workbench/contrib/nyala/bootstrap/browser/nyala.contribution.ts`（新增） | `nyala.hello`、Command Palette、状态栏和 Connections 容器/命令。生命周期使用 Workbench contribution 与 Disposable。 | 命令执行、状态栏、View 显示 |
| Connections View | `src/vs/workbench/contrib/nyala/bootstrap/browser/nyalaConnectionsView.ts`（新增） | 只提供占位 View，不连接数据库。风险为 Reload/Dispose 自动化覆盖不足。 | 原生 View smoke；自动化生命周期测试 pending |
| 品牌/脚本/资源 | `README.md`、`scripts/code.{sh,bat}`、`resources/**`、`build/**`、`eslint.config.js` | CLI、WSL、Web manifest、Linux/Debian/RPM/Snap 元数据、Windows 资源和开发产物品牌同步；移除 Linux 安装脚本添加 Microsoft apt 源的逻辑。风险是实际各平台包尚未构建安装。 | shell/json 检查、hygiene、diff check |
| Debian packaging | `build/gulpfile.vscode.linux.ts` | 不再将已停用更新源配置的 debconf 模板放进 DEBIAN 包，避免留下无效的 Microsoft 仓库选项。 | `node --experimental-strip-types --check`、postinst `bash -n` |
| 依赖元数据 | `package.json`、锁文件、Copilot 元数据 | 版本统一为 `0.0.1-dev.0`，作者和禁用服务配置同步。 | npm metadata、compile |

## 维护规则

后续每次上游同步都应增加一行记录：上游 Tag/SHA、冲突文件、手工处理、回归命令和未覆盖平台。不得把此初始化 patch 当成 SQL 功能或发行签名完成证明。
