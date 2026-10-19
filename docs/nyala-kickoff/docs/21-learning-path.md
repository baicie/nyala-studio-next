# 21 · Code OSS / IDE 源码学习地图

学习方法：**先画调用链 → 最小实验 → 写测试 → 回答架构问题 → 才提交产品特性**。源码路径以固定 Tag 1.142.0 为准；若升级则复查实际结构。

## 模块练习矩阵

| 阶段 | 学习内容 | 源码重点 | 必交产物 |
|---|---|---|---|
| P0 | 构建/启动/进程 | `src/vs/code/electron-main`, `build/`, `scripts/`, `product.json` | 启动序列图 + 原生运行日志 |
| P0 | DI/注册 | `src/vs/platform/instantiation`, `src/vs/workbench/workbench.desktop.main.ts` | Hello Service + 生命周期笔记 |
| P1 | IPC/Runtime | Electron Main/Renderer/Service Bridge + Rust async | framing 协议测试与调用 trace |
| P2 | Workbench Views | `workbench/contrib`, `workbench/common/views`, View Pane | Connections Tree + view lifecycle 图 |
| P2 | Editor Model | EditorInput/EditorPane/EditorGroup/Editor Service | 多 Tab QueryContext + restore 测试 |
| P2 | Layout/Theming | `workbench/browser/parts`, Theme Color Tokens | 不改 Core 的 SQL-first 布局 |
| P3 | Extension Host | `src/vs/workbench/api`, `extensions/` | SQL LSP/Completion/Diagnostics |
| P3 | LSP/TextModel | `src/vs/editor/common`, Language Feature Service | SQL 语句范围和补全延迟测试 |
| P4 | 构建/发行 | `build/`、更新系统、签名与 installer | 自有应用身份完整包 |
| EX | Tauri替代 | Electron services vs Rust/WebView adapters | 替换差距矩阵与测量报告 |

## 对每个模块回答五个问题

1. 它由谁创建？生命周期由谁销毁？
2. Service ID/注册入口/依赖方向是什么？
3. 在 `browser/common/node/electron-*` 哪个运行时，为什么？
4. 如果一次上游升级改变接口，哪几个 Nyala 文件需要修改？
5. 如何针对这个模块设计无 UI 单元测试及一个 E2E？

## 推荐实验（不会侵入产品主线）

- `lab/01-contribution-lifecycle`: 打印 Workbench Contribution 激活/Dispose 顺序。
- `lab/02-editor-input`: 定义内存 EditorInput、序列化并在窗口重载后恢复。
- `lab/03-tree-virtualization`: 1 万数据库对象的懒加载 Tree。
- `lab/04-extension-host`: 最小语言扩展启动 + 一条 Completion 请求。
- `lab/05-ipc`: Rust Sidecar 故障注入（半包/kill/timeout）。
- `lab/06-upstream-merge`: 从相邻 Tag 做真正 Git Merge，统计冲突。
- `lab/07-tauri`: 用固定版本 UI 启动 Tauri PoC，记录不兼容服务清单。

## 推荐笔记格式

路径：`learning/YYYY-MM-DD-topic.md`，包含：问题、入口源码、调用序列、自己的最小实验、真实日志/测试、学到的设计理由、尚未理解部分、可迁移到其它 IDE/Agent 产品的结论。

## 最终学习成果

不仅“实现了 SQL UI”，还应该能解释：为什么 VS Code 用 DI 和 Contribution、EditorInput 为什么不同于简单 Tab、为什么 Extension Host 是独立进程、为什么 SQL Query 必须管理 Session/Txn、为何 Tauri 不等于 Rust 化 Workbench。
