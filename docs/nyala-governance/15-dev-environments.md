# 15 · 开发环境、源码学习与实验分支

## 基线

- 跟随 `nyala/upstream-base.json` 和 `.nvmrc`，**不要为了便利擅自换成 pnpm/yarn/bun**，现阶段使用 Code OSS 的 npm 构建链。
- 读取实际 `package.json` scripts 与 `.github/copilot-instructions.md`；先看现有 watcher/task 输出，避免反复启动大规模 watch/build。
- CLI、UI、Rust 项目路径与上游 Version 均需动态核验，不能把本包的快照当成永远正确。

## 开发切片

1. Workbench 最小 Hello/Connections 生命周期；2. Rust hello/version；3. SQLite SELECT 1 + ResultHandle；4. Query Editor；5. Grid/恢复；6. PG/LSP；7. Agent Task 与安全 tools（后续）。

每个切片除了代码与测试，增加一份学习记录：源码调用链、用了什么既有 VS Code API、遇到的上游约束、性能证据、可以移除的补丁。

## Tauri 与瘦身实验

仅在 `experiment/*`，固定 HEAD、期限、指标、验收、终止条件；不把 Tauri Feature Flag/Node shim 混入 Electron 主线。PoC 失败也要保存有价值的对照与报告。

## 环境矩阵

开发机 macOS 可先完成主线 Smoke；Windows/Linux 构建/安装/扩展宿主必须在对应真实环境再认证。不把 Playwright 仅 DOM 渲染当作 Electron 全流程通过。
