# 05 · Workbench 深度集成设计

## 标准扩展与内部 Contribution 的选择

| 场景 | 首选 | 原因 |
|---|---|---|
| SQL 文件高亮/补全/格式化 | VS Code Extension / LSP | 稳定 API，易升级 |
| 连接树（官方产品的一等视图） | Workbench 内置 Contribution | 可控制默认 SQL-first 布局 |
| SQL Query Editor Tab | EditorInput + EditorPane（内部） | 要有原生 Tab/Group/恢复/上下文 |
| Result Grid 和 Query Plan | 内置 Pane/Editor | 多结果工作区深度布局 |
| SQL Agent 第三方入口 | 扩展工具 / MCP | 隔离实验/高变更层 |
| 设置/主题/快捷键 | 已有 Registry/Services | 不造第二套 |

## Workbench 核心构件

- `IEditorService`：打开/恢复编辑器，Context-aware Input。
- `EditorInput`：Editor 唯一身份、dirty/save/serialize、资源 URI、标题。
- `EditorPane`：实际编辑/Widget 生命周期，布局 Resize，Disposable 资源。
- `IViewsRegistry` / `IViewContainersRegistry`：Connections、History、Catalog。
- `ICommandService` / Actions / Menus / ContextKeys：执行上下文命令和快捷键。
- `IStorageService`：UI 状态、最近打开项（业务历史另外管理）。
- `IThemeService` / Color Registry：主题；不要全局任意 CSS Selector 重写。
- `WorkbenchContribution`：生命周期启动/懒加载与释放。

## QueryEditor Input 身份

`nyala-query://local/<query-id>` 或另一个内部自定义 Scheme；URI 不得包含用户名、密码、数据库连接串或 token。

```ts
// 领域草图，调用细节需按所选 Code OSS Tag 验证
interface QueryEditorState {
  queryId: string;
  profileId: string | null;
  defaultDatabase?: string;
  defaultSchema?: string;
  draftVersion: number;
  readOnly: boolean;
}
```

- `queryId` 稳定，`EditorInput` equality 按 Query identity 设计；不同 Group 中可复用同一模型但不同 View 状态。
- 当前连接以 **Tab 的 QueryContext** 决定，不受全局活动连接的隐式影响。
- Restore：恢复 SQL 文本、选中的连接 Profile（不自动建立未知网络连接、不自动执行）。
- `Save`：可保存为普通 `.sql` 文件；无文件草稿由内部 DraftStore 保存；两者的 Dirty/Autosave 语义分开。

## Commands（首次注册）

`nyala.connection.add`, `nyala.connection.refresh`, `nyala.query.new`, `nyala.query.executeSelection`, `nyala.query.executeCurrent`, `nyala.query.cancel`, `nyala.result.export`, `nyala.result.release`, `nyala.context.changeConnection`。

所有写类 Action 以 ContextKey（`nyala.connectionWritable`）、执行前服务端鉴权等双层约束；ContextKey 只控制可见性，不是安全授权。

## 生命周期检查表

- UI `dispose()` 时释放 Event/DOM/ResizeObservers、定时器、Grid 内存；不误杀其他 Tab 的 Query。
- 查询仍运行时关闭 Editor，按照设置询问取消/后台继续，不默默取消或重定向。
- 同一 Profile 可以创建多个 Session，事务专有 Session 不进入普通连接池。
- window reload/restart 时 IPC 断开必须将 in-flight 任务标为 `unknown/interrupted` 并尽量释放资源。

## 主题与布局

主题选择遵守上游 ColorRegistry/Tokens，并定义 `nyala.*` 命名 Token；默认打开 Connections Side Bar、QueryEditor 区、Results Panel，允许完整用户自定义布局。不修改全局 SplitView 算法去追求新视觉效果。

## 跨平台键位

`Ctrl/Cmd+Enter` 执行当前语句或选区，必须验证与上游/插件的命令冲突；保留键位映射可配置。要有 Command Palette 入口与可发现 Tooltips，而不是硬编码 shortcut。

## 研究问题

每次实现前回答：这项功能应该是一个 View、Editor 还是 Panel？它在什么生命周期创建/释放？数据归谁所有？会不会影响上游升级？记录在 PR 描述。
