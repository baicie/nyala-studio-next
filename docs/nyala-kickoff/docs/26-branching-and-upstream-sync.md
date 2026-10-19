# 26 · 分支模型与 Code OSS 同步规则

本文件是 Nyala Studio 的分支和上游同步权威规则。它适用于当前的 `nyala/main` 主线；如果未来把主线一次性重命名为 `main`，必须单独提交迁移 PR，不与 Code OSS 版本同步混在一起。

## 远程仓库

```text
origin    https://github.com/baicie/nyala-studio-next.git  Nyala 产品仓库，可推送
upstream  https://github.com/microsoft/vscode.git          Code OSS 上游，只读
```

`origin` 保存 Nyala 的产品代码、文档和发布分支。`upstream` 只用于读取稳定 Tag、Release Note 和安全修复；不向 `upstream` 推送，也不把 `upstream/main` 当成 Nyala 的开发基线。

首次配置本地上游：

```bash
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream --tags --prune
git remote -v
```

## 分支命名

| 分支 | 来源 | 用途 | 生命周期 |
|---|---|---|---|
| `nyala/main` | 已验证的 Nyala 提交 | 唯一稳定主线和默认合并目标 | 长期保留 |
| `feat/<topic>` | `nyala/main` | 新功能、SQL 垂直切片、Workbench Contribution | 合并后删除 |
| `fix/<topic>` | `nyala/main` | 普通缺陷修复 | 合并后删除 |
| `security/backport-<id>` | `nyala/main` 或对应发布点 | 上游安全修复、Electron/Node 紧急修复 | 合并后删除 |
| `sync/code-oss-<tag>` | `nyala/main` | 将指定 Code OSS Release Tag 合入并验证 | 合并后保留记录、删除分支 |
| `release/<version>` | `nyala/main` | 发布候选、打包、签名和安装验证 | 发布完成后归档 |
| `experiment/<topic>` | 固定基线 | Tauri、瘦身或其他不进入主线的实验 | 时间盒结束后归档 |

分支名不使用 `codex/*`。不要创建第二条长期产品主线，也不要把个人工作分支直接作为发布分支。

## 主线规则

1. `nyala/main` 只接受 Pull Request；本地直接提交后必须通过 PR 合入。
2. 禁止对已推送的 `nyala/main` 强制推送、变基或重写历史。
3. 功能和修复从最新的 `nyala/main` 创建；同步分支也从 `nyala/main` 创建。
4. 每个 PR 只解决一个主题。Code OSS 同步、SQL 功能和无关重构不得放在同一个 PR。
5. 合并前必须通过与变更范围匹配的检查；至少说明未运行的检查和原因。
6. 合并后删除短期分支，但保留 PR、提交和同步报告，保证后续可追溯。

建议在 GitHub 为 `nyala/main` 开启保护：禁止 force push 和删除，要求 PR、至少一名审核者，以及 compile/typecheck/hygiene 等必需检查。保护规则在仓库设置中维护，不能只依赖本文件。

## Code OSS 稳定版本同步

同步使用明确的 Release Tag，不直接跟踪 `upstream/main`。一次同步按以下顺序执行：

```bash
git status
git switch nyala/main
git pull --ff-only origin nyala/main

git fetch upstream --tags --prune
git show-ref --tags <new-tag>
git switch -c sync/code-oss-<new-tag>
git merge --no-ff <new-tag>
```

`<new-tag>` 必须是已经发布并审查过 Release Note 的稳定 Tag，例如 `1.143.0`。合并冲突按以下类别记录：

- 产品身份：`product.json`、数据目录、URI Scheme、平台 ID；
- 构建和发行：`package.json`、锁文件、`build/`、`resources/`、安装模板；
- Workbench 入口：`workbench.common.main.ts` 和 Nyala Contribution 入口；
- 外部服务：Marketplace、同步、认证、更新、Telemetry、Agent/Copilot URL；
- Extension Host、Webview、Electron 和原生依赖；
- 测试、文档和生成产物。

冲突解决后按顺序验证：

```bash
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
npm install
npm run compile
npm run typecheck-client
npm run build-fast -- --client-only
npm run gulp hygiene
git diff --check
```

然后执行 macOS/Windows 目标平台的 Electron smoke、Web smoke 和必要的扩展测试。未能运行的项目必须记录为 `pending`，不能用编译通过替代桌面回归。

同步 PR 必须包含：

- 旧 Tag/SHA 和新 Tag/SHA；
- 冲突文件、解决方式和手工耗时；
- Node/npm/Electron 版本变化；
- 外部服务和内置扩展审计结果；
- 实际执行的命令、平台和结果；
- 回滚点和未覆盖的平台/场景。

同步完成后更新 `nyala/upstream-base.json`、`nyala/patch-ledger.md`、`nyala/upstream-compatibility.md`，以及相关 ADR、Roadmap 或 Backlog 条目。

验证通过后推送同步分支并通过 PR 合入主线：

```bash
git add .
git commit -m "sync: update Code OSS to <new-tag>"
git push -u origin sync/code-oss-<new-tag>
```

PR 合入后：

```bash
git switch nyala/main
git pull --ff-only origin nyala/main
git merge --no-ff sync/code-oss-<new-tag>
git push origin nyala/main
```

## 安全修复和紧急回补

安全修复不等待下一个大版本同步。确认上游提交影响范围后，从当前主线创建：

```bash
git switch nyala/main
git pull --ff-only origin nyala/main
git switch -c security/backport-<upstream-id>
git cherry-pick <upstream-commit>
```

完成定向测试、产品服务审计和兼容性记录后，通过 PR 合入 `nyala/main`。如果回补依赖尚未进入当前基线，先在 `sync/code-oss-<tag>` 完成版本同步，避免在主线手工拼接大量上游提交。

## 同步节奏

- 安全、Electron、Node 和 native dependency 修复：发现后尽快评估，必要时在 3–7 天内回补。
- Code OSS Stable：每月或每 1–2 个稳定版本评估一次；只在验证窗口可用时合入。
- 正在完成 SQLite 垂直闭环时：冻结大版本同步，只合入安全和启动阻断修复。
- 每次发布前：至少完成一次从当前主线到目标上游 Tag 的同步演练。

## 禁止事项

- 不直接把 `upstream/main` 合并到 `nyala/main`。
- 不在 `nyala/main` 上执行大规模 merge、rebase 或 `git reset --hard`。
- 不用复制文件或手工打补丁替代完整 Tag 合并。
- 不把未经验证的同步分支标为可发布版本。
- 不因为同步方便就把 npm 改成 pnpm；当前 Code OSS 构建链固定使用 npm，工具链迁移必须另开实验分支和兼容性报告。
