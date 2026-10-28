# ADR 0001 · 用可执行合同冻结 Nyala RPC v1.0

- 状态：Accepted（draft for review，随 PR 审核）
- 日期：2026-10-28
- 决策域：Nyala 跨进程协议（Electron Main ↔ `nyala-runtime`）
- 上位文档：[`docs/nyala-kickoff/docs/08-ipc-contract.md`](../nyala-kickoff/docs/08-ipc-contract.md)、[`07-sql-runtime.md`](../nyala-kickoff/docs/07-sql-runtime.md)

## 背景

kickoff 设计包给出了 `1.0` 协议的**意图**（Length-prefixed JSON、JSON-RPC 风格 envelope、错误分类、ResultHandle、取消语义），但只有一份 18 行的示意 schema 和 7 行样例。Rust Runtime（N-101 起）一旦开工，如果 TypeScript 与 Rust 各自"照着文档理解"实现，会出现字段名、错误码、状态枚举、sequence 语义的静默漂移——这类漂移在 P1 只能靠人工比对发现，代价最高。

## 决策

把协议 `1.0` 固化为**可执行合同**，放进 `nyala/rpc/`：

1. `nyala/rpc/README.md` 是规范正文：分帧、envelope、版本协商、方法目录、状态机、cell 类型、错误模型、限流、变更策略。
2. `nyala/rpc/v1/nyala-rpc.v1.schema.json` 是 envelope + 每个方法 params/result 的 JSON Schema（2020-12）。
3. `nyala/rpc/v1/error-codes.json` 是 `kind ↔ code ↔ retryable` 的唯一映射表，领域错误固定占用 `-32001..-32099`。
4. `nyala/rpc/v1/conformance.ndjson` 是唯一回归输入：一个完整会话（hello → health → connection → metadata → query → fetchPage → release → 错误 → cancel → restart）。
5. `scripts/nyala/validate-rpc-contract.mjs`（`npm run nyala:validate-rpc`）离线校验：逐字节分帧还原、半包/粘包、零长度与超限拒绝、schema 校验、请求/响应配对与方法级 result 校验、通知 sequence 单调、错误码表一致、README 与 schema 的方法清单不漂移。

## 理由

- **可验证**：把"合同"从文档断言变成可执行断言，PR 阶段就能拦住漂移，而不是等到 Rust 集成测试。
- **零依赖**：校验脚本只用 `node:assert`/`node:fs`，不引入 ajv 等新依赖，符合 P1 早期"不做过度工程"的约束。
- **单一事实源**：错误码、方法清单、样例三处互检；README 与 schema 的方法集合必须相等。
- **可移植**：同一份 `conformance.ndjson` 后续可直接喂给 Rust 侧测试（N-110 的双向合同测试），无需重写用例。

## 后果

- 任何方法/字段/错误改动必须同时改 schema、错误码表、样例与 README，否则 `nyala:validate-rpc` 失败。
- `v1/` 冻结：破坏性变更新建 `v2/`，在 `runtime.hello` 走 major 协商。
- 校验脚本是本仓库自研的 JSON Schema 子集求值器，只覆盖本合同用到的关键字；新增关键字必须先扩展脚本，不允许"写了但没校验"。

## 未采纳的替代方案

- **只维护 Markdown**：无法在 CI 拦住漂移，P1 后期返工成本最高。
- **直接用 ajv**：需要新增依赖与供应链审计，收益不足以抵消 P1 早期的复杂度。
- **等 Rust 实现完再固化**：等于让实现定义合同，TS 侧只能被动跟随，违背"合同先行"。

## 证据

```bash
npm run nyala:validate-rpc
# nyala rpc contract v1.0: OK
#   frames: 33 (byte-wise + glued decoding, half/zero/oversize rejection)
#   envelope schema: 35 definitions, 14 requests / 5 notifications / 2 error responses
#   methods: 15 implemented, 15 documented
#   error kinds: 19 registered
```
