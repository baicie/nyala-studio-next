# 06 · SQL 执行、数据库安全与资源语义

## 不可违反的安全不变量

1. 任何 Query 执行目标必须明确绑定 Profile/Session/Tab/Transaction（适用时），严禁依赖全局 `currentConnection`。
2. UI 控件的 Read-only、Context Key、SQL regex 分类**不能作为执行权限**；需要数据库只读用户/只读事务/数据库原生授权与后端 Policy。
3. 未知 DML/DDL/COMMIT 状态不能因断线当作失败并自动重试；写操作永不静默重放。
4. `EXPLAIN ANALYZE` 可能实际执行 SQL；不把它与无副作用的静态 Explain 混为一谈。生产环境必须受控审批。
5. 默认凭证不离开可信 Secret Storage/Runtime；日志不得包含 SQL 参数、结果行、Token/Password。
6. ResultHandle 限额/TTL/释放/过期必须定义；避免 Renderer 一次性读入十万行数据或无界 Cursor。

## 身份与并发

- `ConnectionProfile` 持久配置；`SessionId + generation` 代表实际连接代际。
- `EditorContext` 保存目标连接和 Schema，Tab 切换不隐式改变正在执行的 Query。
- `ExecutionId + event sequence` 使流式事件可去重；cancel 接收成功不等于服务端已停止执行。
- `TransactionId` 固定物理连接，Commit/Rollback 的结果如果不确定显示为 `UNKNOWN`，要求用户确认。

## 数据类型与分页

Null、Decimal、超过 JS 安全整数的 BigInt、Date/Time/TZ、Binary、JSON 的序列化必须保真；NULL 和字面量字符串 `"NULL"` 不得混同。结果分页不能隐式改写用户原 SQL 的 LIMIT/OFFSET 语义。导出为增量流，限制内存。

## SQL IDE 行为

高风险操作（DELETE/UPDATE/DROP/ALTER）需要目标环境/Schema/预估影响范围及明确确认；不以固定“任何 SELECT 都安全”作为白名单：函数、存储过程及数据库特性可能产生副作用。历史/草稿存储默认不记录凭证，敏感 SQL 可禁用保存。

## 驱动能力

SQLite 为 P1 端到端起点；PostgreSQL 与 MySQL 逐步启用，TLS、取消、Metadata、EXPLAIN、事务语义各自有 Capability 与真实数据库测试。未支持行为明确返回 `UNSUPPORTED`，不能静默降级为有风险行为。
