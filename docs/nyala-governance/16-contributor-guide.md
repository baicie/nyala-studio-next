# 16 · 贡献者与 AI 编码协作约定

## 初次参与

先读 `docs/nyala-kickoff/START-HERE.md`、`AGENTS.md`、`.github/copilot-instructions.md`、治理 `INDEX.md`。运行最小已有校验，再选择一个有明确 Acceptance Criteria 的 Issue。

## Definition of Ready

Issue 必须有：用户场景/当前行为/期望行为/最小边界/依赖/验收方法/不在范围内。跨上游补丁必须给出为何不能使用原生 Contribution/Extension API。

## 与 dsh/Codex 等 Agent 协作

- 每次任务先审查当前 HEAD、工作树、相关代码；不得凭旧报告宣称功能已经存在。
- 先分析后修改，小步提交，保留人工可审查的 diff；大量依赖或自动生成文件要专门说明。
- 工具执行只报告真实结果，不虚构已跑测试/已推送分支/已完成 PR/已部署或已发行。
- 尊重本仓库签名与 Git Hook，不强行跳过；保护既有用户修改和临时文件。
- 需求与能力不明时做最小探针；对失败路径、资源释放、数据安全写测试。

## Review

至少看：是否误改微软上游大面积路径、架构边界、事务/权限/秘密、SQL 错误状态、回归范围、文档/ADR 真实性。当前若受 CI 账单限制，不能仅因 Agent 自述测试通过就视为在线验证完成。
