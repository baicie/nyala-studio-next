# 05 · CI、验证证据、失败阻断

## 三种必须区分的状态

| 状态 | 意味着 | 可否写成通过？ |
|---|---|---|
| PASS | 某 SHA、某系统环境下实际运行且成功 | 可以，需给出命令或链接 |
| FAIL | Runner 启动并执行检查，代码/环境导致断言失败 | 不可以，需定位与修复 |
| BLOCKED / NOT RUN | 没有执行，例如 GitHub Actions 账单/额度、下载失败、缺证书 | **绝对不可以** |

检查到 2026-10-29，Nyala 主线 GitHub Actions 有许多失败 Check，进度文档称任务未启动与账单有关；需先核实每个 Run 的 job steps/错误信息，不能仅凭“红色”当作代码回归，也不能用“本地跑过”代替强制门禁。

## 验证层级

- G0 文档/配置：Markdown 链接、YAML/JSON 解析、`git diff --check`、产品元数据校验。
- G1 Nyala 静态：`npm run nyala:validate-product`、`npm run nyala:validate-rpc`、相关 TS typecheck、Rust fmt/clippy（仅 crate 存在时）。
- G2 独立子系统：RPC fuzz/负向用例、SQLite headless、Session/Result/Cancellation。
- G3 Workbench：启动、Reload、split SQL Tab、Extension Host/Webview、Context、键盘/主题。
- G4 数据库：SQLite/PG/MySQL 真数据库矩阵、安全失败路径、事务断线。
- G5 发行：各平台包、安装/卸载、签名、更新、版权清单、性能。

## PR 和阶段门禁

- 文档 PR 可只跑 G0；改 Workbench 至少 G1+G3；改 Runtime 至少 G1+G2；改 product.json/打包必须 G1+G3+G5 的相关部分；上游同步至少 G0+G1+G3 且同步报告将 G4/G5 未覆盖标红。
- 不重复跑同义巨大构建：尊重上游 Copilot 指令，先用定向测试和已有 Watch 输出；必要时才跑整仓编译。
- P0/P1 安全阻断项：误删/写库、凭证泄漏、跨连接执行、未知事务重放、IPC 任意执行、未验证的运行时下载。

## GitHub Actions 策略

- 恢复可执行的 Actions 优先；确认是否账单、配额、Runner、依赖下载、权限或代码失败。
- `nyala-ci.yml` 保留最小可信必需检查；上游重型 Workflow 不应全部默认触发，但**调整触发器是一份单独、明确记录的 CI/上游补丁 PR**。
- 没有可用的 paid branch protection/rulesets 时，采用操作规程：PR 说明、人工审查、本地报告、独立终端日志；仍不宣称有 GitHub 强制门禁。
- 不要用改名/删除 Workflow 隐藏安全检查失败；必须记录为什么没有启用、哪些发布门禁受影响。

## 证据格式

```text
Git SHA / upstream tag:
Environment (OS/arch, Node/npm/Rust/Electron):
Command and exact scope:
Result PASS|FAIL|BLOCKED|NOT RUN:
Logs/screenshots/artifacts (sanitized):
Limitations / regression impact:
```
