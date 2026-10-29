# 07 · Rust SQL Runtime 核心设计

## 目标与非目标

**目标**：提供类型正确、状态可追踪、可取消/超时、结果分页/流式、凭证安全、数据库差异显式的单机 SQL Runtime。**非目标**：自造数据库服务器、ORM、云端多租户查询网关。

## Rust crate 规划（按垂直切片逐渐拆）

- `nyala-protocol`：RPC envelope/version/error/serializable domain DTO。
- `nyala-runtime`：stdio Framing、Connection/Result registry、Cancellation、资源限制、Audit hooks、Supervisor handshake。
- `nyala-core`：连接、执行、Result、Transaction 的领域服务，不依赖 Electron/Tauri。
- `nyala-driver-sqlite`：推荐 SQLite 最先跑通完整闭环（原生 SQLite 库/`rusqlite` 等经评估选型）。
- `nyala-driver-postgres`：Tokio 兼容异步 PostgreSQL 驱动，支持 Schema、TLS、Cancel。
- `nyala-driver-mysql`：MySQL 驱动和取消/事务差异；后续迭代。
- `nyala-secrets`：系统凭证存储适配与会话凭证访问权限。

MVP 可从一个 `nyala-runtime` crate + 按模块分文件开始。不要为了理想目录做过度模块化。

## 领域对象与 ID

| 类型 | 内容 | 所属与存活期 |
|---|---|---|
| `ConnectionProfile` | id、displayName、driver、host/path、选项、secretRef（不含密码） | 用户 Profile 持久化 |
| `ConnectionSession` | id、generation、capabilities、state、poolRef | Runtime；断线可重建 |
| `EditorQueryContext` | queryId、profileId、defaultDb、schema、readonlyFlag | Workbench 草稿 |
| `QueryExecution` | id、sessionId/generation、sqlFingerprint、state、timestamps | 单次执行 |
| `ResultHandle` | id、executionId、schema、rowCountEstimate、expiry | Runtime 内存/磁盘句柄 |
| `TransactionContext` | id、sessionId、physicalConnectionId、state | 固定物理连接，显式释放 |

**禁止**用一个全局 `activeConnection` 驱动所有查询；RPC 必须带明确 Session/Execution 身份，特别是在多个 Tab 或断线恢复场景。

## 执行状态机

```text
Created -> Queued -> Running -> Streaming -> Completed
                       |         |
                       +--> Failed
                       +--> CancelRequested -> Cancelled | Completed | Failed | Unknown
                       +--> Interrupted/Unknown (connection lost/crash)
```

- `CancelRequested` 是用户意图，不等于 `Cancelled`；只有 driver 确认或连接终止后根据证据变更状态。
- `Unknown` 是必要终态：例如网络失联后无法确认提交是否落库。禁止谎称失败/回滚已完成。
- 每次状态通知带单调递增 `sequence` 防止乱序 UI。
- `releaseResult` 幂等；结果句柄带 generation/lease，过期后返回 `RESULT_EXPIRED`。

## 驱动接口（概念，需按 Rust trait object / async trait 设计验证）

```rust
pub struct DriverCapabilities {
    pub cancel: CancelCapability,
    pub metadata: MetadataCapabilities,
    pub server_cursor: bool,
    pub explain: ExplainCapability,
    pub supports_transactions: bool,
    pub readonly_enforced: bool,
}

pub trait DatabaseDriver: Send + Sync {
    fn kind(&self) -> DriverKind;
    fn capabilities(&self, server_version: &str) -> DriverCapabilities;
    // connect/execute/cursor/metadata/tx 放在细分 async traits 中
}
```

- 不是所有 Driver 都能精准取消、分页、原生解释 Explain。
- Capabilities 由已连接服务端版本/用户权限/驱动行为共同决定，不只是 `driverKind`。
- 每种 Driver 应覆盖参数占位符/Identifier Quoting、事务、结果类型、错误码映射。

## 查询执行语义

- `ExecuteMode`：`Statement` / `Selection` / `Script`；由编辑器确立 SQL 字节范围与脚本模式，不把任意分号字符串 Split 当作完整 parser。
- 首次 MVP 可只实现 `Statement`，脚本多结果与分隔符特性后续明确支持。
- 超时区分 QueueTimeout / DriverConnectTimeout / QueryTimeout / FetchTimeout。
- 限额：`maxInitialRows`、`maxResultMemoryBytes`、`maxConcurrentExecutions`、`resultTtlSecs`、`maxExportBytes`；默认值由设置集中管理，需压测校准。
- 大结果集采用驱动流读取或原生游标/受控 spool，再通过 `fetchPage`；不默默改写用户 SQL 插 `LIMIT/OFFSET`，避免改变排序/锁/事务语义。

## 事务处理

- `AutoCommit` 为 MVP 默认模式；`Manual` 后续以固定 connection handle 实现。
- Transaction 的 begin/commit/rollback 需要 requestId+幂等语义说明；网络中断时不能简单自动重试 COMMIT。
- Sidecar 崩溃/关闭/窗口退出时主动释放连接；无法证明的事务最终状态展示 Unknown。
- Script 执行是否启用隐式事务必须按 Driver/模式清晰约定。

## 崩溃与重连

- Electron Supervisor 负责启动、健康检查、进程退出事件、指数退避重启（有限次数）。
- 所有已执行/执行中句柄作废；UI 收到 `runtimeRestarted`，可主动重连 Profile，**不得自动重放写 SQL**。
- 对没有明确幂等保证的查询与事务不可在异常后自动重试。
- 错误按 `category` 与 `retryable` 返回，隐藏原始密码和连接串。

## 第一阶段 vertical slice

`sqlite.connect -> sqlite.listTables -> query.execute SELECT 1 -> result.fetchPage -> result.release -> sqlite.disconnect`，包括 invalid SQL、readonly DML、cancel/timeout、Sidecar 重启测试。

## 性能观察点

创建连接时长、RPC encode/decode、Query queue / execute / fetch 时长、Result 缓存字节、Grid render、Sidecar RSS/CPU、超时/取消比例。默认本地日志不记录结果内容。

## v1.1 实现优先级与状态边界

- 当前仓库仅存在 `nyala/rpc/v1` 可执行协议合同，**尚未实现 Nyala 专有 Rust DB Sidecar**；这里的结构/接口属于 P1 设计要求。
- P1 实施顺序 N-101/102/103：独立 Rust Workspace → stdio 帧编解码与 hello/health/error → Electron Main Supervisor，真实跨进程测试优先；随后 SQLite Session/Metadata/Query/Result/Cancel/Readonly。
- 以当前合同为规范来源，保持 major/minor、sessionGeneration、Execution/Result IDs、sequence、`Unknown` 状态语义；不得私自“简化”掉取消/资源释放/未知提交状态。
- 允许最早纵向 smoke 跑通 Workbench → TS Bridge → Rust → SQLite → Workbench，但不得越权绕开统一 Query Service 或把大结果直接 JSON 化。
- Agent 将来只能经 Tool Gateway 和该 Runtime 执行 SQL，Agent 的审批不同于 DB 原生授权，不允许误用 Agent Shell 代替 SQL Query Authority。
