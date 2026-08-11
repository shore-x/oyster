# ADR-0002：统一 Repository 与独立 Knowledge Task 工作空间

- 状态：Accepted；已实现
- 日期：2026-08-06
- 修订：2026-08-10，采用明确的 Task / Round / Invocation 术语并统一工作空间文件名
- 取代：Knowledge/Artifact 分离物理存储、Contribution Draft、独立 collaboration repository、每次业务尝试的 worktree 和单例 `.oyster/WORK.md`
- 关联文档：[统一 Repository、全局事实层与 Knowledge Task](../architecture/unified-git-agent-collaboration.md)、[术语与执行模型](../architecture/terminology.md)

## Context

Knowledge 位于 SQLite、Artifact 位于独立 Git Repository、加工又位于 collaboration repository/worktree 时，同一现实状态被拆成多套权威位置。单例工作清单无法区分不同业务尝试，而无前缀 `Run` 又同时可能表示业务尝试、Agent 执行或模型调用。

另一方面，若 Maintainer 的目标与证据只通过 Observation 专用工具传入，文件型任务、普通附件和固定证据快照会被表达成额外领域能力。Agent 的目标、输入和工作状态缺少一个可直接检查、持久交接的统一工作面。

## Decision

Oyster 只有一个标准 Git Repository 和一个物理工作树。根目录固定包含：

- `knowledge/`：全局唯一 Knowledge；
- `artifacts/`：全局唯一 Artifact；
- `tasks/<taskId>/`：Knowledge Processing Task 的持久工作空间与终态历史。

Knowledge Processing Task 表示一次业务尝试，使用独立 `tasks/<taskId>/`：

- 固定 `BRIEF.md` 表达目标、Source Snapshot 与 Repository 坐标；
- 固定 `inputs/` 保存 Canonical Activity、从 Raw Evidence 固定行模型生成的 locator 文本页和附件；
- 可变 `PROGRESS.md` 保存 Maintainer / Reviewer 清单与 handoff；
- `manifest.json` 固定目标、输入、初始工作定义和 Task 创建时 Knowledge/Artifact 的 Repository 状态指纹；
- `pi-sessions/` 保存 Task 内各 Knowledge Agent Invocation 的 Pi Session；`task.json` 保存不可变终态状态、配置、结果或错误以及精简 Agent Invocation envelope，完整活动由应用级本地 Debug Store 保存。

Task 使用 `knowledge-task/<taskId>` branch。它不拥有 Knowledge 或 Artifact；`tasks/` 不进入候选内容 commit，Task workspace 不是 Git worktree，也不包含领域文件副本。

Maintainer 与 Reviewer 是稳定的 Knowledge Agent Definition。一次 Collaboration Round 由一次 Maintainer Agent Invocation 和一次 Reviewer Agent Invocation 构成。Reviewer 要求修改时开始下一 Round 和新的 Maintainer Invocation；批准时 Task 完成。每次 Invocation 内部再记录 Agent Turn、Model Call 与 Tool Call，不能用 Task ID 代替 Invocation ID。

Maintainer 与 Reviewer 从 Task workspace 启动，只使用普通 `read`、`bash`、`edit`、`write`。Maintainer 创建 Knowledge/Artifact commit；Reviewer 请求修改时创建带 Review marker 的反馈 commit，批准时不创建新 commit。Host 在每次 Invocation 启动和 handoff 时校验固定 workspace、branch、Repository 指纹、清单、marker 与精确 revision。Reviewer 不 merge。

统一 Repository 只有一个物理工作树，当前进程内同时只允许一个结构化知识加工角色执行。这只是完整性门禁，不引入队列、租约或通用并发治理。

Reviewer 不读取 `inputs/` 是 System Prompt 和上下文定义的行为边界，不是文件系统权限边界。这组角色和交接规则只属于结构化知识加工，不自动适用于其他 Artifact 维护方式。

Task 活动态统一为 `in_progress`，终态为 `completed`、`failed` 或 `cancelled`。终态 Task 不可重开，重试创建新 `taskId`。Source Snapshot 在 Task 接受前被拒绝时不创建 Task。低版本 Task 历史读取时删除，高版本记录保留并明确报错。

## Consequences

- 一个路径和一个 revision 可以解释 Knowledge/Artifact 的共同状态；
- 每次业务尝试都有独立、可检查的文件工作面，不会与其中的 Agent 执行混淆；
- Task、Round、Invocation、Turn、Model Call 与 Tool Call 各有明确身份和所有权；
- 固定输入与 Task 历史稳定存在，同时不会污染候选内容 diff；
- Agent 使用相同普通文件能力，不需要 Observation 专用工具；
- Maintainer / Reviewer 不成为 Artifact Domain 的全局角色；
- 不需要 Git worktree、领域副本、symlink 或跨 Store 同步；
- 固定 Source Snapshot 的 Task-local 副本增加持久存储与敏感信息管理责任；
- 多进程并发、强权限隔离、promotion 和远端治理延期到有明确需求时决定。
