# 13 · Dependabot、上游 Workflow、Action 权限治理

## 现状（2026-10-29）

- `.github/workflows` 有约 18 个上游/产品自动化条目；除 Nyala Baseline 外，还会触发 Copilot、Telemetry、Monaco、CodeQL、Component Fixtures 等上游工作流。
- `.github/dependabot.yml` 包含 `github-actions` weekly、`devcontainers` weekly、`@vscode/markdown-editor` daily；已经带来若干与当前 SQL 主线不直接相关的 PR。
- CI 受 GitHub Actions 账户侧计费/额度影响而显示失败或未运行，需先确认恢复方案。

## 处理原则

- **不要直接删除 17 个上游 Workflow**。分三类：Nyala 必需、上游升级/发布时按需、与当前发行服务不适用。建立具体审计表并注明是否触发、成本、责任人和恢复条件。
- 处理自动触发应当是独立 PR，尽量采用独立 Nyala Workflow 或精准条件，避免频繁改微软上游 `.github/workflows` 增加同步冲突。
- 不为消除红灯禁用 CodeQL/安全检查而隐瞒覆盖损失；如果暂停，必须写 Issue、期限、恢复标准。
- 依赖更新：先评估 VS Code pinned deps 的兼容性；Markdown 编辑器的每日小幅更新建议降低噪声前先确认是否由 Code OSS 自身周期性构建依赖控制。
- GitHub Actions 使用最小权限 `contents:read`、固定 SHA 的 action、必要的 concurrency 和 artifact 生命周期；PR 来自不可信来源时不暴露 Secrets。

## CI 变更 PR 必需证据

1. 哪些 workflows 变成了手动/路径过滤/按需；旧新触发器差异。
2. 是否影响主线必要检测与上游同步验收。
3. 当前账号是否可运行 job；若因账单无法执行，不得标成验证通过。
4. 是否更改了 `.github/CODEOWNERS`、机器人权限、Dependabot 触发，若是说明上游冲突成本。
5. 如何一键恢复原有上游 CI 行为。
