# CI 因账户问题无法运行时的处理

1. 打开失败的 Run，读取 Job 及步骤：如果 Job 没启动，分类为 `BLOCKED (account/runner)`。
2. 复核账单/额度/Runner/权限；**只有仓库所有者可改变账户计费设置**，Agent 不应擅自升级套餐。
3. 不通过删除 Workflow、忽略 Check、改名绕过门禁来假装绿灯。
4. 开出 CI 基础设施 Issue，记录受影响的工作流，哪些验证在本地执行、哪些未执行。
5. 仓库恢复在线 CI 后重跑与 `nyala/main` 相同 SHA 的必需检查，再更新可发布状态。
6. 若必须在 CI 不可用时合并非关键文档变更，PR 中显式写 `exception/owner/risk/rollback`；上游合并/安全/发行不默认享受例外。
