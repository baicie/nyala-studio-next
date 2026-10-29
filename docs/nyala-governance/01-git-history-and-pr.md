# 01 · Git 提交、PR、分支与历史可读性

**权威引用：** `docs/nyala-kickoff/docs/26-branching-and-upstream-sync.md`。此文只补充审查与提交习惯。

## 主线策略

- `nyala/main`：唯一长期产品主线，保留历史，不 force push、不 rebase、不 reset，不在本地绕过 PR 直接推送。
- `feat/<topic>`、`fix/<topic>`、`docs/<topic>`（如现有权威未列则先确认）、`security/backport-<id>`、`sync/code-oss-<tag>`、`release/<version>`、`experiment/<topic>`。分支从当前 Nyala 主线建立（同步分支也如此）。
- **普通 Nyala 功能/修复**：PR 合并后倾向 Squash Merge，主线上一个提交表示一项可验收的变更，PR 内保留细碎开发提交。
- **上游版本同步**：先在 sync 分支执行 `git merge --no-ff <upstream-tag>`；最终 PR 必须以 **Merge Commit** 方式合入，使目标稳定 Tag 仍是 `nyala/main` 祖先。**禁止 Squash / Rebase 上游历史**。
- **安全 backport**：单独 `cherry-pick` 有据可查的上游 SHA；如已含于后续 Tag，记录如何避免重复，避免混入同步 PR。

## 提交信息

推荐 `type(scope): imperative summary`，类型为 `feat`/`fix`/`refactor`/`test`/`docs`/`build`/`ci`/`perf`/`security`/`chore`/`sync`。

示例：

```text
feat(sqlite): implement cursor-backed result paging
fix(workbench): dispose connection tree listeners on reload
test(rpc): reject oversized and partial frames
sync(code-oss): merge upstream 1.144.0
docs(adr): explain transaction-bound session ownership
```

- 标题保持简明；正文说明 WHY / 风险 / 非显然取舍。若安全/兼容性要求 Break Change，加 `BREAKING CHANGE:` 并附迁移策略。
- 不要把“修测试 + 调格式 + 加功能 + 上游升级”混入一个 PR。
- 尊重 `.github/instructions/committing.instructions.md`：不使用 `--no-verify`、不禁用签名、不绕过 Hook。

## PR 粒度与准入

- 一项用户可感知能力或完整技术合同为粒度，文件/行数不是唯一标准。PR #11 合同含 schema、测试和文档属于同一闭环；不能因为行数多就机械拆开。
- 每个 PR 必须含：目标/变更/不做什么/风险、Issue or Backlog、关键路径测试、跳过测试的原因、截图或日志、对上游影响清单、兼容性/回滚。
- 有测试红灯时不得把 `Not Run` 写成 `Pass`；账单阻断时填 `BLOCKED: CI infrastructure`，按例外审批/暂缓合并。

## 可读历史的命令

```bash
git log origin/nyala/main --first-parent --oneline --decorate -n 40
git log origin/nyala/main --first-parent --merges --oneline -n 20
git merge-base --is-ancestor <upstream-tag> origin/nyala/main
# 显示相对同步 Tag 的当前 Nyala 产品差异（需先确认 Tag 为祖先）
git diff --stat <upstream-tag> origin/nyala/main
```

默认 GitHub Commits 页面也会展开上游近千提交，不代表 Nyala 特性提交太碎。用 `--first-parent` 检查产品主线。

## 例外与权限现实

私有仓库能否启用分支 Ruleset/强制审批取决于 GitHub 计划与组织配置；规则不可用时先使用团队约定 + 人工 Review + 本地证据。**不要声称仓库已经具备技术门禁**。
