# Nyala Studio · 项目进度快照

> 快照时间：2026-10-29 · 基线 Code OSS `1.142.0`（`d956e8a6ac5d904486557eea07e1d6bd62a4d36f`）· 开发版本 `0.0.1-dev.0`
> 用途：跨机器移交与断点续做。**状态权威顺序：Git 分支与 PR ＞ 本文档 ＞ 会话记忆**；阶段验收仍以 [19-roadmap.md](docs/19-roadmap.md) 为准。

## 一句话状态

P0 Bootstrap 已完成（macOS 原生启动 + 产品身份 + Hello Workbench + 质量门禁记录），P1 协议的 v1.0 可执行合同已冻结；**Rust SQL Runtime 尚未开始写代码**，P0 清单只剩「Reload Window / 生命周期自动化回归」一项未关闭。

## 分支与 PR

| 分支 | HEAD | 目标 | 状态 |
|---|---|---|---|
| `nyala/main` | `3b17d4e184a` | 稳定主线 | 已合入 #8、#11；#13 合并后即为本文档所在提交 |
| `fix/review-audit-findings` | `a8068687464` | → `nyala/main`（PR #8） | **MERGED**（squash `85eee995045`，2026-10-29） |
| `feat/p1-rpc-contract` | `513a34990ae` | → `nyala/main`（PR #11） | **MERGED**（squash `3b17d4e184a`，2026-10-29） |
| `feat/progress-snapshot` | 本文档 | → `nyala/main`（PR #13） | 随本快照合并 |

> Nyala 版 `AGENTS.md`、`scripts/nyala/validate-product.mjs`、`.github/workflows/nyala-ci.yml`、`product.json` 的 Chat/认证置空改动已随 **PR #8** 进入 `nyala/main`；`nyala/rpc/` 合同随 **PR #11** 进入。

## 已完成

### P0 · Code OSS 基座

- 基线锁定：Code OSS `1.142.0` / SHA / Node `24.18.0` / npm，补丁口径 34 条记录在 [`nyala/upstream-base.json`](../../nyala/upstream-base.json) 与 [`nyala/patch-ledger.md`](../../nyala/patch-ledger.md)。
- 产品身份：`Nyala Studio` / `nyala-studio` / `.nyala-studio` / `nyala://` / `0.0.1-dev.0`。
- macOS 原生 Electron 启动、编辑器、Split、Extension Host、Webview 冒烟通过，见 [`nyala/upstream-compatibility.md`](../../nyala/upstream-compatibility.md)。
- Hello Workbench：`nyala.hello` 命令 + `Nyala Connections` 视图容器 + 状态栏入口，源码在 `src/vs/workbench/contrib/nyala/bootstrap/browser/`。
- 质量门禁：`npm run compile`、`typecheck-client`、`build-fast --client-only`、`gulp hygiene`、定向 ESLint、JSON/脚本检查（同上报告）。
- 文档落位：设计包 `docs/nyala-kickoff/`、`docs/adr/`、`nyala/patch-ledger.md`。

### P1 · 协议合同（已合并，PR #11）

- `nyala/rpc/README.md`：分帧、envelope、版本协商、15 个 v1 方法、状态机、cell 类型、错误模型、限流、变更策略。
- `nyala/rpc/v1/`：envelope + 方法级 params/result JSON Schema、错误码表、一致性样例。
- `npm run nyala:validate-rpc`：分帧半包/粘包/零长度/超限、schema、请求响应配对、sequence 单调、错误码一致、README 与 schema 防漂移、负向对照。
- ADR：`docs/adr/0001-rpc-contract-v1.md`（随 PR #11 引入，合并后才有该文件）。

## 未完成 / 已知缺口

1. **CI 仍然跑不出结果**：三个 PR 的检查全红都是 GitHub 账单问题（`The job was not started because recent account payments have failed or your spending limit needs to be increased`），任务根本没启动，与代码无关；合并后仍需解决，否则后续 PR 都拿不到真实检查。
2. **P0 唯一未勾项**：Reload Window / 生命周期自动化回归（[P0 清单](checklists/P0-FIRST-14-DAYS.md) 第 22 行）。已手工验证首次启动与重复执行，缺自动化。
3. Windows / Linux 原生启动、安装包、签名、更新链路均未验证。
4. Chat / Copilot / 认证入口置空后只做过代码审计，没有系统 UI 回归。
5. Rust Runtime（P1.1–P1.4）未开始；`nyala/rpc` 合同是它的前置条件。
6. 本机 `node_modules` / `out` / `.build` 已清理，恢复需要重新安装与编译（见下）。

## 下一步（建议顺序）

1. ~~合并 PR #8~~ 已完成（2026-10-29）；产品约束、产品校验脚本与 CI 已在 `nyala/main`。
2. 解决 CI 账单（或把 workflow 收窄到 push / self-hosted），并在 `nyala-ci.yml` 增加一行 `npm run nyala:validate-rpc`。
3. 补 P0 生命周期回归：完整安装 + 编译后跑 Electron smoke（命令见下），把结果写回 P0 清单。
4. P1.1：Rust crate + Supervisor + stdio framing，按 `nyala/rpc` 合同实现 hello / health / error。

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

## 目录地图

| 路径 | 作用 |
|---|---|
| `docs/nyala-kickoff/` | 设计包：15 份设计文档 + 路线图/backlog + P0 清单 + 本快照 |
| `docs/adr/` | 架构决策记录（当前 0001：RPC 合同 v1.0） |
| `nyala/` | 产品元数据：upstream-base、patch-ledger、upstream-compatibility、rpc 合同 |
| `scripts/nyala/` | 校验脚本（RPC 合同；产品基线脚本在 PR #8） |
| `src/vs/workbench/contrib/nyala/` | Hello Workbench 贡献与 Connections 占位视图 |

## 移交清理记录（2026-10-28）

- 删除：`out/`、`.build/`、全部 `node_modules/`、`*.tsbuildinfo`、`extensions/*/out|dist`、`.eslintcache`、`.playwright-cli/`、`.claude/`（本地符号链接）。
- 体积：7.3 GB → 1.7 GB（其中 `.git` 1.4 GB，工作树约 300 MB）。
- 回滚了一个未提交的 `cli/Cargo.toml` 本地改动（曾为缩小 target 体积给 `[profile.dev.package."*"]` 与 `[profile.test.package."*"]` 设 `debug = false`）；如仍需要，应作为可追踪补丁重新提交并登记 patch ledger。
- 未提交或未推送的分支：无。
