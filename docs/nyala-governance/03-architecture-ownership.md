# 03 · 架构职责、目录边界、所有权

## 主体分层

```text
Workbench Renderer
  -> Nyala Contributions / Application Services (TS)
      -> Nyala Runtime Bridge / Electron main supervisor
          -> versioned IPC (nyala/rpc/v1)
              -> Rust SQL Runtime / Drivers
                  -> Database
SQL Language Extension / LSP -> Public capabilities / protected Service APIs
Agent Workspace -> Nyala Agent Service -> policy/tool gateway -> SQL Runtime
```

所有数据库执行以 Rust Runtime 为 Nyala 官方权威路径；**第三方 Node 扩展本身不是可强制隔离的沙箱**，不得对它作不实安全保证。

## 目录责任表

| 路径 | Owner/责任 | 原则 |
|---|---|---|
| `src/vs/workbench/contrib/nyala/*` | Nyala 专用 UI/命令/编辑器 | 按 `browser/common` 分层，用 DI/Disposable |
| `src/vs/workbench/services/nyala/*` | 真正的跨 Contribution 服务 | 不创建仅供一个 View 使用的全局服务 |
| `nyala/rpc/**` | TS/Rust 跨进程合同 | 不再各自手写互相矛盾的 DTO |
| `scripts/nyala/**` | Nyala 校验/产品操作 | 避免修改 Code OSS 自身 Gulp/Build 输入 |
| `rust/crates/nyala-*`（规划） | Runtime/SQL Driver/Tool policy | 平台中立，管理资源与取消 |
| `extensions/nyala-*`（规划） | Language/Extension API 能力 | 尽量用稳定 API，避免私有 Workbench import |
| `src/vs/base,editor,platform` | Code OSS 上游 | 最后手段，改动需附 ADR + Patch Ledger |
| `product.json`/`build`/`resources` | 发行产品化补丁 | 每次上游同步专门核对 |

## 边界规范

- Workbench View 不直接连接数据库、不持有密钥、不创建私有驱动；共用一个 Query Authority。
- 连接/Profile、Session、Tab、Transaction、Execution、Result 不能共享一个可变 `currentConnection`，需要独立身份和代际 `generation`。
- Electron 只是宿主；Tauri 研究分支不得把 Tauri API 传染给 SQL Domain。
- Workbench 内跨 Contribution 使用 Service/接口，避免 `browser/*` 循环依赖；不要颠倒 VS Code 的 `base → platform → editor → workbench` 方向。
- 新增 Handler/Worker/Sidecar 必须有 Owner、启动/关闭、断线/取消/过期与资源释放；跨窗口共享状态需说明隔离级别。

## 架构审查问题

1. 这项需求是否可以在 Nyala Contribution 实现？如不能，为什么必须改上游？
2. 接口是否已经存在于现有 Workbench service / Extension API？
3. 断线、重启、取消、重放、并发是否有正确状态？
4. 对更新至下个 Code OSS Tag 的冲突面如何？
5. 是解决用户问题，还是无意义地自研原生框架？

**避免过度设计：** 不因学习需要一次性替换 Workbench、DI、Extension Host、Node 或构建系统；创新放到有边界的实验分支。
