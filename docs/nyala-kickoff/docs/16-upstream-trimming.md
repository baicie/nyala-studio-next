# 16 · 上游同步、补丁预算与模块裁剪

## 基本策略

**优先保持 Git 历史和源码路径不变，半年同步功能，安全更新及时跟踪。** P0 不改 Core、不删目录；P1–P2 仅最小 Contribution 入口和产品配置；P3+ 才对构建产物做可度量裁剪。

## Git remote/branches

完整的分支命名、PR 保护和同步命令以[分支模型与上游同步规则](26-branching-and-upstream-sync.md)为准；本节保留补丁预算和上游升级的设计约束。

```text
upstream: microsoft/vscode
origin:   OWNER/nyala-studio (Fork preserving history)
branches:
  nyala/main                # 唯一可发布主线
  sync/code-oss-<tag>       # 上游稳定 Tag 同步
  feat/<topic>              # 产品功能
  fix/<topic>               # 缺陷修复
  security/backport-*       # 安全修复
  release/<version>         # 发布候选
  experiment/tauri-*        # 有固定基线的实验，不追主线
  experiment/minimal-*      # 打包瘦身研究
```

## 版本基线

在 `nyala/upstream-base.json` 维护 `{tag, sha, checkedAt, patchCount, buildTool}`。使用 git merge-base/commits 真实确认，不能仅靠 README 宣称基线。每次升级保留 changelog、冲突文件、工作量、回归记录。

## 修改预算（目标而非硬性成功 KPI）

- `src/vs/base` 和 `src/vs/editor`：0 个 Nyala 功能性永久补丁。
- `src/vs/platform`：尽量 0，必须修改时写 ADR。
- Workbench 原生入口：控制在少量稳定、可解释的注入点。
- `src/vs/workbench/contrib/nyala/*`、`extensions/nyala-*`、`rust/*`：产品主要修改空间。
- 每一个上游文件补丁必须有 owner、用途、风险和失败测试。

## 上游升级操作手册

1. `git fetch upstream --tags`，确定新的 Stable Tag，审查 release note/Node/runtime/API/内置扩展与许可变化。
2. 从 `nyala/main` 拉 `sync/code-oss-<tag>`，合并指定稳定 Tag。不要在正式主线直接执行大型 merge。
3. 输出冲突类别：产品 branding、入口、service API、build scripts、E2E、发行服务、Extension Host。
4. 先保证 Code OSS core 构建，再启用 Nyala Contributions，再 Rust 桥接，再 UI/E2E。
5. 重新审计新版 `product.json` 可能新增的外部服务 URL、Telemetry、默认 Agent 配置。
6. 记录真实冲突行数、手工工时，测试通过后走 Release PR。

```bash
# 样例：实际 tag 按发布时确定
git fetch upstream --tags
git switch -c sync/code-oss-<new-tag> nyala/main
git merge <new-stable-tag>
# 修冲突、构建、测 E2E；不能自动把失败忽略后 merge
```

## 裁剪三级策略

- L1：隐藏入口/关闭贡献点/配置（不删上游实现）。
- L2：构建产物中排除无关内置扩展、资产、语言包（有尺寸记录与安装验证）。
- L3：只有明确独立且收益很高的模块，做源码物理删除；每一项都记录上游升级成本增加。

## 拆分测量

对每个候选裁剪项记录：`originalCompressedBytes`, `afterCompressedBytes`, `installedDisk`, `coldStart`, `featureRegressions`, `upstreamMergeImpact`。删 1000 个 TS 源文件不等于最终安装包减少 1000 个文件。

## 版本维护频率

- 每月：检查 CVE/Electron/Node 与 Code OSS 安全补丁。
- 每季度：小批量迁移/审计关键产品差异。
- 每 6 个月：尝试一次 Stable 大版本同步、完整 E2E。
- Tauri 原型每次固定在同一 Code OSS/SQL Runtime release baseline，比对数据后是否推进。

## Kill criteria

若某次升级让大部分 UI Core 深度改动冲突，优先撤销非必要定制、收缩裁剪或恢复上游实现；不要为保留个性化 CSS 牺牲长期升级能力。若 Tauri 要求重写大量 Extension Host 功能，停止合入主线。
