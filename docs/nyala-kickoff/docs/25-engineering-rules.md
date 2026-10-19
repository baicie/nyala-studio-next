# 25 · 工程规范、目录归属与接口红线

## 架构红线

1. 仅从固定 Code OSS Tag 派生，保留上游 Git 历史。
2. SQL 业务集中 `workbench/contrib/nyala`、受控 Workbench Service、内置 Extension、Rust Core。
3. `base/platform/editor` 不依赖 Nyala SQL Contributions，保持上游层级依赖。
4. React/SPA 不得替代 Workbench；局部复杂 View 的渲染框架需独立说明。
5. DB IO、密码、Result Cache 在 Rust，Renderer 不直接持有长期 Secret。
6. 所有 Query 都带 Session/Execution ID；事务固定物理连接，跨 Tab 不串。
7. 不以 regex 检测 SELECT 作为 Read-only 安全边界。
8. 大结果只通过受控分页/游标/限额；不可全量 JSON 透传。
9. 自定义 IPC 必须版本协商、Framing、类型校验、错误码、资源释放。
10. 新 OS Runtime 只能通过适配层，不把 Tauri API 传染到 Domain。
11. 可视化状态要覆盖失败/超时/取消/断线/权限不足，而非只写 happy path。
12. P0–P2 不大规模删除 Code OSS Core；裁剪先从打包资产/入口开始。
13. 所有上游补丁在 Patch Ledger 登记，核心补丁必须有 ADR。
14. AI Tool 不能绕过 Query Authority；用户数据默认不外发。
15. 软件不应依赖微软商业版资产、Marketplace 服务和 Copilot 等专有集成来启动。

## TypeScript / VS Code

- 遵守 TypeScript/Code OSS 现有代码约定及 DI，跨 Contribution 只依赖 public `common` API。
- 注册的监听器、Disposable、EditorModel、View、Webview 与 Worker 都管理生命周期。
- Commands 的 ContextKey 只负责 UI 可用性，不替代后端授权。
- UI 颜色和排版尽量继承 `--vscode-*` token。
- 新类型经 `nyala/contracts` 生成，避免多个 DTO 漂移。

## Rust

- DB 请求传结构化错误；任何用户输入引起的错误不 panic。
- `Secret<T>` 日志不可 `Debug` 打印；测试包含脱敏。
- 所有异步 IO 有 deadline/cancel；后台任务有明确 Owner 与停止路径。
- ResultHandle + Transaction 由 Registry 统一清理，进程退出有 Drop/Shutdown。
- 参数化查询优先；动态对象名要 Identifier Quoting 和白名单，不拼接未验证内容。

## 文档规则

新领域能力先更新相关 Design/ADR/测试矩阵。Roadmap 只记正式目标，研究型实验写独立 EXPERIMENT 记录。代码实现不同于文档时以测试/实际代码为准并立即修订，不允许文档长时间虚构功能已完成。

## 分支和上游规则

- 产品稳定主线为 `nyala/main`；功能、修复、同步、安全回补和实验使用带类型的短期分支。
- 分支不使用 `codex/*` 前缀；命名规则和生命周期以 [26 · 分支模型与上游同步](26-branching-and-upstream-sync.md) 为准。
- Code OSS 只从明确的稳定 Release Tag 同步，不直接追踪 `upstream/main`。
- `nyala/main` 禁止 force push、历史重写和未审查的大型同步；所有同步必须更新基线、Patch Ledger 和兼容性报告。
