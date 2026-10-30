# Nyala Studio · 项目进度快照

> 快照时间：2026-10-29 · 基线 Code OSS `1.143.0`（`2d0b7506a36c1d6db9a466440131a8e01eab2289`，2026-10-29 由 `1.142.0` 同步）· 开发版本 `0.0.1-dev.0`
> 用途：跨机器移交与断点续做。**状态权威顺序：Git 分支与 PR ＞ 本文档 ＞ 会话记忆**；阶段验收仍以 [19-roadmap.md](docs/19-roadmap.md) 为准。

## 一句话状态

P0 Bootstrap 已完成（macOS 原生启动 + 产品身份 + Hello Workbench + 质量门禁记录），已同步到 Code OSS `1.143.0`（保留上游完整历史），P1 协议的 v1.0 可执行合同已冻结；**Rust SQL Runtime 尚未开始写代码**，P0 清单只剩「Reload Window / 生命周期自动化回归」一项未关闭。

## 分支与 PR

| 分支 | HEAD | 目标 | 状态 |
|---|---|---|---|
| `nyala/main` | `48f99b1916b`（2026-10-29 更新；原快照为 `13d253ee4a9`） | 稳定主线 | 已合入 #8、#11、#13、#14、#15、#16、#17、#18 |
| `docs/nyala-design-v1.1` | 本次设计修订 | → `nyala/main` | Design v1.1 文档 PR（只改 `docs/nyala-kickoff/`，不含实现） |
| `sync/code-oss-1.143.0` | 合并 `1.143.0` | → `nyala/main` | 同步分支：真正的 merge commit，上游 731 个提交保持为祖先 |
| `fix/review-audit-findings` | `a8068687464` | → `nyala/main`（PR #8） | **MERGED**（squash `85eee995045`，2026-10-29） |
| `feat/p1-rpc-contract` | `513a34990ae` | → `nyala/main`（PR #11） | **MERGED**（squash `3b17d4e184a`，2026-10-29） |
| `feat/progress-snapshot` | 本文档 | → `nyala/main`（PR #13） | 随本快照合并 |

> Nyala 版 `AGENTS.md`、`scripts/nyala/validate-product.ts`、`.github/workflows/nyala-ci.yml`、`product.json` 的 Chat/认证置空改动已随 **PR #8** 进入 `nyala/main`；`nyala/rpc/` 合同随 **PR #11** 进入。

## 已完成

### P0 · Code OSS 基座

- 基线锁定：Code OSS `1.142.0` / SHA / Node `24.18.0` / npm，补丁口径 34 条记录在 [`nyala/upstream-base.json`](../../nyala/upstream-base.json) 与 [`nyala/patch-ledger.md`](../../nyala/patch-ledger.md)。
- 产品身份：`Nyala Studio` / `nyala-studio` / `.nyala-studio` / `nyala://` / `0.0.1-dev.0`。
- macOS 原生 Electron 启动、编辑器、Split、Extension Host、Webview 冒烟通过，见 [`nyala/upstream-compatibility.md`](../../nyala/upstream-compatibility.md)。
- Hello Workbench：`nyala.hello` 命令 + `Nyala Connections` 视图容器 + 状态栏入口，源码在 `src/vs/workbench/contrib/nyala/bootstrap/browser/`。
- 质量门禁：`npm run compile`、`typecheck-client`、`build-fast --client-only`、`gulp hygiene`、定向 ESLint、JSON/脚本检查（同上报告）。
- 文档落位：设计包 `docs/nyala-kickoff/`、`docs/adr/`、`nyala/patch-ledger.md`。

### 上游同步（2026-10-29）

- 基线 `1.142.0` → `1.143.0`（`2d0b7506`），上游增量 731 commits / 3431 files，用 `git merge` 合并，上游历史完整保留。
- 53 个冲突：46 个纯上游分歧取上游，7 个含 Nyala 意图手工合并（`package.json`/lock、copilot engines、chat-lib workflow、debian postinst/templates）。
- 回归：`typecheck-client`、`npm run compile`、`gulp hygiene`、两个 nyala 校验脚本、`git diff --check` 全部通过。
- 细节见 [`nyala/patch-ledger.md`](../../nyala/patch-ledger.md) 的「同步记录」与 [`nyala/upstream-compatibility.md`](../../nyala/upstream-compatibility.md)。

### P1 · 协议合同（已合并，PR #11）

- `nyala/rpc/README.md`：分帧、envelope、版本协商、15 个 v1 方法、状态机、cell 类型、错误模型、限流、变更策略。
- `nyala/rpc/v1/`：envelope + 方法级 params/result JSON Schema、错误码表、一致性样例。
- `npm run nyala:validate-rpc`：分帧半包/粘包/零长度/超限、schema、请求响应配对、sequence 单调、错误码一致、README 与 schema 防漂移、负向对照。
- ADR：`docs/adr/0001-rpc-contract-v1.md`（随 PR #11 引入，合并后才有该文件）。

## 未完成 / 已知缺口

1. **CI 已能真实执行，但 Hygiene 失败**（2026-10-29 晚更新；原记录为 GitHub 账单阻断，任务未启动）：仓库转为公开后 Actions 正常启动，`Product baseline` 与 `Typecheck client` 通过；`Hygiene` 因 `nyala-ci.yml` 没有安装 `build/` 依赖而失败，详见下方表格。
2. **P0 唯一未勾项**：Reload Window / 生命周期自动化回归（[P0 清单](checklists/P0-FIRST-14-DAYS.md) 第 22 行）。已手工验证首次启动与重复执行，缺自动化。
3. Windows / Linux 原生启动、安装包、签名、更新链路均未验证。
4. Chat / Copilot / 认证入口置空后只做过代码审计，没有系统 UI 回归。
5. Rust Runtime（P1.1–P1.4）未开始；`nyala/rpc` 合同是它的前置条件。
6. 本机 `node_modules` / `out` / `.build` 已清理，恢复需要重新安装与编译（见下）。

## 治理与 CI 现状（2026-10-29）

### 已落地

- **治理规范 v1.0**：`docs/nyala-governance/`（16 篇 + INDEX + 5 个 checklist）、3 个 `nyala-*.instructions.md`、`nyala/AGENTS.md`、`src/vs/workbench/contrib/nyala/AGENTS.md`，根 `AGENTS.md` 与 `START-HERE.md` 只做索引追加；见 PR #15。
- **Dependabot 收敛**：github-actions 合并为 1 个分组 PR、三段并发上限 1、github-actions/devcontainers 改 monthly、npm 由 daily 改 weekly；见 PR #16。
- **上游 workflow 降噪**：用 GitHub API 手动停用 8 个在本 fork 无法跑通的 workflow（**不改任何文件**，可逐条恢复）：`pr.yml`、`pr-node-modules.yml`、`codeql.yml`、`telemetry.yml`、`monaco-editor.yml`、`component-fixtures.yml`、`copilot-setup-steps.yml`、`css-order-scan.yml`。
  - 保留：`nyala-ci.yml`（自有门禁）、`chat-lib-package.yml` 与 `chat-perf.yml`（仅手动触发）、`sessions-e2e.yml`（仅手动触发）、`pr-*-test.yml`（仅 `workflow_call`，由已停用的 `pr.yml` 调用）。
  - 恢复单条：`gh api -X PUT repos/baicie/nyala-studio-next/actions/workflows/<workflow-id>/enable`；`gh api repos/baicie/nyala-studio-next/actions/workflows --jq '.workflows[] | "\(.id) \(.state) \(.path)"'` 可查看状态。

### 原 BLOCKED 项（只能由仓库所有者操作；2026-10-29 晚更新）

| 事项 | 原证据（2026-10-29 早） | 当前状态（2026-10-29 晚） | 剩余操作与验收 |
|---|---|---|---|
| GitHub Actions 计费阻断 | Run 注解：`The job was not started because recent account payments have failed or your spending limit needs to be increased`；当天的 Run 全部 `failure`/`queued`，Job 为 0 steps | **已解除**：仓库转为公开后，PR #21 的 [Run 40863715504](https://github.com/baicie/nyala-studio-next/actions/runs/40863715504)（attempt 2）执行了真实 step。`Product baseline` PASS；`Client typecheck and hygiene` 中 `Typecheck client` PASS，`Hygiene` FAIL，`Check diff` 被跳过 | Hygiene 失败原因是 `ERR_MODULE_NOT_FOUND: gulp-merge-json`：该包只在 `build/package.json` 声明，而 `nyala-ci.yml` 只在根目录跑 `npm ci --ignore-scripts`，postinstall 被跳过，`build/` 依赖未安装。这是 workflow 缺陷，不是计费问题，需单独 PR 修复；验收为该 Job 全绿。2026-10-30 更新：修复已提交为 PR #22（run 40870342300 全绿），尚未合入；其余 5 个 PR 已 stack 该 commit，Hygiene 在各自分支上均真实通过。 |
| 分支保护 / rulesets 不可用 | `gh api repos/baicie/nyala-studio-next/branches/nyala/main/protection` 与 `/rulesets` 均 403：`Upgrade to GitHub Pro or make this repository public` | **可配置但未开启**：`/branches/nyala/main/protection` 返回 404 `Branch not protected`，`/rulesets` 返回 `[]` | 由仓库所有者决定是否启用 required PR + required status checks；protection API 返回 200 之前**不宣称仓库已受保护** |

### CODEOWNERS 结论

`.github/CODEOWNERS` 全部指向上游微软员工（`@lszomoru`、`@alexdima` 等）。由于分支保护尚未开启（2026-10-29 起已可配置），该文件既无强制力、也无法真正请求到这些 reviewer，因此**本次不改文件**（避免无意义的上游 patch）。等分支保护开启时，再新增 Nyala 自有 owner 段；在此之前依靠 PR 模板 + 人工审查 + 证据记录。

### 人工门禁替代（分支保护开启前）

1. PR 必须基于最新 `nyala/main`，模板中写明 PASS/FAIL/BLOCKED/NOT RUN。
2. 本地证据至少包含：`git diff --check`、按改动类型选择的最小验证、以及"未运行项及原因"。
3. 同步类 PR 必须保留上游 Tag 祖先，用 Merge Commit 合入；功能 PR 用 Squash。

### 2026-10-30 接手轮状态（全部经 CI 复核）

| PR | 分支 | head | CI run | 结果 |
|---|---|---|---|---|
| #22 | `fix/nyala-ci-hygiene-deps` | `fd138d074c51c6de990676278634ea21f0c871e2` | [40870342300](https://github.com/baicie/nyala-studio-next/actions/runs/40870342300) | 2/2 |
| #23 | `fix/p0-windows-smoke` | `f7cb481013a5ceb981bb3ab2221391519f5d36b1` | [40999566128](https://github.com/baicie/nyala-studio-next/actions/runs/40999566128) | 2/2 |
| #24 | `fix/extension-api-version` | `38a8b4910b225773b2e0cfc86333d831149a0a93` | [41000130664](https://github.com/baicie/nyala-studio-next/actions/runs/41000130664) | 2/2 |
| #25 | `feat/p1-rust-runtime` | `d6050e7505fc9eb9723a95ba0a7849382dbd06e8` | [40999226065](https://github.com/baicie/nyala-studio-next/actions/runs/40999226065) | 3/3（含 Rust runtime） |
| #26 | `fix/disabled-chat-runtime` | `12f5c3fd0e992dd16ff9eab04ba820c3f94c5010` | [41000542635](https://github.com/baicie/nyala-studio-next/actions/runs/41000542635) | 2/2 |
| #21 | `docs/nyala-design-v1.1` | `ceac606c0a6ff026b99c06c0a343c3525df222a5` | [40999456736](https://github.com/baicie/nyala-studio-next/actions/runs/40999456736) | 2/2 |

- 合并顺序（已用 `git merge-tree` 演练）：`#22 → #23 → #24 → #26 → #25 → #21`；前四步无冲突，#25 与 #21 各只需手解 `docs/nyala-kickoff/PROGRESS.md`。
- 合并前需让各分支先跟上 `nyala/main` 再 squash（堆叠链固有代价）；合并方式与是否合并由仓库所有者决定，PR #21 描述中保留「请勿自动合并」约束直到所有者明确授权。

## 下一步（建议顺序）

1. ~~合并 PR #8~~ 已完成（2026-10-29）；产品约束、产品校验脚本与 CI 已在 `nyala/main`。
2. ~~解决 CI 账单~~ 已解除（2026-10-29，仓库转为公开）；剩下的是修 `nyala-ci.yml` 的 `build/` 依赖安装，让 Hygiene 能跑通。~~在 `nyala-ci.yml` 增加 `npm run nyala:validate-rpc`~~ 已存在（`.github/workflows/nyala-ci.yml` 第 39 行，2026-10-29 核对）。
2026-10-30：workflow 修复已作为 PR #22 提交并在其分支上全绿（run 40870342300），待合入；#23/#24/#25/#26/#21 已各自 stack 该 commit 并全部转绿，当前均处于「CI 全绿、待合并」的 Draft 状态。
3. 补 P0 生命周期回归：完整安装 + 编译后跑 Electron smoke（命令见下），把结果写回 P0 清单。
4. P1.1：Rust crate + Supervisor + stdio framing，按 `nyala/rpc` 合同实现 hello / health / error。

> Design v1.1（2026-10-29）只修订设计文档：新增 Agent 专题 [27](docs/27-agent-platform.md)–[30](docs/30-agent-security-evaluation.md)、[31 SQL Workspace](docs/31-sql-workspace-product.md)、Proposed [ADR-0007](docs/adr/0007-sql-first-task-first-workspace.md)/[0008](docs/adr/0008-optional-codex-app-server-adapter.md)，并在 [19](docs/19-roadmap.md)/[20](docs/20-backlog.md) 增加 N-R*（基线收尾）与 N-A*（Agent 延后轨道）。Agent 相关内容均**未实现**，不改变上面的下一步顺序；变更明细见 [DESIGN-CHANGELOG-v1.1](DESIGN-CHANGELOG-v1.1.md)。

## 新机器恢复步骤（macOS / Linux）

```bash
git clone https://github.com/baicie/nyala-studio-next.git
cd nyala-studio-next
git fetch --all              # 三个分支都要看，PR 分支不在 main 上
git switch nyala/main        # 或切到 fix/review-audit-findings、feat/p1-rpc-contract
nvm use                      # .nvmrc = 24.18.0
npm install
npm run compile
npm run nyala:validate-rpc   # 纯 Node，无依赖，可先跑
./scripts/code.sh            # 首次会准备 .build/electron
```

- `npm run compile` 生成 `out/`；`./scripts/code.sh` 负责 Electron 下载与启动。
- Rust 侧当前只需 `cargo`（本机验证 `cargo 1.96.0` 可用）；`cli/` 是上游 CLI 资源，不含 Nyala Runtime。
- 校验基线：`npm run compile`、`npm run typecheck-client`、`npm run build-fast -- --client-only`、`npm run gulp hygiene`、定向 ESLint、`git diff --check`。

- 本机（Windows）git-lfs smudge 不可用：`git worktree add` 新检出会在 `extensions/copilot/test/simulation/cache/base.sqlite` 报 `smudge filter lfs failed`。需要新 worktree 前先安装并初始化 git-lfs。

## 目录地图

| 路径 | 作用 |
|---|---|
| `docs/nyala-kickoff/` | 设计包：`docs/01`–`31` 设计文档（含路线图/backlog、Agent 专题）+ ADR 0001–0008 + P0 清单 + 本快照 |
| `docs/adr/` | 架构决策记录（当前 0001：RPC 合同 v1.0） |
| `nyala/` | 产品元数据：upstream-base、patch-ledger、upstream-compatibility、rpc 合同 |
| `scripts/nyala/` | 校验脚本（RPC 合同；产品基线脚本在 PR #8） |
| `src/vs/workbench/contrib/nyala/` | Hello Workbench 贡献与 Connections 占位视图 |

## 移交清理记录（2026-10-28）

- 删除：`out/`、`.build/`、全部 `node_modules/`、`*.tsbuildinfo`、`extensions/*/out|dist`、`.eslintcache`、`.playwright-cli/`、`.claude/`（本地符号链接）。
- 体积：7.3 GB → 1.7 GB（其中 `.git` 1.4 GB，工作树约 300 MB）。
- 回滚了一个未提交的 `cli/Cargo.toml` 本地改动（曾为缩小 target 体积给 `[profile.dev.package."*"]` 与 `[profile.test.package."*"]` 设 `debug = false`）；如仍需要，应作为可追踪补丁重新提交并登记 patch ledger。
- 未提交或未推送的分支：无。
