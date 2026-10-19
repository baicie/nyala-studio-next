# 09 · 数据库驱动、方言与元数据

## 版本支持策略

MVP 先 SQLite；0.2 PostgreSQL；0.3 MySQL。目标是逐个数据库完成**完整可靠的行为**，不是 `connect()` 能通就标记支持。正式支持矩阵按数据库版本 / OS / TLS / Cancellation / Metadata / Transactions / Read-only 实测，失败标注 Preview。

## Driver Capability

```text
DriverCapabilities
  - canCancel: none | cooperative | server_request | connection_abort
  - metadata: catalogs | schemas | indexes | constraints | views | definitions
  - executeModes: statement | script | prepared
  - explain: none | estimate | analyze
  - transactions: none | auto | manual | savepoint
  - cursor: streaming | server_cursor | bounded_buffer
  - readonly: server_enforced | connection_enforced | client_warning_only
```

不要假定 SQLite、PG、MySQL 对“数据库/Schema/目录”命名完全一致。定义分层 `Catalog -> Namespace -> DbObject`，驱动可跳过不适用层，UI 自适应。

## SQLite

- 文件路径/`:memory:`；文件数据库打开权限、符号链接、只读标志。
- `sqlite_master`/SQLite PRAGMA 获取对象、列、主外键与索引。
- Cancellation 基于 SQLite 原生 interrupt 能力；执行与事务状态必须测试。
- 初始结果有行数上限，单行 BLOB 限额；大查询不能把整个 SQLite Result 全量加载。
- 只读要使用原生只读打开模式和/或 `PRAGMA query_only`（以实际驱动能力验证），不能只靠 SQL regex。

## PostgreSQL

- `host/port/database/user/sslmode` 配置；OS Keychain 保存 secretRef；TLS 证书检验策略明确。
- `pg_catalog` / `information_schema` 列、类型、默认值、索引、约束、Schema。
- 使用 PG cancel request 的语义；若取消失败状态仍需等待结果/检查。
- `EXPLAIN (FORMAT JSON)` 是结构化 Plan 主路径；`EXPLAIN ANALYZE` 可能实际执行目标语句，尤其 DML 禁止自动触发。
- `pg_stat_statements` 是可选 Capability（权限、扩展安装可用性检查），不能在连接时自动安装。

## MySQL

- 不同 Server 版本/MariaDB 差异需要显式处理，不自动宣称完全兼容。
- `INFORMATION_SCHEMA` + `SHOW`/`EXPLAIN`；时区、CHARSET、Collation、DECIMAL、UNSIGNED BIGINT 特别测试。
- `cancel` 能力根据驱动/服务器协议区分；如需 terminate connection，必须提示事务/会话影响。
- 连接池默认隔离 Session Variables；不允许事务查询漂移至其他连接。

## 元数据缓存

- `key = driver/serverIdentity/database/schema/objectId/privilegeContext`；缓存 key 不包含明文 credentials。
- 含 `retrievedAt/ttl/etag?`；显式 Refresh 与重连后失效。
- 权限不足返回 `partial` 而不是空；元数据请求可取消，树节点并发有上限。
- 远端连接延迟下采用懒加载；可以显示对象数量近似值而非阻塞加载全库。

## 类型系统

每个驱动映射为 `DataTypeDescriptor`，保留 `nativeTypeName`、nullability、precision/scale、timezone、binary 等信息。Result Value 采用协议 tagged union，不得自动丢失 64-bit 整数和十进制精度。

## 驱动测试矩阵

至少测试：正常/错误凭证、连接超时、TLS 失败、无权限对象、DDL 后刷新、时间/BigInt/Decimal/NULL/BLOB、大结果、长查询取消、查询并发、断线重连、事务连接绑定。数据库版本与平台记录到测试报告。

## 远程连接

SSH Tunnel、代理、Cloud IAM、证书轮换是未来能力，提前为 ConnectionProfile 预留 `transportKind`、credentialRef，但不要首版做全部。内网/生产数据库连接默认不发送遥测。
