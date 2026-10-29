# 29 · Codex App Server 与 Runtime Manager（分发/生命周期设计）

> v1.1 · **候选集成方案**。目前仓库尚无 Codex Runtime 自动安装、模型认证与 Agent UI。官方接口以选定的 Codex **具体版本**及其协议 schema 为准。

## 1. 定位

Codex App Server 提供 Agent 线程/任务执行/工具和审批相关的双向事件协议，Nyala 负责自有 Task UI、数据库 Context、权限、Artifact 和生命周期。**集成独立可执行程序，不把 Codex Rust Core 混入 Code OSS 或 Nyala Rust SQL Runtime**。

默认候选路径：`Nyala Workbench → Agent Service → Codex Adapter → 独立 codex app-server 进程`。该进程与 `nyala-runtime` 是两个不同受控子进程；Code OSS/Microsoft 原生 Chat 继续保持独立。

## 2. 三种供应模式

| 模式 | 用途 | 默认策略 |
|---|---|---|
| External Binary | 开发/高级用户指定本机 Codex 路径 | 第一轮 PoC 首选，无下载安装复杂度 |
| Managed On-demand | 用户启用时下载/安装经过版本审计的二进制 | 通过供应链/许可/签名审核后实施 |
| Bundled | 发布包内置各平台可执行文件 | 只有在体积/法律/离线目标明确时考虑 |

**不做静默下载安装**。首次安装或使用外部 Codex 应明确用户授权、目标版本、下载来源、大小、登录/数据传输含义。可以关闭 Agent 而保留 SQL IDE 全功能。

## 3. 最小 RuntimeManager 接口（草案）

```ts
interface RuntimeManager {
  detect(): Promise<RuntimeInstallation | null>;
  verify(path: string, expected: RuntimeManifest): Promise<Verification>;
  install(manifest: RuntimeManifest, consent: UserConsent): Promise<RuntimeInstallation>;
  start(config: RuntimeLaunchConfig): Promise<AppServerTransport>;
  stop(reason: string): Promise<void>;
  rollback(): Promise<void>;
  status(): RuntimeStatus;
}
```

**进程监督**：限定子进程执行路径、固定参数和可控环境变量，不通过 Shell 拼接命令；使用 stdio JSONL/或所选 Codex 版本的官方传输；解析 stderr 为日志且脱敏；请求 ID、并发/缓冲、timeout、退出信号、重启 backoff 与资源清理必须有测试。严禁通配工具把任意 shell/network 权限交给 Nyala SQL Agent。

## 4. 协议适配与版本策略

- 每个发布周期固定 Codex 二进制版本与来源 SHA；记录支持的 OS/architecture、安装来源、许可证与第三方 Notices。
- 用选定 Codex 版本生成/获取官方协议类型；**不得手写大量猜测的 RPC 字段并宣称兼容**。
- 起步路径通常是 initialize / initialized、thread/start 或 resume、turn/start、流事件、turn/completed；具体字段和通知以所锁版本的 schema 校验。
- Adapter 负责把 Codex Thread/Turn/Item 映射成 Nyala Task/Run/Event；接口变化时只调整 Adapter，不直接污染 Nyala Domain。
- Unknown event 可存档并降级展示；协议重大不匹配停止新 Task，保留 SQL 功能，向用户展示可理解的错误。

## 5. 认证与凭证边界

- 用户选择受 Codex 官方支持的登录/凭据方式；Nyala 不应承诺任意 OpenAI 兼容网关都能使用 Codex 原生认证。
- Token/key 不进入 Renderer、普通日志、Schema/Artifact 或崩溃报告；独立 OS Secret 管理，进程环境要最小化。
- 登录退出、Token 更新、凭证过期、Provider 异常要有回退；用户安装 Runtime 不等于自动拥有模型额度。
- 远端模型可能收到用户 SQL/Schema，必须有明确发送预览、权限与隐私告知；生产数据默认不外发。

## 6. 下载与升级安全

Manifest 至少包含 `version`, `platform`, `arch`, `source`, `sha256`, `signatureInfo`, `protocolVersion`, `licenseRefs`；可信 HTTPS 下载到暂存目录、校验 SHA256 和适用签名、验权、原子换代、保留回滚版本。拒绝不匹配/来源不明/未校验的二进制，禁止关闭 TLS 校验以求成功。

共享机器上区分 UserData 与 Managed Runtime；不同版本并存、前台任务正在运行时不热替换可执行文件，升级期间保留正在执行的进程直到明确停止。

## 7. 正向与负向验收

1. 无 Codex 安装 → SQL Editor 与 SQLite Query 正常打开，Agent UI 标示未启用。
2. 用户指定外部 Codex → 检查版本/协议后可启动会话。
3. 运行中强杀子进程 → 有明确失败/unknown，UI/SQL Runtime 不中断。
4. 版本不兼容/认证失效/网络离线 → 清晰错误与恢复路径，不误报任务完成。
5. 用户拒绝工具审批/远端数据外发 → 不发生相应 IO。
6. 安装包污染、校验失败、更新失败 → 拒绝执行且能回滚。
7. Windows/macOS/Linux 适配按真实平台验收，不以一个平台通过推定全部兼容。

## 8. 源码参考

- 官方 App Server：<https://github.com/openai/codex/tree/main/codex-rs/app-server>
- 协议目录：<https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol>
- 集成参考：<https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server>

官方接口具有演进性；设计文本不是对所有未来版本的 API 保证。
