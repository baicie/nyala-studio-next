# 02 · Code OSS 上游同步兼容性与补丁控制

**权威：** 既有 `docs/nyala-kickoff/docs/26-branching-and-upstream-sync.md`、`nyala/upstream-base.json`、`nyala/patch-ledger.md`、`nyala/upstream-compatibility.md`。

## 同步前

1. 从 `nyala/main` 建立 `sync/code-oss-<tag>`，工作树干净；核对上游 Tag 的出处、Release Note、SHA 和 Node/Electron 版本，检查安全更新。
2. 确认旧 Tag 是当前主线祖先，避免被动的历史不一致；建议 `git merge-base --is-ancestor <old-tag> origin/nyala/main`。
3. 先产出 Diff/风险预估：`git diff --name-status <old-tag> origin/nyala/main`，关注已修补上游路径、产品服务字段和 Extension Host。
4. 同步前保存基线 Smoke、包体/启动性能、Patch Ledger 快照；记录 CI 是否真实可运行。

## 执行

```bash
git status --porcelain
git fetch origin
git fetch upstream --tags --prune
git switch nyala/main
git pull --ff-only origin nyala/main
git switch -c sync/code-oss-<tag>
git merge --no-ff <tag>
```

合并后先核实是否真的具有上游祖先：`git merge-base --is-ancestor <tag> HEAD`。若不成立，**不要提交/合并**。GitHub 同步 PR 选择 Create a merge commit，禁止 Squash；如果不能满足则暂停。

## 冲突分级

| 类别 | 例子 | 处理 |
|---|---|---|
| U / Upstream branch drift | 发行分支与新 Tag 的纯微软历史差异 | 核实内容后以新 Tag 为准，记录数量 |
| N / Nyala product patch | product.json、数据目录、Workbench 入口、Linux packaging | 人工三方审查，保留 Nyala 意图并兼容新实现 |
| S / Semantic drift | 无文本冲突但 API/行为/默认服务改变 | 通过测试/静态审计确认，记录新旧语义 |

不要将 PR #14 的 53 个冲突笼统记成“53 个 Nyala 代码冲突”；当时明确有 46 个纯上游差异、7 个含 Nyala 修改。新 PR 必须分别报数。

## 上游补丁预算

- 优先级：Nyala 新目录/Contribution > 官方扩展点 > 最小 Workbench 入口 > 上游 platform/core 修改。
- 每个改动到微软已有文件必须登记：文件、原因、覆盖的产品行为、上游最新状态、验证、移除条件。
- `src/vs/base`、`src/vs/editor`、通用 `src/vs/platform` 默认要 ADR 与跨平台回归；`src/vs/workbench/workbench.common.main.ts` 一行导入仍要在 Ledger。
- 不允许仅为了“保持代码少”而依赖不稳定反射/monkey patch；**低补丁面和架构正确性应同时满足**。
- 不宜每次更新强制缩减 patchCount：升级带来的适配是正常的，但必须说明新增原因与是否能消除旧补丁。

## 回归矩阵

分层 Gate：工具链/依赖 → TS/Rust 静态校验 → Product Identity/External Service → Workbench Boot/Reload/Extension Host/Webview → RPC/SQLite/PG → 平台安装卸载 → 发行签名。无法执行的 Gate 标 `BLOCKED/NOT RUN`，不能合并到发布候选且不可用编译替代原生启动。

## 正常同步频率

遵循既有文档：按开发窗口评估稳定 Tag；SQLite 纵向闭环期间可以冻结非安全版本同步。安全修复单独 backport，避免一次合入过多与当前业务无关的上游 Chat 变化。

## 上游相关文件不要不必要覆盖

保留 `.github/copilot-instructions.md`、`.github/instructions/*`、代码风格、Editor/Workbench 原生机制。新增 Nyala 治理通过独立路径/简短链接引入；**先兼容后重构**。
