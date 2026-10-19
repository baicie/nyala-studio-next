# 24 · 维护运行手册

## 开发日常

1. `git status` 检查工作树，使用锁定 Node/npm/Rust Toolchain；别把 package manager 从 npm 偷换到 pnpm。
2. 从 `nyala/main` 开 feat 分支，任务关联 Backlog/ADR。
3. 先本地测试最小范围，写一段“学习了什么 IDE 机制”。
4. 提交/PR 必含对应运行日志；没有执行的检查明确说明 `not run`。
5. 重大故障写一份 RCA（症状、Root Cause、回归用例、修复）。

## 每周

- 扫描上游安全更新（Node/Electron/native dependency）。
- 复盘 Code OSS 核心修改文件是否持续增加。
- 测一条最重要的用户故事（连接→SQL→结果→恢复）。
- 检查 Rust Runtime 的 Crash/Resource 泄漏。

## 每月

- 审计更新源、扩展分发、许可证、默认外部 URL 是否变化。
- 更新 Version Base 与 Patch Ledger，记录构建尺寸/性能基线。
- 清理已知问题与废弃实验分支，保留实验结论报告。

## 上游版本升级

按 [16](16-upstream-trimming.md) 通过临时 Integration branch 执行，一次升级建议分为：Core Build -> Product Identity -> Contribution -> Rust Bridge -> Extension Host -> Desktop E2E -> Packaging。

## Bug 严重度

- S0：数据库被误改、凭证泄漏、数据丢失/未知提交状态误报，立即阻断发行。
- S1：无法启动、基本 SQL 执行错误、跨库误执行，阻断对应版本。
- S2：连接树/Result 某功能失效，有清晰 workaround。
- S3：视觉/文档/低频 UX 缺陷。

## 新贡献者入门

从 `START-HERE.md`、`PROJECT-README.md`、`AGENTS.md` 开始；先完成 Bootstrap；推荐从 Tree loading state/Query UI tests 开始，严禁初次提交就全局重构 Code OSS Core。
