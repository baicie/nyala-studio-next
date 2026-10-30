# 08 · IPC/RPC 协议与版本演进

> **v1.1 重要提示**：本页原有字段/示例含早期设计意图，与仓库当前 v1.0 可执行合同时，**以仓库 `nyala/rpc/v1` 及 `nyala/rpc/README.md` 为准**；具体差异见文末“v1.1 协议勘误”。

## 决策

Electron Main 启动 `nyala-runtime` 子进程，初期以 `stdio` 交换 **4 字节 little-endian 长度前缀 + UTF-8 JSON** 帧，JSON envelope 借鉴 JSON-RPC 2.0。Renderer 不直接访问子进程 stdin/stdout；仅通过最小权限的 Workbench Service 与 Main RPC Bridge。stderr 为非协议日志流；禁止 stdout 混入日志。

为何不用 HTTP：本地不需要公开端口，减少认证/端口冲突复杂性。但 stdio 仍要防止恶意输入、拒绝超长帧、处理半包/粘包与进程退出。

## 版本协商

`runtime.hello`：携带 `protocolMajor`, `protocolMinor`, `clientBuild`, `runtimeBuild`, `supportedFeatures`；Major 不同拒绝连接，Minor 差异按功能位协商，不能强行调用缺失方法。

- `frameMaxBytes` 例如初期 8 MiB **建议上限**，需要实际验证；超过拒绝并返回受控错误。
- 请求、响应均带 `requestId`；执行任务另有 `executionId`。
- 通知按 stream + `sequence` 去重和乱序处理。
- 支持 `deadlineMs` 和 `cancelTokenId`，不得只靠前端超时丢弃请求。

## Envelope 示例

```json
{"jsonrpc":"2.0","id":"rq_01","method":"query.execute","params":{"sessionId":"s_01","sessionGeneration":1,"sql":"select 1","mode":"statement","timeoutMs":30000,"maxInitialRows":200}}
```

典型执行结果：

```json
{"jsonrpc":"2.0","id":"rq_01","result":{"executionId":"ex_01","state":"running","sequence":1}}
```

后续通知：

```json
{"jsonrpc":"2.0","method":"query.stateChanged","params":{"executionId":"ex_01","sequence":2,"state":"completed","resultIds":["r_01"],"elapsedMs":17}}
```

Fetch Result：

```json
{"jsonrpc":"2.0","id":"rq_02","method":"result.fetchPage","params":{"resultId":"r_01","limit":200,"cursor":null}}
```

注意 `cursor` 是不透明服务端 Token，不能把数据库密码、Session 内部地址或敏感对象指针暴露出来。必须校验归属与有效期。

## 方法目录（最小集）

| 分类 | Method | 关键要求 |
|---|---|---|
| Lifecycle | `runtime.hello`, `runtime.health` | 协议/版本/功能协商 |
| Connection | `connection.test/open/close/listSessions` | 加密凭证引用、错误归类 |
| Metadata | `metadata.listObjects`, `metadata.describe` | pagination/cancel/permissions |
| Query | `query.execute`, `query.cancel`, `query.getState` | 状态机、幂等取消 |
| Result | `result.fetchPage`, `result.release` | typed cells、limits、TTL |
| Transaction | `transaction.begin/commit/rollback` | 后续版本、物理连接绑定 |

## 错误模型

```json
{"jsonrpc":"2.0","id":"rq_03","error":{"code":-32002,"message":"Query timed out","data":{"kind":"QUERY_TIMEOUT","retryable":false,"executionId":"ex_02","sqlState":null,"safeDetail":"Deadline exceeded"}}}
```

Error taxonomy：`AUTH_FAILED`,`NETWORK_UNREACHABLE`,`TLS_ERROR`,`QUERY_TIMEOUT`,`QUERY_CANCELLED`,`SQL_SYNTAX`,`READ_ONLY_DENIED`,`PERMISSION_DENIED`,`RESULT_EXPIRED`,`INVALID_SESSION`,`PROTOCOL_MISMATCH`,`RUNTIME_LOST`,`UNKNOWN_COMMIT_STATUS`,`RESOURCE_LIMIT`。日志只存脱敏 detail。

## 数据类型合同

不要统一强转 JS Number；每个 Cell 使用 discriminated tag，例如：

```json
{"type":"decimal","text":"12345678901234567890.123456"}
{"type":"int64","text":"9223372036854775807"}
{"type":"timestampTz","iso":"2026-10-18T01:23:45.123+08:00"}
{"type":"bytes","encoding":"base64","data":"AQID"}
{"type":"null"}
```

大 BLOB 不应在普通 Page 中随意 base64，支持 `cell.preview`/`blob.readChunk` 的 future capability。Timestamp 和时区遵循原始驱动语义，未定义 timezone 时不可假定为 UTC。

## 流控

- `result.fetchPage` 按客户端请求返回，限制单页 row/bytes；UI 不可无限预取。
- 服务端按 ResultHandle 设置 per-result 缓存/TTL，超额抛明确 RESOURCE_LIMIT。
- `query.stateChanged` 事件有 sequence；窗口丢事件可 `query.getState` 补偿。
- 导出应由 Runtime 流至受控文件路径，必须有文件选择/确认/数据量上限；不必先将全部数据装进 Renderer。

## 安全边界与身份校验

- Bridge 只暴露白名单方法、校验 payload size、参数类型与来源窗口。
- 不通过任意 `executeCommand` 将运行时权限暴露给未知扩展/页面。
- 不接受 RPC 中传入任意 OS 文件读写路径而无额外授权。
- Sidecar 限定为本机可执行资源；包中校验 Hash/签名，启动权限遵循 OS 最小权限。

## 版本策略

协议 `1.0` 在 P1 固定；字段扩展优先可选，不改变既有 enum 默认语义；破坏性变更升级 major。维护 JSON Schema + 类型生成工具与兼容性测试，不允许 TS/Rust 手工演化产生漂移。

本文件是设计意图；**可执行合同**见 [`nyala/rpc/README.md`](../../../nyala/rpc/README.md)（envelope schema、错误码表、一致性样例，`npm run nyala:validate-rpc`）。两者冲突时以合同为准，并回头修正本文件。

## v1.1 协议勘误与权威说明

此前文档 `runtime.hello` 字段、方法目录和 `deadlineMs` 等表述是设计示意。**真正已冻结的可执行合同（实现基线）**：仓库 `nyala/rpc/README.md` 与 `nyala/rpc/v1/nyala-rpc.v1.schema.json`、`error-codes.json`、`conformance.ndjson`（PR #11）。

- 不得直接把此设计里的 `deadlineMs`、`requestId` 等示意扩展当成 schema 已声明的字段；先读合同，例如当前合同以请求 `id`、`timeoutMs`、`sessionGeneration` 为准。
- `transaction.*` 为后续版本，除非合同发布新能力位，不在 P1 v1.0 默认可用。
- 任何字段语义更改先提出合同修订及兼容性 ADR，再做 TS/Rust 双端一致性、负向测试和 conformance；不能为了实现方便偷偷修改 `v1`。
- [`../examples/`](../examples/) 下的 `rpc-envelope.schema.json`、`rpc-sample.ndjson` 是 v1.0 设计包的历史示例，明确禁用作正式生成源。
