# ADR 0003 · 向扩展报告独立的 Extension API 版本

- 状态：Accepted（2026-10-30，随 PR #24 合入 `nyala/main`，squash `52664d3b715`）
- 日期：2026-10-30
- 决策域：产品版本合同（`IProductConfiguration`）与 Extension Host 初始化数据
- 上位文档：[`docs/nyala-governance/11-release-versioning.md`](../nyala-governance/11-release-versioning.md)、[`docs/nyala-kickoff/docs/13-extensions.md`](../nyala-kickoff/docs/13-extensions.md)
- 编号说明：`0002` 已被 `feat/p1-rust-runtime`（PR #25，`docs/adr/0002-rust-runtime-workspace.md`）占用，本 ADR 取 `0003`。

## 背景

Code OSS 的三个 Extension Host（`localProcessExtensionHost.ts`、`remoteExtensionHost.ts`、`webWorkerExtensionHost.ts`）
把 `IProductService.version` 放进 `IExtensionHostInitData.version`，扩展 API 再把它暴露为 `vscode.version`
（`extHost.api.impl.ts`）。Nyala 的产品版本是 `0.0.1-dev.0`，而扩展普遍把 `vscode.version` 当作 Extension API
版本使用。

内置扩展打包的 `vscode-languageclient` 在构造客户端时用 semver 检查 `vscode.version`：markdown 用 8.0.2，要求
`^1.67.0`；css/html/json 用 10.1.1，要求 `^1.91.0`。`0.0.1-dev.0` 不满足任何一个范围。2026-10-30 在 Windows 11
原生开发态运行中逐个打开 css/html/json/md 文件确认：`vscode.css-language-features`、`vscode.html-language-features`、
`vscode.json-language-features`、`vscode.markdown-language-features` 全部激活失败，Markdown 预览打不开。

治理文档 11 要求 Code OSS 上游版本与 Nyala 产品版本分开记录；文档 13 要求 Extension API 版本以 Code OSS Release
固定。代码里此前只有一个版本号，两条要求无法同时满足。

## 决策

1. `IProductConfiguration` 新增可选字段 `extensionApiVersion`（`src/vs/base/common/product.ts`）：向扩展报告为
   `vscode.version` 的版本；缺省时回退到 `version`，上游行为不变。
2. 三个 Extension Host 的 init data 使用 `extensionApiVersion ?? version`。
3. `product.json` 与 `src/vs/platform/product/common/product.ts` 的无源回退配置都设为当前 Code OSS 基线 Tag
   `1.143.0`。
4. `npm run nyala:validate-product` 断言 `product.json` 的 `extensionApiVersion` 等于 `nyala/upstream-base.json` 的
   `tag`，并断言无源回退配置报告同一个值。上游同步只要改了 `tag` 而忘了这个字段，校验就会失败。

用户可见的产品版本保持 `0.0.1-dev.0`：窗口标题、About、Issue Reporter、`package.json`、安装包元数据与
`IProductService.version` 的其他读者都不变。

## 影响范围

改为报告 `1.143.0` 的只有 Extension Host 的 `initData.version`，它有两个读者：

- `vscode.version`（`extHost.api.impl.ts`）：内置与第三方扩展看到 `1.143.0`。在内置扩展源码与其打包依赖中搜到的
  读者是：language client 版本检查；git 扩展的 User-Agent；`vscode-tas-client` 的实验过滤（github/microsoft
  认证与 typescript 扩展打包，Nyala 以 `--disable-experiments` 运行冒烟）；copilot 的若干诊断字符串与前缀判断
  （`-insider`、`1.94`）。这些都不会因此出错。
- `extHostTelemetry.ts` 的 `common.vscodeversion`：Nyala 默认关闭 Telemetry，此字段不外发。

不变的部分：

- 扩展 `engines.vscode` 校验（`extensionValidator.ts`、扩展扫描、安装、Gallery 兼容判断）仍用 `IProductService.version`。
  内置扩展跳过该校验，所以本决策不影响内置扩展；第三方 VSIX 的 `engines.vscode` 校验是另一个问题，见「后果」。
- `extHostMcp.ts` 的 MCP User-Agent 直接读 `product.version`，仍是 `Nyala Studio/0.0.1-dev.0`。
- Web Worker Extension Host 的 NLS URL 仍按 `IProductService.version` 拼接。

## 未采纳的替代方案

- **把产品版本改成 `1.143.x` 或 `1.143.0-nyala.N`**：一次修好所有 semver 检查，但违背治理文档 11 的版本分离，
  用户看到的版本、安装包版本和 Copilot `engines.vscode` 钉值（hygiene 要求等于 `^<package.json version>`）都要跟着变，
  补丁面更大，且把 Nyala 的发版节奏绑到上游。
- **修改或替换内置扩展里的 `vscode-languageclient`**：要改 4 个扩展的依赖或打补丁到 `node_modules`，每次上游同步都会
  再次冲突，也治不了第三方扩展里同样的检查。
- **只在本地 Extension Host 改**：remote 与 web worker 场景会继续报告产品版本，同一扩展在不同宿主上行为不一致。
- **在扩展 API 层（`extHost.api.impl.ts`）覆盖 `vscode.version`**：补丁面相同，但 init data 与 `vscode.version`
  会出现两个值，Telemetry 等读者更难推断。

## 后果

- 上游补丁面：新增修改 4 个上游跟踪文件（`src/vs/base/common/product.ts` 与三个 Extension Host 文件），每处 1–2 行；
  `product.json` 与 `src/vs/platform/product/common/product.ts` 已在 Patch Ledger 中。合并后 `patchCount` 由 46 变为 50。
- 每次 Code OSS 同步都必须把 `extensionApiVersion` 改为新 Tag；`nyala:validate-product` 强制这一点。
- 已知缺口（不在本 ADR 范围）：第三方 VSIX 的 `engines.vscode`（例如 `^1.80.0`）仍按 `0.0.1-dev.0` 校验，会被判为
  不兼容。若要支持本地 VSIX 安装，需要另一个决策让 engine 校验也使用 Extension API 版本，并补安装矩阵测试。

## 迁移与退出

- 无用户数据迁移。字段可选，删除它即恢复上游行为。
- 若将来产品版本本身满足 semver `^1.x`，或上游提供了独立的 API 版本字段，应删除此补丁并回退到上游实现。

## 安全与性能

不涉及权限、密钥或网络调用；没有运行时开销。报告给扩展的版本号不是安全边界。

## 验证

- `npm run nyala:validate-product`，以及两个负向对照（改动 `product.json` 或回退配置中的值后断言失败）。
- `npm run typecheck-client`、`npm run compile`、定向 ESLint 与 hygiene、`git diff --check`。
- Windows 11 原生开发态：逐个打开 css/html/json/md 文件，4 个 `*-language-features` 扩展激活且没有错误，Markdown 预览
  webview 渲染出标题；修复前同一探针 4 个全部失败。
- `scripts/nyala/smoke-electron.ts --reloads 2`，结果记录在 `nyala/upstream-compatibility.md` Windows 1.143.0 节发现 1。

## 链接

- `nyala/patch-ledger.md`「扩展 API 版本」行
- `nyala/upstream-compatibility.md` Windows 1.143.0 节发现 1
- `scripts/nyala/validate-product.ts`
