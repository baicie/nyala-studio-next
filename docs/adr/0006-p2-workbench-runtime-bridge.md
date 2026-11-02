# ADR 0006 · P2 Workbench Runtime Bridge 与 N-201 Connections

- 状态：Accepted（2026-11-03，`feat/p2-connections-foundation`）
- 日期：2026-11-03
- 决策域：Renderer → Electron Main → Rust Runtime 的受控 IPC、连接身份与 Connections 视图
- 上位文档：[`docs/adr/0004-runtime-supervisor.md`](0004-runtime-supervisor.md) §9（Renderer Bridge 边界）、[`docs/nyala-kickoff/docs/03-architecture.md`](../nyala-kickoff/docs/03-architecture.md)、[`05-workbench-integration.md`](../nyala-kickoff/docs/05-workbench-integration.md)、[`docs/nyala-governance/06-sql-runtime-safety.md`](../nyala-governance/06-sql-runtime-safety.md)、[`nyala/rpc/README.md`](../../nyala/rpc/README.md)

## 背景

P1 结束时 Rust Runtime 已能打开 SQLite、读 metadata、执行查询并分页，但 Workbench 里没有任何入口：`NyalaConnectionsView` 仍是一段占位文字，Renderer 也无法触达 sidecar。N-201（Connections Tree）与 P2 的第一步需要一条**受控**桥：Renderer 不 spawn 进程、不持有数据库驱动、不看到任意 RPC 方法名，而 Session 的身份、代际与窗口归属必须显式。

N-103 的 Supervisor（ADR 0004）已经保证「每窗口一个 Runtime 进程」，按窗口 id 分配；本 ADR 只解决如何让该窗口的 Renderer 访问**它自己的**那个进程。

## 决策

### 1. 分层与源码位置

```text
Workbench UI (Connections View, 未来的 Query Editor)
  -> INyalaConnectionService            src/vs/workbench/contrib/nyala/connections/common/
    -> INyalaRuntimeBridge (renderer)   .../connections/browser/nyalaRuntimeBridge.ts
      -> IMainProcessService channel    'nyalaRuntime'
        -> NyalaRuntimeChannel          src/vs/platform/nyalaRuntime/electron-main/nyalaRuntimeChannel.ts
          -> NyalaRuntimeMainHandler    .../electron-main/nyalaRuntimeMainHandler.ts
            -> NyalaRuntimeSupervisor   .../node/nyalaRuntimeSupervisor.ts
              -> nyala-runtime stdio RPC
```

- 复用 Code OSS 已有的 `IMainProcessService` / `IServerChannel`（与 `meteredConnection`、`policy` 等相同机制），不引入第二套消息协议。
- 通道在 `app.ts` 的 `initChannels` 里注册一次；`NyalaRuntimeMainHandler` 仍是未被 DI 持有的自有生命周期对象，只在 `app.ts` 里多保存一个局部引用。
- Renderer 侧服务用 `registerSingleton(..., InstantiationType.Delayed)` 注册，首次被 View 请求时才建立通道。

### 2. 方法白名单与参数校验

Renderer 只能发 `NyalaRuntimeCommand` 里的命令：`getRuntimeState`、`connection.test`、`connection.open`、`connection.close`、`metadata.listObjects`、`metadata.describe`。

- 通道持有 `NyalaRuntimeCommand -> v1 method` 的映射表；表外的命令直接抛错，不透传任意 `method`。
- 参数在 **Main 进程**用 `nyalaRuntimeRequest.ts` 校验后才进入 RPC：session id 必须匹配合同 id 模式、generation 为正整数、`limit` 在 1–1000、`kinds` 只允许三种值、`path` 必须是绝对本地路径（拒绝 `file:` URI、相对路径、`:memory:`）。Renderer 传来的额外字段一律丢弃，不带给 Runtime。
- 结果按 `INyalaRuntimeCallResult` 判别联合返回：`{ok:true, result}` 或 `{ok:false, error}`，错误保留 `kind`/`code`/`retryable`/`safeDetail`，因为 UI 按 `kind` 分支。异常不跨 IPC 抛出，避免错误形态在序列化中丢失。

### 3. 窗口绑定

`IServerChannel.call/listen` 的 `ctx` 是 Renderer 的 IPC 客户端 id（`window:<id>`，由 `ElectronIPCMainProcessService` 构造时传入）。通道只接受该形态并用 `NyalaRuntimeWindowSupervisors.get(windowId)` 取该窗口自己的 Supervisor：

- Renderer 无法指定别的窗口 id：请求体里没有这个字段，ctx 由 Electron IPC 握手给出。
- 窗口没有 Supervisor（尚未加载完成或启动失败）时返回 `RUNTIME_LOST`，不创建进程、不回退到其他窗口。

### 4. 身份：Profile / Session / Generation

| 字段 | 创建者 | 作用域 | 过期条件 |
|---|---|---|---|
| `profileId` | Workbench 服务（`p_<n>` 或由路径派生的稳定 id） | 窗口 + 用户存储；不含 session | 用户删除 profile |
| `sessionId` | Rust Runtime（`connection.open`） | Runtime 进程 | 进程退出、`connection.close`、Runtime 重启 |
| `sessionGeneration` | Rust Runtime | 同一 `sessionId` 的代际 | 重新 `connection.open` |
| `runtimeGeneration` | Supervisor（每次 launch +1） | 窗口 | 每次重启 / Reload |
| `windowId` | Electron | 进程 | 窗口关闭 |

- `INyalaConnectionHandle` 同时携带四者（`windowId` 由通道隐式绑定，故不放进 handle），未来 Query EditorInput 直接持有它，而不是依赖全局 `currentConnection`。
- 服务在发请求前比较 `runtimeGeneration`；不匹配即拒绝（`NyalaRequestError`），请求根本不会到达新进程。
- Supervisor 换代时服务把所有连接标为 `lost` 并清空 catalog：旧 session 不会被当作有效会话继续使用。
- Profile 存 `IStorageService`（`StorageScope.PROFILE`），只存 path/readOnly/displayName，不存 session、不存凭据。Session 永远只在 Runtime 进程内存中。

### 5. 结果与 IPC 体积

本轮桥只暴露 `connection.*` 与 `metadata.*`。后者单次回复受 `limit ≤ 1000` 与合同 `maxPageRows` 约束；`result.fetchPage` 等大结果方法**没有**暴露，Query/Result 的桥接留给 N-202/N-204 单独设计。`frameMaxBytes` 仍是 8 MiB，Main 进程在转发前校验帧大小（由 `NyalaRuntimeProcess` 负责）。

### 6. 失败、取消与生命周期

- Runtime 崩溃/重启：Supervisor 发 `runtime.restarted`，通道把 `onDidChangeState` 映射为 Renderer 的 `runtimeStateChanged`；服务据此把连接置 `lost`。
- 请求失败：结构化错误原样回到 Renderer；UI 在树中显示 `Connection failed` / `Connection lost` 与 `safeDetail`。
- 取消：v1 的 `query.cancel` 属执行语义，本轮桥未暴露（没有 Query），未来随 N-202 一起加白名单并传 `CancellationToken`。
- Disposable：View 释放时注销事件订阅并 dispose 树；服务随窗口存活，通道随 `DisposableStore` 在应用关闭时释放；窗口关闭时 Supervisor 走 ADR 0004 的有序停止。

### 7. Connections 视图（N-201）

- 树用 `WorkbenchAsyncDataTree`，行由 `NyalaConnectionsDataSource` 从服务状态派生；展开表时才调用 `metadata.describe` 取列。
- 首次渲染会向 Main 询问一次 `getRuntimeState`，所以 Runtime 失败或已重启在用户操作前就可见。
- Refresh 重新拉 catalog；Disconnect 关闭 session 并清空 catalog；runtime 换代自动变 `lost`。
- 可访问性：`accessibilityProvider` 提供行与控件的 aria label；高度 22px、`indent: 8`，沿用 Workbench 主题，不自定义颜色。

## 未采纳的替代方案

1. **Renderer 直接走 `utilityProcess`/`child_process`**：破坏 Electron sandbox 与 ADR 0004 的归属，且 Renderer 会拿到进程句柄（拒）。
2. **ProxyChannel 直接代理 Supervisor**：会把 `request(method, params)` 整个暴露给 Renderer，白名单与参数校验就没了（拒）。
3. **一个全局 `currentConnection`**：多窗口/多 Tab 串库，违反 `06-sql-runtime-safety.md` 第 1 条（拒）。
4. **Main 进程缓存 session 元数据**：多一份可能漂移的事实源；本轮 Renderer 状态已足够，未来缓存必须带 generation（暂缓）。
5. **把 profile 存进 workspace 设置**：数据库路径是用户级资源，不是工作区资源（拒）。

## 后果与限制

- 正面：Renderer 只能看到六个命令；任何越权方法在 Main 进程被拒；Session 与窗口绑定；重启后旧句柄失效而不是误用。
- 负面：多一层 IPC 序列化；`metadata.listObjects` 的 1000 条上限在大 schema 上需要分页（cursor 已在合同里，本轮未在 UI 上做“加载更多”）。
- 已知缺口：无 Query/Result 桥（N-202/N-204）；无连接编辑/删除 UI；无 profile 的“最近使用”排序；Linux/macOS 原生未验证。

## 验证

见 PR 描述与 `docs/nyala-kickoff/PROGRESS.md` 的 P2 记录；单测 `nyalaRuntimeRequest.test.ts`、`nyalaConnectionService.test.ts` 覆盖白名单/参数校验、测试→打开→列目录顺序、失败中止、重启换代与 stale handle 拒绝。
