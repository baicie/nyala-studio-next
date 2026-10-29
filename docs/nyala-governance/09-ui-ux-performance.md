# 09 · UI/UX、可访问性、性能、编辑器原则

## 产品原则

- SQL-first，但沿用 VS Code 原生 Workbench：Editor Groups、Command Palette、Tree、Keybinding、Context Keys、Themes、Status Bar。
- Agent 是可切换 Task Workspace，而不是把整个应用变成聊天窗口；Result Grid、SQL Editor、Plan Viewer 都是一等工作对象。
- 以用户完成的操作为设计粒度：连接 → 编辑 → 执行 → 结果 → 保存/恢复；错误和取消也有完整状态。
- 默认界面克制：简单主体、适量留白、精确视觉层级，不为了产品炫技添加过多按钮或嵌套面板。

## VS Code 一致性

- 优先 `--vscode-*` 主题 token、Codicon、`localize` 和平台原生 Context/Menu；禁止把上游 CSS/Workbench Layout 整体覆盖来实现 Nyala 外观。
- 多 Tab、分屏、拖动、重启后 Draft/视图恢复；至少一个键盘-only 场景和深浅色主题测试。
- 高对比度、缩放、Screen Reader 标签、错误通知可用；所有仅用颜色区分的状态要增加文本/图标。
- SQL 连接/执行状态显式展示目标 Profile、Schema、事务/Read-only；避免“执行时偷偷使用当前树选中连接”。

## 性能预算（建议作为实验目标，非已经达成的承诺）

- 记录冷启动、Workbench ready、第一次输入延迟、连接树大数据量、Result Grid 滚动 FPS/RSS。
- 结果表不一次性渲染所有单元格：虚拟行/列、分页缓存、释放过期 handle；20×100,000 行作为早期压测数据集，不代表需要全量载入。
- 大 Schema 查询按需展开、增量加载、取消；异步任务离开视图后清理，不阻塞 Renderer。
- 每次视觉重构尽量提供 before/after 图与键盘操作录屏，避免“UI 变漂亮但 Workbench 行为回归”。
