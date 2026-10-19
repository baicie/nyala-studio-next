# 23 · 风险登记册与缓解方案

| 风险 | 可能性 | 影响 | 触发条件 | 缓解/撤退 |
|---|---|---|---|---|
| R01 Code OSS 编译资源过重 | 高 | 中 | 开发机器频繁 OOM/编译过慢 | 主平台先跑；监测构建资源；缩小并发、CI、remote runner（不牺牲主线） |
| R02 上游 Workbench API 高耦合 | 高 | 高 | `src/vs/*` 核心补丁不断增长 | Contribution/API 优先；patch ledger；半年合并试验 |
| R03 旧 SideX 代码迁移污染 | 中 | 高 | 引入旧运行时和大量适配层 | 仅参考设计，不复制旧 Workbench 架构 |
| R04 SQL 执行影响真实数据 | 中 | 极高 | SQL 错库、readonly 误判、误重试写 | Session/Query identity、原生授权、确认、故障测试 |
| R05 Result Grid 大数据 OOM | 高 | 高 | `execute` 一次传 100k+ 行 | ResultHandle/TTL、页缓存、虚拟化、受控导出 |
| R06 扩展 API/市场授权误用 | 中 | 高 | 从官方 VS Code 直接复制 Market/Copilot URL | 产品/许可/服务审计、Open VSX/VSIX 合法分发 |
| R07 Tauri 实验吞噬主线时间 | 高 | 中 | 每个 UI 改动要同时改两套运行时 | 实验固定 SHA/时间盒，禁止主线依赖 |
| R08 SQL LSP 方言复杂度失控 | 高 | 中 | 想一次支持所有 dialect | SQLite→PG→MySQL，能力降级和 parser scope |
| R09 多数据库 Session 错误归属 | 中 | 极高 | 多 Tab / crash / restart 下串执行 | ID + generation + ownership、E2E 故障注入 |
| R10 安全/隐私泄漏 | 中 | 极高 | 日志/Prompt/History 含敏感 SQL | 脱敏、OS Secrets、用户开关、默认无遥测 |
| R11 范围蔓延 | 高 | 高 | AI/ER/图表/10 种驱动并发 | 每阶段 Exit/Non-goals，按 Backlog 决策 |
| R12 许可证/品牌疏漏 | 中 | 高 | 发行前才发现不可用服务/资产 | 从 P0 Audit 产品配置、签名与依赖许可证 |
| R13 多窗口同数据文件冲突 | 中 | 高 | 两个窗口同时写 Profiles/History | 有版本迁移、SQLite Transaction、文件锁策略 |
| R14 端点权限超广 | 中 | 极高 | 任意 Webview/扩展直接可执行 SQL | Main Bridge allowlist、Runtime ownership、DB 最小权限 |

## 每周风险复盘

记录新增/已消减风险、相关 Issue、是否触发止损条件。风险条目不因为“当前项目是学习型”而可以忽略：这是直接连接真实数据库的桌面软件。
