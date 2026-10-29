# Upstream Sync Gate

- [ ] 旧/新 upstream Tag+SHA、Release Notes，明确目标不是上游 `main`。
- [ ] `git merge-base --is-ancestor <oldTag> origin/nyala/main` 成功。
- [ ] 从 Nyala 主线建立 `sync/code-oss-<tag>`，完整 `git merge --no-ff <newTag>`。
- [ ] 冲突按 U/N/S 分类，保留人工解决的每个产品意图。
- [ ] 核查 Product Identity、Copilot/Agent/Marketplace、授权、Telemetry、微软更新源。
- [ ] 记录 Node/Electron/ExtensionHost/Build/License 变化。
- [ ] `nyala:validate-product` / `nyala:validate-rpc` / 相关 typecheck / Hygiene。
- [ ] 原生启动、Commands/Connections、Editor/ExtensionHost/Webview、Reload。
- [ ] Runtime/SQL 真实集成和平台安装/卸载能力；未运行者记录影响及 Owner。
- [ ] 更新 `upstream-base.json`, `patch-ledger.md`, `upstream-compatibility.md`, `PROGRESS.md`。
- [ ] 确认新 Tag 是 sync 分支祖先；PR 采用 **Merge Commit**，不得 Squash。
- [ ] 合并后 `git merge-base --is-ancestor <newTag> origin/nyala/main`。
