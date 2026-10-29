# Nyala RPC 合同 v1.0（stdio · Length-prefixed JSON）

> 状态：**Draft for review** · 协议版本 `1.0` · 生成日期 2026-10-28
> 上位设计：[08-ipc-contract.md](../../docs/nyala-kickoff/docs/08-ipc-contract.md)、[07-sql-runtime.md](../../docs/nyala-kickoff/docs/07-sql-runtime.md)
> 本目录是 P1 的**可执行**合同：`v1/` 下的 envelope schema、错误码表和一致性样例必须与 Rust Runtime 同步演进，不得由实现单方面漂移。

## 1. 传输与分帧

`nyala-runtime` 由 Electron Main 以子进程方式启动。三条流的分工是硬约束：

| 流 | 内容 | 禁止 |
|---|---|---|
| `stdin` | 客户端 → Runtime 的帧 | 混入非协议文本 |
| `stdout` | Runtime → 客户端的帧 | 混入日志、println、panic 栈 |
| `stderr` | 人读日志 | 被解析为协议 |

帧格式：**4 字节 little-endian 无符号长度 N（payload 字节数，不含前缀）+ N 字节 UTF-8 JSON**。

- `N = 0`：非法帧，回 `INVALID_REQUEST` 后按 §7 关闭连接。
- `N > frameMaxBytes`：回 `RESOURCE_LIMIT` 并立即终止进程（此时无法安全跳过未知长度的剩余字节）。
- 读端必须按"先读满 4 字节前缀，再读满 N 字节"推进，正确处理半包/粘包；不得假设一次 read 等于一帧。
- payload 必须是单个 JSON object；数组、标量、空对象以外的形态按 `INVALID_REQUEST` 处理。
- `frameMaxBytes` 由 `runtime.hello` 协商，v1 默认 **8 MiB（8388608）**；客户端在收到 hello 前不得发送超过 1 MiB 的帧。

## 2. Envelope

沿用 JSON-RPC 2.0 的字段语义，但 `id` 必须是字符串（不使用数字 id，避免 JS 侧精度问题）。

请求：

```json
{"jsonrpc":"2.0","id":"rq_001","method":"runtime.hello","params":{"protocolMajor":1,"protocolMinor":0,"clientBuild":"0.0.1-dev.0","supportedFeatures":["sqlite"]}}
```

成功响应：

```json
{"jsonrpc":"2.0","id":"rq_001","result":{"protocolMajor":1,"protocolMinor":0,"runtimeBuild":"0.1.0","features":["sqlite"],"limits":{"frameMaxBytes":8388608,"maxInitialRows":200,"maxPageRows":1000,"maxResultTtlSecs":300,"maxConcurrentExecutions":4}}}
```

失败响应：

```json
{"jsonrpc":"2.0","id":"rq_009","error":{"code":-32006,"message":"Query cancelled","data":{"kind":"QUERY_CANCELLED","retryable":false,"executionId":"ex_001","safeDetail":"cancel requested by user"}}}
```

通知（无 id、无响应）：

```json
{"jsonrpc":"2.0","method":"query.stateChanged","params":{"executionId":"ex_001","sequence":2,"state":"completed","resultIds":["rs_001"],"elapsedMs":11}}
```

约定：

- `method` 形如 `<domain>.<verb>`，域名固定为 `runtime`、`connection`、`metadata`、`query`、`result`、`transaction`（v1 未实现 `transaction.*`）。
- `params` 必须是 object（无参数时传 `{}`），不接受按位置传参。
- 每个请求必须收到且只收到一个响应；未知 `method` 回 `METHOD_NOT_FOUND`。
- 执行类方法额外返回 `executionId`，状态通过 `query.stateChanged` 通知推进，用 `sequence`（每 execution 单调递增）防乱序。

## 3. 版本协商

`runtime.hello` 是连接上的第一个请求，未完成握手前只允许 `runtime.hello` 与 `runtime.health`。

- `protocolMajor` 不同：回 `PROTOCOL_MISMATCH`，Runtime 以退出码 2 结束，客户端不得重试同一进程。
- `protocolMinor` 不同：按 `features` 能力位协商，客户端**不得**调用 `features` 中缺失的方法；未知通知必须静默忽略。
- `features` 是稳定字符串集合，v1 已知取值：`sqlite`、`metadata.listObjects`、`query.execute`、`query.cancel`、`result.fetchPage`、`result.release`。
- 新增可选字段属于 minor；改字段语义、删字段、改枚举默认值属于 major（见 §8）。

## 4. 方法目录（v1.0 最小集）

| Method | 请求参数 | 结果 | 幂等/语义 |
|---|---|---|---|
| `runtime.hello` | protocolMajor、protocolMinor、clientBuild、supportedFeatures | protocolMajor/Minor、runtimeBuild、features、limits | 每连接一次 |
| `runtime.health` | `{}` | status、uptimeMs、activeSessions、activeExecutions、pendingResults | 只读 |
| `connection.test` | driver、path、readOnly | ok、serverVersion?、elapsedMs | 不建立持久 Session |
| `connection.open` | driver、path、readOnly、profileId? | sessionId、sessionGeneration、capabilities | 每次返回新 generation |
| `connection.close` | sessionId、sessionGeneration | closed | 幂等；generation 不匹配回 `INVALID_SESSION` |
| `connection.listSessions` | `{}` | sessions[] | 只读 |
| `metadata.listObjects` | sessionId、sessionGeneration、schema?、kinds?、cursor?、limit | objects[]、hasMore、nextCursor | cursor 不透明 |
| `metadata.describe` | sessionId、sessionGeneration、object | columns[] | 只读 |
| `query.execute` | sessionId、sessionGeneration、sql、mode、timeoutMs、maxInitialRows、cancelTokenId? | executionId、state、sequence | 写语句不自动重试 |
| `query.cancel` | executionId、reason? | accepted、state | 幂等；`CancelRequested` ≠ `Cancelled` |
| `query.getState` | executionId | executionId、state、sequence、resultIds?、error?、elapsedMs? | 丢通知时的补偿读 |
| `result.fetchPage` | resultId、cursor?、limit | columns[]、rows[][]、hasMore、nextCursor、rowCountEstimate? | 只前进，不回退 |
| `result.release` | resultId | released | 幂等；过期回 `RESULT_EXPIRED` |

通知：

| Method | 参数 | 说明 |
|---|---|---|
| `query.stateChanged` | executionId、sequence、state、resultIds?、elapsedMs?、error? | 状态机推进的唯一推送源 |
| `runtime.restarted` | reason、pendingExecutions、previousBuild? | 重启后所有句柄作废，禁止自动重放写 SQL |

## 5. 执行状态机

```text
Created → Queued → Running → Streaming → Completed
                      ├→ Failed
                      ├→ CancelRequested → Cancelled | Completed | Failed | Unknown
                      └→ Unknown（连接丢失/进程崩溃，无法证明事务终态）
```

- `state` 取值固定为：`queued`、`running`、`streaming`、`completed`、`failed`、`cancel_requested`、`cancelled`、`unknown`。
- `sequence` 在同一 `executionId` 上严格递增；客户端丢弃重复或回退的 sequence。
- 终态集合：`completed`、`failed`、`cancelled`、`unknown`。到达终态后不再发送该 execution 的通知。
- `unknown` 是诚实的终态：网络失联、进程被杀、COMMIT 未确认时不得伪称 `failed` 或 `cancelled`。

## 6. 数据类型合同

每个 cell 是 discriminated object，不做隐式 JS Number 强转：

| type | 载荷 | 说明 |
|---|---|---|
| `null` | — | 无值 |
| `bool` | `value` | 布尔 |
| `int64` | `text` | 十进制字符串，超出 IEEE-754 安全整数 |
| `float64` | `value` | JSON number |
| `decimal` | `text` | 精确十进制字符串 |
| `string` | `value` | UTF-8 文本 |
| `timestampTz` | `iso` | 带时区偏移的 ISO-8601 |
| `date` | `iso` | `YYYY-MM-DD` |
| `bytes` | `encoding`（固定 `base64`）、`data` | 仅用于小 BLOB；大对象走后续 `blob.readChunk` 能力位 |

新增 cell type 必须提升 minor 并出现在 hello 的 `features` 中；v1 客户端遇到未知 type 必须以 `string`（渲染原文）降级显示，而不是崩溃。

## 7. 错误模型与限流

错误对象：`{"code":<int>,"message":<string>,"data":{"kind":<string>,"retryable":<bool>,"safeDetail"?:<string>,"executionId"?:<string>,"sessionId"?:<string>,"sqlState"?:<string|null>}}`。

- `kind` 是稳定标识，`code` 是数值映射，两者必须同时出现在 [`v1/error-codes.json`](v1/error-codes.json) 中；客户端按 `kind` 分支，不按 `message` 文案分支。
- `-32700/-32600/-32601/-32602/-32603` 保留给 JSON-RPC 层；领域错误使用 `-32001..-32014`。
- `message` 面向开发者，可本地化；`safeDetail` 已脱敏，不得含密码、连接串、文件系统路径中的用户名。
- 仅 `retryable: true` 的错误允许自动重试，且写语句与事务永不自动重放。
- 资源限制（默认值可被 hello 覆盖，实现须压测校准）：`frameMaxBytes` 8 MiB、`maxInitialRows` 200、`maxPageRows` 1000、`maxResultTtlSecs` 300、`maxConcurrentExecutions` 4。超限回 `RESOURCE_LIMIT`，不允许静默截断。

## 8. 变更策略

- `v1/` 是冻结目录：只允许新增可选字段与新增 `features` 能力位。
- 破坏性变更新建 `v2/`，并在 `runtime.hello` 走 major 协商；不在 v1 内改语义。
- TypeScript 与 Rust 的类型必须从本 schema 生成或对照校验（N-110）；手写双份视为缺陷。
- 任何合同改动都要同步：schema、`error-codes.json`、`conformance.ndjson`、本 README，并保持 `npm run nyala:validate-rpc` 通过。

## 9. 一致性样例与校验

```bash
npm run nyala:validate-rpc
```

脚本 [`scripts/nyala/validate-rpc-contract.ts`](../../scripts/nyala/validate-rpc-contract.ts) 做四件事：

1. **分帧**：把每条样例按 4 字节 LE 前缀编码，再用逐字节喂入的解码器还原，校验半包/粘包、零长度拒绝、超限拒绝。
2. **Schema**：用内置的 JSON Schema 子集求值器校验 envelope 是否符合 [`v1/nyala-rpc.v1.schema.json`](v1/nyala-rpc.v1.schema.json)。
3. **配对**：每个请求有且只有一个响应，响应的 result 按请求方法匹配对应 result schema，通知 sequence 在同一 execution 上递增。
4. **错误码**：错误响应的 `data.kind` 与 `code` 必须在错误码表内且互相匹配，`retryable` 与表中默认值一致。

样例文件 [`v1/conformance.ndjson`](v1/conformance.ndjson) 是唯一的协议回归输入；新增方法必须同时补样例，否则视为未完成。
