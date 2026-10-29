# 28 · Agent Task Workspace UX / Artifacts（设计）

> v1.1 · 交互规范，非当前实现。SQL-first 与 Task-first 是互补，不是二选一。

## 1. 双模式，非双套状态

| SQL Workspace（默认） | Agent Workspace（可选） |
|---|---|
| Editor/Connections/Result/Explain 可见 | Task List/Timeline/Artifact/Approval/Follow-up 可见 |
| 手工查询与精确数据操作优先 | 长任务分解、异步执行、证据审查优先 |
| 右键/选区/Command 启动 Agent | 点击 Artifact 可打开原生 SQL 编辑器 / Grid / Plan |
| 不依赖模型、离线可用 | Provider 故障不阻断 SQL 工作台 |

**统一 identity**：Profile/Session/EditorContext/Execution/Result/Task/Artifact 有各自 ID。切换 workspace 不丢状态、不改变当前执行目标连接。显示任何建议 SQL 时必须可见 database/schema/readOnly 标签。

## 2. 信息架构

```text
Nyala Window
├─ SQL Workspace
│  ├─ Explorer / Connections Tree
│  ├─ SQL Editor (QueryContext per EditorInput)
│  ├─ Results (Tabs, Virtual Grid, Explain, History)
│  └─ contextual actions: Ask / Investigate / Propose
└─ Agent Workspace
   ├─ Task List / Filters (running, waiting approval, complete)
   ├─ Task Detail (goal, scope, model/provider, budget)
   ├─ Timeline (thought summary, tool event, evidence, errors)
   ├─ Artifact Area (SQL draft, Plan, Report, ResultRef)
   └─ Approval Pane (connection + exact SQL + risk + arguments digest)
```

## 3. 重要工作流

1. 在 SQL Editor 选中一段语句，点击 `Investigate with Agent`；仅把必要上下文快照传给任务，敏感信息先预览。
2. Agent 可提出 `read schema` 或 `get indexes` 请求，Task Timeline 显示来源和权限状态。
3. Agent 生成 `sqlProposal` Artifact，不直接执行；用户点击 `Open in SQL Editor` 形成真实 EditorInput，可修改、保存、对比。
4. 对 explainPlan / resultRef 打开 PlanViewer / ResultGrid，保留证据引用；TTL 失效时显示 `Expired`，不能静默拉原始数据刷新。
5. 用户 follow-up 产生新的 Run，关联旧 Artifact 及 ConnectionScope，不复制高敏信息作为永久 prompt。

## 4. 状态机与异常状态 UX

- Task：`queued/running/waiting_approval/completed/failed/cancelled/unknown`
- Artifact：`draft/ready/expired/revoked`
- Approval：`requested/approved_once/rejected/expired/revoked`
- Provider：`not_installed/ready/auth_required/installing/failed/incompatible/offline`

Error UX 需要清晰区分模型限流、工具失败、无连接、权限拒绝、用户取消、Runtime 掉线。`Stop` 只发取消请求，直到服务端承认终止不能谎报完成。UI 更新经 Event seq 去重。

## 5. 设计约束

- 不修改 Code OSS 编辑器内核来做 Agent UI；优先 Workbench contributions、Commands、Views、EditorInput、DI 和 ContextKey。
- 所有控件沿用 `--vscode-*` 主题 Token，支持键盘、屏幕阅读器、窗口缩放与多窗口焦点。
- Agent 输出不能随意复制大结果到文本消息中；使用 Artifact 引用或数据采样预览。
- 对话在 Task 的 Timeline 中只是事件之一，用户必须知道 Agent **做了什么**、**能做什么**、**哪些未得到授权**。
- 模型可用状态不等于用户已授权访问数据库、文件系统或网络。

## 6. 第一版 UI 验收标准

FakeHarness 模拟 tool events + approvals；用户打开 Task、看到 5 类事件、拒绝授权、停止/恢复任务、打开 SQL Proposal、关闭/重启后恢复 Timeline。不得发生跨连接串库或凭证明文显示。真实模型调用非第一阶段的必要测试条件。
