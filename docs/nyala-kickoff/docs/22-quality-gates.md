# 22 · 质量门禁与 Definition of Done

## 每个 PR 的最小标准

- [ ] 与当前阶段/Issue/ADR 关联，范围单一，避免混入无关格式化。
- [ ] 上游源代码改动列出文件、原因、如何在升级时处理；如果修改 base/editor，需要 ADR。
- [ ] 设计符合运行时分层，前端不直接访问 Rust Driver 或原生密码。
- [ ] 关键操作有成功/失败/取消/超时/断线 UI 状态。
- [ ] 添加对应单元/集成/E2E，或在 PR 明确标注未运行与阻碍。
- [ ] 新建 Listener/Worker/Editor/Query/ResultHandle 有正确释放。
- [ ] 日志不打印 Password、Token、敏感 Result；Webview 字符串安全渲染。
- [ ] 变更影响用户 Profile、Draft、History 时有版本迁移与回滚测试。
- [ ] 用户可访问性、键盘与 Theme 最基本行为检查。
- [ ] 更新相关文档/决策/运行日志；禁止“已测试”但没有真实执行结果。

## 阶段质量门

P0：原生 Code OSS 启动、品牌身份、License 清单、Workbench 回归；P1：RPC Contract、SQLite execute、超时/取消/Crash；P2：SQLite Desktop E2E、上下文隔离、大结果虚拟表格、Draft；P3：PG 驱动真实测试、LSP、Plan、TLS；P4：MySQL、跨平台安装、签名/更新/恢复。

## 自动化建议

```text
fast checks: lint + targeted TS/Rust tests + JSON schema validation
integration: SQLite + IPC fuzz/fault injection
nightly: Code OSS full build + Desktop smoke + big-grid benchmark
release: native macOS/Windows package + install test + SBOM + license + security + signed update
```

Code OSS 是大型项目，要求每次本地全部编译可能不现实；但每个阶段出口和 Release 必须跑对应完整测试，确保不存在“只在 Hot Reload 下正常”的功能。

## 安全阻断级别

P0 Block：泄露凭证、readonly 绕过、跨 Session 查询串库、自动重放未知 DML/DDL、IPC 任意命令注入、无校验更新等。P1 Block：Crash 导致数据无法恢复、核心 SQLite/PG 执行结果错误。P2：视觉瑕疵/次要快捷键冲突可挂起并有 Issue。

## PR 模板

见 `templates/PULL_REQUEST.md`。
