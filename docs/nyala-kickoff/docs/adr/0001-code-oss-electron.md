# ADR-0001: 采用 Code OSS Fork，Electron 作为正式主线

- Date: 2026-10-18
- Status: Accepted (design proposal)

## Context

希望拥有 VS Code 原生 UI、深入学习 Workbench/Extension Host；现有 SideX 的版本与 UI 与新版 Code OSS 差距较大，持续维护价值有限。

## Decision

从 `microsoft/vscode` Release Tag `1.142.0` 建立保留 Git 历史的新 Fork。Electron 原生保留，Nyala SQL 业务以 Contributions + Rust SQL Runtime 实现。初期不裁剪上游核心源码。

## Alternatives

SideX Tauri（旧基线维护成本）；VS Code 插件（学习 Workbench 底层较少）；Monaco 自建 Shell（重写原生 IDE 复杂功能）。

## Consequences

构建/包体积较大、Fork 上游升级成本存在，但语言服务/布局/扩展宿主研究收益高。评估触发：每次 Code OSS 升级、官方 Extension Host 架构变化。
