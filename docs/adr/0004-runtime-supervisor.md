# ADR 0004 · Electron Main 的 Runtime Supervisor（N-103）

- 状态：Proposed（随 `feat/p1-runtime-supervisor` 的 PR 审核）
- 日期：2026-11-01
- 决策域：`nyala-runtime` sidecar 在 Electron Main 中的启动、握手、重启、关闭与二进制定位
- 上位文档：[`nyala/rpc/README.md`](../../nyala/rpc/README.md)（可执行合同）、[ADR 0002](0002-rust-runtime-workspace.md)（Runtime 退出码与帧上限）、[07-sql-runtime](../nyala-kickoff/docs/07-sql-runtime.md)、[03-architecture-ownership](../nyala-governance/03-architecture-ownership.md)、[14-storage](../nyala-kickoff/docs/14-storage.md)
- 编号说明：`0002`、`0003` 已占用，本 ADR 取 `0004`。

## 背景

N-101/N-102（PR #25）提供了 `rust/crates/nyala-runtime`：stdio 上的 4 字节 LE 分帧、`runtime.hello`、`runtime.health` 和结构化错误。Backlog N-103 要求 Electron Main 侧有一个 Supervisor：启动进程、完成握手、崩溃后有限次退避重启、应用退出时有序关闭且不留孤儿进程。本次不含 Renderer Bridge、Query Service 和任何 SQLite 功能（N-104 在另一分支）。

## 决策

### 1. 代码位置与分层

```text
src/vs/platform/nyalaRuntime/
  common/nyalaRuntimeProtocol.ts       分帧编解码、envelope 解析、hello/health/restarted 类型（无 Node 依赖）
  node/nyalaRuntimeProcess.ts          一个子进程：spawn、stdout 帧、stderr 日志、在途请求、stop/kill
  node/nyalaRuntimeSupervisor.ts       一个 generation 序列：握手、退避重启、runtime.restarted；按窗口分配
  electron-main/nyalaRuntimeMainHandler.ts  接入窗口生命周期与应用关闭
  test/node/**                         假 runtime 单测 + 真实 cargo 产物集成测试
```

- Electron Main 代码只能依赖 `base`/`platform`（`src/vs/code/~` 的层级规则），所以不能放进 `workbench/contrib/nyala` 或 `workbench/services/nyala`。`src/vs/platform/nyalaRuntime/` 是 Nyala 新建目录，上游没有同名路径，同步时不会冲突。
- 进程管理放在 `node/`，与 Electron 无关，可以在 node 单测运行器里直接测；只有 `electron-main/` 的 Handler 依赖 Electron Main 服务。将来换宿主（如 Tauri 研究分支）只需替换 Handler。
- 合同类型手写在 `common/`，由 `test/node/nyalaRuntimeProtocol.test.ts` 读取 `nyala/rpc/v1/` 的 conformance 样例与错误码表对照校验，直到 N-110 生成类型。

### 2. 进程所在位置：Electron Main 直接 `child_process.spawn`

- 直接 spawn 可执行文件，不经 shell，`windowsHide: true`，`cwd` 为可执行文件所在目录。
- stdout 只交给帧解码器，从不写日志；出现零长度帧、超限帧或非 v1 响应/通知时，日志只记字节数，然后 kill 进程（字节流无法重新同步），按崩溃处理并以 `stream-error` 重启。
- stderr 按行写入独立日志 `nyalaRuntime`（Output 中的 “Nyala Runtime”），单行上限 2000 字符。Runtime 自己保证 stderr 不含 payload（ADR 0002）。
- 子进程只继承白名单环境变量（`SystemRoot`、`windir`、`TEMP`、`TMP`、`TMPDIR`、`LANG`、`LC_ALL`、`LC_CTYPE`、`RUST_BACKTRACE`），用户 shell 里的 token 等不会进入 sidecar。
- 帧上限：hello 完成前发送方向按 1 MiB，接收方向按 8 MiB；hello 后两个方向都改用协商出的 `frameMaxBytes`。

### 3. 归属：每个窗口一个 Runtime 进程

v1 的 Session 没有窗口或客户端归属字段。[14-storage](../nyala-kickoff/docs/14-storage.md) 要求：一个 Runtime 服务多个窗口时，每个请求都必须带 Window/Client ownership，否则每窗口独立 Runtime。N-104 的 Session 表也没有归属字段，共享进程会让一个窗口看到并关闭另一个窗口的 Session。因此 `NyalaRuntimeWindowSupervisors` 按窗口 id 持有各自的 `NyalaRuntimeSupervisor`：

| 窗口事件 | Runtime 行为 |
|---|---|
| 首次加载（`onWillLoadWindow`，`LoadReason.INITIAL`） | 启动 generation 1，完成 `runtime.hello` + `runtime.health` |
| Reload 或加载到另一个工作区（`RELOAD` / `LOAD`） | 按序停止旧进程，启动新 generation；持有旧句柄的 Renderer 已不存在。新 generation 就绪后发出 `runtime.restarted`（reason `window-reload` / `window-load`），重启计数清零 |
| 关闭（`onBeforeCloseWindow`）或 Renderer 崩溃后销毁（`onDidDestroyWindow`） | 按序停止并移除该窗口的 Supervisor |
| 应用退出（`onWillShutdown`） | `join` 关闭流程，直到所有窗口（含正在关闭的）的进程退出 |

成本是每窗口一个进程（调试构建约 0.5 MB 可执行文件，空闲时无 CPU）。现在每个窗口加载就启动 Runtime，方便覆盖生命周期；Renderer Bridge 落地后可改为第一次使用时再启动（后续项 3）。

### 4. 握手

- `runtime.hello` 发送 `protocolMajor 1`、`protocolMinor 0`、`clientBuild`（产品版本）和 `supportedFeatures`（目前为空，驱动客户端出现后再填）。
- hello 与 health 各有 10 s 超时；超时即 kill，按崩溃处理。
- 以下情况进入 `failed`，**不自动重启**，因为同一个构建会再次失败：退出码 2（README §3 的 `PROTOCOL_MISMATCH`）；hello 返回 `RUNTIME_LOST` 以外的错误（`PROTOCOL_MISMATCH`、`INVALID_PARAMS` 等）；hello 或 health 的结果不符合 v1 schema 或 `protocolMajor` 不是 1；spawn 失败（如 `ENOENT`）；找不到可执行文件。
- `failed` 后窗口 Reload 会调用 `restart()`，再试一次。

### 5. 退避重启参数

| 参数 | 值 | 理由 |
|---|---|---|
| 首次重启延迟 | 500 ms | 偶发崩溃时快速恢复 |
| 退避 | 每次连续重启翻倍，上限 10 s | 500、1000、2000、4000、8000 ms，约 15.5 s 后放弃，不会在启动即崩的构建上空转 |
| 连续重启上限 | 5 | 与上游 `AgentHostProcessManager` 的 `MaxRestarts = 5` 一致 |
| 计数清零 | 某个 generation 保持 ready 60 s | 长时间稳定后的偶发崩溃重新获得完整的重启额度 |

每次启动 generation 加 1。进程退出时，所有在途请求立即以 `RUNTIME_LOST`（`-32012`）失败；Supervisor 从不重放任何请求，是否重试由调用方按错误码表和“写语句永不自动重放”（README §7）决定。

### 6. `runtime.restarted`

合同把它列为通知，但新进程无法知道自己替换了谁，所以由 Supervisor 生成（`onDidRestart`），不转发 Runtime 自己发出的同名通知（记 warning 后丢弃）：

- 只在一个此前 ready 过的 generation 被新 generation 替换并 ready 后发出；首次启动不发。
- `reason`：`unexpected-exit`（崩溃）、`stream-error`（帧或消息不可读）、`window-reload`、`window-load`。
- `pendingExecutions`：旧 generation 在 ready 状态下丢失过在途请求时为 `unknown`，否则为 `none`。v1 还没有 execution，这里用在途请求保守地代替。
- `previousBuild`：上一个 ready generation 的 `runtimeBuild`。

### 7. 关闭顺序与超时

`stop()`：关闭 stdin（Runtime 在帧边界读到 EOF 后以退出码 0 结束）→ 等 3 s → `SIGKILL`（Windows 上为 `TerminateProcess`）→ 再等 2 s。单个进程最多 5 s，略短于上游 Agent Host 的 6 s 关闭超时，避免拖长应用退出。

`NyalaRuntimeMainHandler` 不由 `CodeApplication` 持有：`CodeApplication` 在 `onWillShutdown` 触发时立即 dispose，会在进程有序退出前把它们 kill 掉。Handler 在自己的 shutdown join 结束后 dispose 自身（与上游 `AgentHostProcessManager` 的做法一致）。所有 listener、子进程、timer 的归属：

| 资源 | Owner | 释放 |
|---|---|---|
| 子进程与其 stdio listener | `NyalaRuntimeProcess` | `stop()`；dispose 时若仍在运行则 kill |
| 当前进程、事件订阅 | `NyalaRuntimeSupervisor.connection`（`MutableDisposable`） | 换代、stop、dispose |
| 重启 timer、稳定 timer | `NyalaRuntimeSupervisor`（`MutableDisposable`） | 换代、失败、stop、dispose |
| 每窗口 Supervisor | `NyalaRuntimeWindowSupervisors`（`DisposableMap`；关闭中的放 `DisposableStore`） | 窗口关闭后 stop 完成即 dispose |
| 生命周期 listener、日志 | `NyalaRuntimeMainHandler` | shutdown join 结束后 dispose |

### 8. 二进制定位

- 开发构建（`!isBuilt`）：`NYALA_RUNTIME_PATH` 指定绝对路径且文件存在时使用它；设置了但无效时报“找不到”，不悄悄回退。未设置时取 `<appRoot>/rust/target/{debug,release}/nyala-runtime[.exe]` 中修改时间较新的一个。
- 打包构建：返回未找到，Supervisor 进入 `failed`（warning 级日志），IDE 照常启动。随安装包分发 Runtime 不在 N-103 范围内（后续项 1）。

### 9. 与未来 Renderer Bridge 的边界

本次不提供任何 Renderer 可调用的 IPC。将来的 Bridge 需满足：

- Renderer 只能经由按窗口 id 绑定的通道访问**本窗口**的 Supervisor，拿不到 stdio、pid 或其他窗口的进程。
- 方法白名单，不直接透传任意 method；大结果走 `result.fetchPage`，不经 IPC 一次性传输。
- 把 `onDidRestart` 与 `RUNTIME_LOST` 原样交给 Renderer，由 UI 标记旧 generation 的句柄失效、展示 Unknown，不自动重放写语句。
- 取消与超时从 Renderer 传到 Supervisor，再成为 RPC 请求（v1 的 `query.cancel`）；凭据不经 Renderer。

## 未采纳的替代方案

- **所有窗口共享一个 Runtime**：进程少，但 v1 与 N-104 的 Session 都没有窗口归属，一个窗口能看到并关闭其他窗口的 Session；要共享，必须先给每个请求加 ownership（合同变更）。
- **`utilityProcess` 或 Shared Process 托管**：二者运行的是 Node/JS 入口，要么再写一层 JS 去 spawn Rust 可执行文件，要么多一跳 IPC；Supervisor 本身只有管道和 timer，放在 Main 的开销很小。
- **在 Renderer（Workbench Contribution）里启动**：Renderer 不能 spawn 进程，也违反“Renderer 不直接接触数据库执行路径”的边界。
- **由 `CodeApplication._register` 持有**：应用关闭时会先于 shutdown join dispose，进程被 kill 而不是有序退出。
- **改 `windowsMainService` / `lifecycleMainService` 来挂钩**：要修改更多上游文件；这两个服务已提供 `onWillLoadWindow`、`onBeforeCloseWindow`、`onDidDestroyWindow`、`onWillShutdown`。
- **固定间隔或无上限重启**：启动即崩的构建会无限循环，日志和 CPU 都失控。

## 后果

- 上游跟踪文件只改 `src/vs/code/electron-main/app.ts`：一行 import、一行 `createInstance`（及一行注释）。其余均为 Nyala 新文件。已在 [`nyala/patch-ledger.md`](../../nyala/patch-ledger.md) 登记；按现行口径合并后 `patchCount` 由 50 变为 55（`app.ts` +1，`src/vs/platform/nyalaRuntime/` 下 4 个非测试源文件 +4），`nyala/upstream-base.json` 在合并后更新。
- CI：`Unit tests (node)` job 在跑单测前 `cargo build --locked -p nyala-runtime`，并设置 `NYALA_RUNTIME_REQUIRED=1`，让真实进程集成测试在没有产物时失败而不是跳过。4 个必需 job 的名字不变。
- Windows 原生冒烟脚本 `scripts/nyala/smoke-runtime.ts` 检查：握手成功、外部 kill 后换代重启、Reload 换代且旧进程自行退出、退出应用后没有残留 `nyala-runtime` 进程。

## 后续项

1. **打包分发**：把 Runtime 放进安装包并定位（`isBuilt` 分支），含签名与各平台路径。
2. **合同澄清**：README 未写明 `runtime.restarted` 由谁发出；本实现由客户端 Supervisor 生成，建议在 README §4 写明（v1 冻结，按勘误或 minor 处理）。
3. **按需启动**：Renderer Bridge 落地后，改为窗口第一次使用 SQL 时再启动 Runtime。
4. **Renderer Bridge**：按 §9 的边界实现，并补 Reload/关闭时句柄失效的 UI 测试。
