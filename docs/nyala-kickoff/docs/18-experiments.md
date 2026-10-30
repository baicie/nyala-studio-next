# 18 · Tauri、极限裁剪与 AI Agent 的隔离实验

## 实验原则

任何实验必须有：固定基线 SHA、研究假设、预算（时间/改动量）、可量化指标、成功/终止条件、是否合并的正式 ADR。实验**不得成为 Electron 主线的编译依赖**。

## E1 · Tauri runtime substitution

### 假设

在保留核心 SQL IDE 用户体验的前提下，以系统 WebView + Rust 替换 Electron 可显著减少安装包体积，并且 Node Extension Host/Workbench 功能仍可接受地工作。

### 分阶段验证

1. **启动 PoC**：在固定 Code OSS Release 的 Tauri 窗口中显示基本 Workbench，不要求 Extension Host。
2. **Platform Services**：窗口、菜单、快捷键、Dialog、File、Clipboard、IPC、Storage 的最小映射；记录每个 VS Code Service 修改数量。
3. **SQL Runtime**：复用同一 Rust Domain，连接 SQLite/执行/Result Grid；验证不修改业务合同。
4. **Extension Host**：真实 Node 扩展与至少一个 SQL LSP 扩展运行，收集 Node Sidecar、Native Modules、Webview/Worker 兼容问题。
5. **性能/尺寸**：分别统计 Installer、Installed Size、启动四阶段、RSS 进程树、CPU、UI 滚动及不同 OS WebView 渲染。

### 停止阈值（实验建议）

- 如果必须修改 Workbench 大量核心服务/无法维持 Node Host，则评估为研究完成、生产暂不采用。
- 安装包相比 Electron 没有明显收益（可以初期采用 `>=50%` 减少作为追求目标，但不是承诺）或启动/UI 有明显退化，不合主线。
- Windows/macOS 渲染差异不可接受而需大量 CSS 补丁，暂不推进。

## E2 · Minimal Workbench / Packaging

独立 `experiment/minimal`，优先减少内置扩展/资源，并测构建输出贡献；再尝试取消贡献项注册。不靠物理删源码衡量成功，而以 Installer bytes、Installed size、startup、用户功能回归衡量。

## E3 · Safe SQL Agent（0.4 之后）

**目的**：学习 Agent Tooling，并辅助真实 SQL 工作，不为市场营销做泛聊天机器人。

最小工具：`listConnections(safe)`、`listSchema`、`getExplainPlan`、`proposeSql`、`requestReadOnlyExecution`、`generateReport`。

- 模型默认不可执行写 SQL，写操作通过明确显示目标连接/SQL/影响范围的审批面板。
- Agent 使用受控 `QueryService`，任何外部工具调用均有权限和输入上限；不能直接把任意文件系统或 database secret 暴露给模型。
- Evidence Store 可记录用户选中的 SQL、Plan、时间/数据库版本；发送远端 LLM 前明确确认和隐私政策。
- Prompt Injection 风险：表名、Schema 注释、查询结果都是不可信输入，不能被视为权限指令。

## AI 设计决策门槛

在 P2 日常查询闭环稳定、权限/执行审批真正可用前，不允许 Agent 自动编排真实数据库写操作。

## 实验记录模板

使用 `templates/EXPERIMENT.md`，保存对应对比机器、版本和可复现实验脚本。实验可以失败，但需要保留工程结论，而不是仅留下一个未完成分支。

## v1.1 E3 的拆分（不改变 Agent 非 SQL MVP 的 ADR）

- **A0（设计期）**：定义 Task/Run/Event/Artifact、HarnessAdapter、ToolGateway/Policy 接口，禁止真实模型自动数据库执行；可与 P1 并行文档研究。
- **A1（只读原型）**：在稳定 Query Authority 后，用 Mock Harness 与可选 Codex app-server PoC，完成进程启动、Thread/Turn 生命周期、流式事件、断线与取消；默认不给 Shell/File 任意权限。
- **A2（工作区）**：Task Pane、Artifact 到 SQL Editor/Result/Plan 的映射；Event 状态恢复。
- **A3（分析）**：Schema/Index/Explain 实际工具链，评价成本/准确率/误操作率。
- **A4（受控执行）**：跨请求策略、审批绑定参数哈希、数据外发控制；写操作仍需额外安全评审，非默认能力。
- **A5（研究）**：Native Harness、第三方 Harness 适配和差异测评，不将自研通用 Agent Loop 当作前置条件。

必须给每个实验标明版本锁定、平台、上游接口兼容性、终止条件，并在 Agent 无法安装时确保 SQL IDE 可正常工作。见 [27](27-agent-platform.md)–[30](30-agent-security-evaluation.md)。
