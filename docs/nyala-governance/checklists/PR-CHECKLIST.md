# Nyala PR Checklist

- [ ] 分支/目标正确：feature/fix/docs → `nyala/main`；不是未经授权的直接 push。
- [ ] 一个独立主题，关联 Issue/Backlog、列出非目标与风险。
- [ ] 继承 VS Code upstream coding guidelines；保留 Code OSS 层级与生命周期。
- [ ] 触及上游已有文件则更新 Patch Ledger，解释为何无法移入 Nyala 命名空间。
- [ ] SQL/Agent/IPC 变更有 ID、权限、超时、资源释放与负向测试。
- [ ] 实际执行的测试/环境/日志完整记录，BLOCKED/NOT RUN 未伪装成功。
- [ ] UI 更改验证主题、键盘、状态恢复和失败路径。
- [ ] 相关文档/ADR/PROGRESS 已更新，且当前 HEAD 准确。
- [ ] `git diff --check`，无 Secret/生成缓存/超大附件。
- [ ] 合并策略正确：普通 PR Squash，上游 Sync Preserve Merge。
