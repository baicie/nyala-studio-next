# 10 · SQL 编辑器、语句识别与语言服务

## SQL Editor 设计

默认采用 Code OSS 原生 TextModel/Editor 与 Workbench `EditorInput`/`EditorPane` 集成。普通 `.sql` 文件仍使用已有文件编辑能力；“临时 SQL 查询”提供 Nyala Query Document 及独立连接上下文。两者共享 SQL 语言服务。

## 需要区分的概念

- `Document`：SQL 文本/语言/版本，可能是文件或无文件 Draft。
- `QueryContext`：数据库 Profile、DB/Schema、只读状态，默认绑定当前 Tab 而非全局单例。
- `ExecutionRange`：当前 Statement/Selection/Script 的准确范围和文本快照。
- `ExecutionRecord`：以执行开始时 DocumentVersion/SQL 快照关联，不随编辑器后续输入改变。

## 快捷键与行为

- `Ctrl/Cmd+Enter`：若有 Selection，执行 Selection；否则执行 Cursor 所在当前 Statement。
- `Run All` 必须是独立显式操作；多语句批处理如何处理事务与错误需要详细模式。
- `Explain`：独立命令，依据 Capability 启用；`EXPLAIN ANALYZE` 二次明确审批。
- 编辑器顶部显示连接/Schema、状态/readonly，运行时冻结本次目标，不能切换 Tab 导致执行错库。

## Statement Parser

不能按 `;` 直接 split：字符串、注释、PG dollar-quote、MySQL delimiter、函数体等都可能包含分号。优先使用 dialect-aware parser/tokenizer；无法可靠识别时执行 `Selection` 或让用户显式 `Run Script`，不要臆造范围。

## LSP 架构

```text
VS Code SQL Extension (Language Client)
  -> SQL LSP Server (Rust / TS 选择后冻结)
    -> SQL parser & dialect resolution
    -> Metadata Snapshot API (read-only, limited)
    -> Diagnostics, Completion, Hover, Definition, Formatting
```

首发无需复杂 SQL 语义分析；实现关键字、表/列/Schema 补全，并缓存数据源版本。LSP 无需持有完整数据库凭证，只能请求受控 Metadata API。网络不可用时降级到关键词/本地文本补全。

## 数据库上下文同步

编辑器 ConnectionProfile 变更时向 LSP 发语言服务上下文更新（自定义事件/请求）。元数据更新附 generation，防止过期列信息覆盖新 Schema；带 TTL 与手动刷新。

## 提示与安全

LSP 不自动执行 SQL 以提供补全。Explain 是显式工具。自动补全不可嵌入未转义 identifier，必须按 Driver Quote 策略；SQL 参数绑定用于查询执行而非简单拼接字符串。

## 必需测试

- 语句中分号位于字符串/注释；选区跨多条语句。
- 两个 Tab 不同数据库 Schema 的补全结果不会串。
- 大文件 / 10k 行 SQL 的补全响应时间与 cancellation。
- 网络离线与权限不足的降级提示。
- 跨平台键位冲突与 Cmd/Ctrl 差异。
