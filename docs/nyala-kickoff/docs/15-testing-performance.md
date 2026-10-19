# 15 · 测试矩阵、性能与故障注入

## 测试金字塔

1. **Rust 单元**：Driver Capabilities、状态机、SQL Value 类型、错误归类、授权策略。
2. **Rust 集成**：真实 SQLite Fixture；PostgreSQL/MySQL 临时容器（后续）；Txn/取消/超时/权限。
3. **Protocol Contract**：TS/Rust 版本兼容、Framing、错误/通知序列、半包/长帧/进程退出。
4. **Workbench 单元**：Editor QueryContext、连接树模型、Commands、ResultPageCache、Grid Selection。
5. **桌面 E2E**：真实 Electron 窗口启动、操作 UI、SQL 完整闭环、恢复、异常与扩展激活。
6. **发行测试**：安装卸载、签名、更新、独立用户数据目录、不同 OS/ARCH。

## 阶段最小矩阵

| 用例 | SQLite P1 | PostgreSQL P3 | MySQL P4 |
|---|---|---|---|
| connect/open/close | 必需 | 必需 | 必需 |
| SELECT 1 / invalid SQL | 必需 | 必需 | 必需 |
| readonly/DML/DDL | 必需 | 必需 | 必需 |
| metadata permissions | 必需 | 必需 | 必需 |
| timeout/cancel | 必需（能力限定） | 必需 | 必需（能力限定） |
| disconnected in-flight | 必需 | 必需 | 必需 |
| DECIMAL/BIGINT/NULL/TIME/BLOB | 基础 | 完整 | 完整 |
| TLS/certs | 不适用 | 必需 | 必需 |
| EXPLAIN | 后续 | 必需 | 必需 |
| 多结果集 | 后续 | 协议明确 | 驱动明确 |

## 性能维度

- 启动：Process Launch → Window Visible → Workbench Ready → First SQL Editor Interactive 分别打点。
- Runtime：连接建立、排队时间、SQL 运行、Fetch/Serialize/IPC、Result Release。
- UI：Frame Duration、Main-thread Long Tasks、Grid First Paint、滚动时间、内存峰值。
- 包：压缩安装包尺寸、安装后磁盘占用、首次启动、空闲总进程树 RSS；Windows WebView2 不适用于 Electron 主线但可用于 Tauri 对比。

所有测试写明 CPU、内存、OS、存储、数据库版本、行数、列数、是否热缓存。**绝不把不同环境的耗时直接宣称性能提升百分比。**

## 性能数据集

- 基础：1k rows × 8 columns；NULL/BLOB/JSON/Decimals。
- 典型：10k × 20。
- 压力：100k × 20；100k × 100（只需分页浏览，不要求全载入）。
- 慢连接：200ms/1s RTT 的模拟网络；并发 2/5/10；强制断开/恢复。
- 编辑器：100k 行 SQL 文件、双 Tab、分屏、切换主题。

## 故障注入

- Rust 子进程被 Kill（查询正在运行）。
- JSON RPC 接收到截断帧、乱序通知、重复 cancel。
- 数据库断开在 COMMIT 之前/之后（必须展示 Unknown 而不是声称 Rollback）。
- 结果句柄 TTL 过期后滚动 Fetch。
- 权限不足元数据树的 Partial 状态。
- 导出磁盘满、路径无权限、磁盘中途拔掉。
- 窗口 Reload、频繁开启/关闭 SQL Editor，检查 Listener/内存泄漏。

## CI 建议

P0：官方 Code OSS 可启动 Smoke（手工/自动）、TS lint、产品清单审计；P1：Rust fmt/clippy/test + Protocol Contract；P2：E2E UI；P3+：真实 DB integration matrix。大规模 Code OSS 构建不建议每个小提交都在所有平台全量运行，可使用 nightly + PR 增量策略，但 Release Tag 必须完整跑。

## 关键验收标准

- Runtime 退出后，主 UI 不崩溃，能明确提示恢复/重连。
- 10 万行结果无需 10 万 DOM 行、缓存内存有上限。
- Query/Transaction 资源按所有权清理，关闭窗口不留 Sidecar 孤儿进程。
- 只读模式驱动/数据库层测试覆盖；无法确保时在 UI 明确标注限制。
