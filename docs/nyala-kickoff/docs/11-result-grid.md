# 11 · Query Result Grid 与类型保真

## 核心目标

在 Workbench 原生布局内提供 SQL 结果集 UI：低延迟首屏、受控内存、虚拟行列、稳定选区、可复制导出、数据库类型保真、明确未知总行数/截断状态。先实现只读 Result Grid，再考虑单元格编辑（后续重度能力）。

## 结构

```text
Query Execution -> ResultHandle -> PageCache -> RowModel -> VirtualViewport -> CellRenderer
                                                -> SelectionModel -> Copy/Export
```

### 部件

| 部件 | 职责 | 禁忌 |
|---|---|---|
| ResultHandle | Server/Runtime 游标与 TTL | 不内嵌百万行 |
| PageCache | LRU，限制 Byte/Rows，取消预取 | 无限缓存 |
| ColumnModel | name/index/nativeType/precision | 丢重名列 |
| Viewport | 虚拟滚动、ResizeObserver | 长列表全 DOM |
| SelectionModel | Cell/Range/Row，稳定列 ID | 依赖当前滚动 DOM |
| CellRenderer | Tagged values、多行预览 | 用 `JSON.stringify` 随意展示所有类型 |
| Exporter | 受控流式导出、编码、引号 | 先加载全部行 |

## Result 总行数与分页

有些数据库/语句无法在执行开始时给出总行数，UI 使用 `knownRowCount?` 和 `hasMore`；Result Page Cursor 不透明，过期后允许用户重新执行（只读查询可由用户确认）而非偷偷重放。不要把 `LIMIT/OFFSET` 改写作为所有 SQL 的通用分页机制。

## 大结果策略

建议初期限制：首屏最多 200 行/请求、单页字节限制、并发 Fetch 上限、缓存 Byte 预算和 Result TTL。所有数值是**待基准校准的默认候选值**。核心验收：100k 行数据集不会导致 100k 个 DOM 行，结果内存随窗口/缓存上限受控。

## 数据类型

- NULL 单独渲染 `NULL`（不是空字符串）。
- Decimal/BigInt 使用文本承载精度；默认不经过 JS Number。
- Timestamp/Timestamptz 区别处理时区；按源 DB 语义展示原值与规范化值。
- Bytes 大于阈值展示 `[BLOB size]`，需要授权后 Chunk 读取。
- JSON 长文本独立 Preview；Markdown 或 HTML 内容当做纯文本处理，防止 Renderer 注入。
- 同名 Column 以 ordinal 编号标识，Selection/Export 不依赖 columnName 唯一。

## 操作规范

- Ctrl/Cmd+C 复制当前 Selection，可选择 TSV、CSV、带 Header；注意 CSV formula injection 风险。
- 导出默认只导出可见/已载入行或显式选择“完整结果”，二者 UI 文案必须不同。
- 完整导出必须 Server/Runtime 流式执行并重新校验 Query/Export 权限及资源限额。
- 编辑网格后续需严格检测主键/唯一键、乐观并发和事务回滚；首版禁用编辑操作。

## 性能/可用性指标（建议目标）

- 目标设备 10 万行 × 20 列 / 宽表 100k × 100 列可保持可操作；不保证全部在内存内。
- 滚动接近 60 FPS 作为体验目标（需在目标 OS/CPU 上测试）。
- 主线程 Long Task、GC、Renderer RSS、Sidecar RSS、首屏延迟均采样。
- 结果切换、窗口 resize、多显示器 DPI、键盘选区、无障碍回归。

## 测试数据集

`500 rows`, `10k×20`, `100k×20`, `100k×100` 的合成表；专门增加 NULL、重复列名、长字符串、Emoji、Decimal、BigInt、Binary、JSON、Timestamp。`100k×100` 只作为压力场景，不要求内存同时加载 1000 万 Cell。
