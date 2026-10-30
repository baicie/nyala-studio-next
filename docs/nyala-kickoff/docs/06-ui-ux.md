# 06 · SQL-first UI/UX 规格

## 信息架构

```text
Title Bar: Product · Workspace/Connection Quick Picker
Activity Bar: Connections | SQL Files | History | Search | Extensions | Agent(后续)
Side Bar: Profile Groups > Connection > Catalog/Schema > Tables/Views > Columns/Indexes
Editor Area: Query Tab / SQL file / Table Detail / Explain Compare
Bottom Panel: Results / Messages / Query Plan / Problems / Output
Secondary Side Bar: Inspector / Agent (按需)
Status Bar: Active Profile/DB/Schema · READ ONLY · Query State · Elapsed
```

## 空状态

- 初次启动：主要 CTA 为 `Create Connection`、`Open SQLite File`、`Open SQL File`；展示最近连接但不得暴露凭证。
- 无连接：Editor 仍可离线写 SQL，执行按钮提示选择连接。
- 连接失败：错误类型明确（DNS、Auth、TLS、Timeout、Database Not Found），允许重试，不无限 Spinner。
- 无权限元数据：显示 Partial Access 与错误，不把全部对象显示为空。

## Query Editor

- 顶部环境区：连接名称 + 环境标签 + 数据库 + Schema + 可写状态；运行期间固定此次执行的目标。
- 执行键：选中 SQL 优先；未选中识别当前 Statement；显式 `Run File/Script` 为另一个入口。
- 打开文件 `.sql` 时，不应假定文件绑定了某个连接；关联存储于用户工作区安全设置或临时上下文。
- 编辑器状态 `unbound/ready/running/cancel-requested/error/closed`，与执行任务终态分别维护。
- 查询错误对应行/列与错误区间（后端若没有精确区间，不伪造高亮范围）。

## Results

- 一次执行可能有多个 ResultSet，按执行 ID/Result ID 组织；Result Header 显示 row count known/unknown、affected rows、duration、truncated。
- 固定结果（Pinned）需要显式可用容量、磁盘/内存策略；普通结果可 LRU 释放。
- 类型展示：NULL 与空字符串视觉区分；DECIMAL/BigInt 不丢精度；时间展示时区；BLOB 不默认直接渲染。
- `Copy cell`, `Copy rows`, `Export` 需注明数据来源，导出大量敏感数据时确认权限。

## 视觉质量原则

1. 风格继承 VS Code：对比度/密度/字体/边距一致，避免突然进入独立 SPA 式页面。
2. 信息层级优先：主要操作可发现，次要操作在上下文菜单；警示状态不只靠颜色。
3. 默认内容优先：编辑器及结果表格占主要空间，Agent 不强占宽度。
4. 完全键盘可用：焦点顺序、Context Menu、可访问标签和 Esc 行为明确。
5. 动画克制、无无意义的大面积背景；支持窄窗口与多显示器不同 DPI。

## UI 设计系统

- 颜色优先 `--vscode-*`，自有色由主题 Token 派生。
- 间距单位建议 4px 基线；密度可设置 compact/comfortable，但 MVP 固定一种。
- Icon 优先 Codicon，SQL 领域自有 SVG 经过统一尺寸规范；不要混多套不一致的 icon 库。
- Tree 的 hover、selected、focused、expanded、error 四类状态都需定义。
- 横向表格可滚动，用户列宽保留；Grid 支持屏幕阅读器辅助输出（大型数据与辅助表格分离）。

## 6 个关键交互测试

1. 只用键盘创建连接→新 Query→运行。
2. 分屏两个编辑器：A/B 不同 Profile，执行互不串库。
3. 结果 Grid 1 万行/100 列可滚动，主线程不卡长任务。
4. 用户正在事务中切换 Tab，仍清楚知道目标 Session。
5. Window Reload 后 Draft 恢复、Query 不自动重跑。
6. 高 DPI、macOS 缩放、Windows 多屏幕都不截断工具栏。

## 不做的 UI

不额外开发自定义全局 TabBar/Docking/Command Palette，不复制原 Sidebar 核心源码，不为 SQL 专用页面引入 React Router。局部复杂 Webview 可考虑其他框架，但不得重新封装整个 Workbench。

## v1.1 产品交互决策：SQL-first + Task-first（规划）

Nyala 保持 **SQL Workspace** 作为默认专业界面；额外的 **Agent Workspace** 是面向有界任务的工作区，不把全部 SQL 结果强行嵌入聊天流。

- SQL Workspace：Connections、SQL Editor、多结果 Tab、Explain/History、Keyboard/Theme，用户保留直接控制权。
- Agent Workspace：Task List + Timeline + Artifacts + Approval + Follow-up；任务可以从当前 SQL 选区、Schema Tree、Result、Plan 发起。
- Artifact 必须是一等 IDE 对象：SQL Proposal → EditorInput；Explain → Plan Viewer；Result → Grid；Change → Diff/Approval，不只保留 Markdown 消息。
- 模式共享 Query Context 与任务持久化身份，默认不共享原始数据库凭证、全表数据或隐藏的生产执行权限。

目标交互和验收请见 [28](28-agent-workspace.md)、[31](31-sql-workspace-product.md)。本节为设计，不是当前 UI 已实现功能的描述。
