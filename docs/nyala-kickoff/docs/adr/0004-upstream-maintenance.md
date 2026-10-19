# ADR-0004: 半年功能同步、及时安全维护、延迟源码裁剪

- Date: 2026-10-18
- Status: Accepted (design proposal)

## Decision

保留 Code OSS 原生 Git 历史；产品主要代码落在独立命名空间；每六个月试做上游稳定 Tag 合并；每月跟踪安全更新；裁剪按 UI 禁用→打包资产排除→必要源码删除。Tauri 等实验在固定基线独立分支。

## Consequences

源码体积与构建资源较大；但长期升级较稳。每个上游补丁需记录原因和测试，不以删代码数量为绩效。
