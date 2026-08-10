# ADR-0002：统一 Repository 与独立 Run 工作空间

- 状态：Accepted；已实现
- 日期：2026-08-06
- 修订：2026-08-10，引入每次知识加工独立的文件工作空间，并明确 Maintainer/Reviewer 不是 Artifact Domain 的全局角色
- 取代：Knowledge/Artifact 分离物理存储、Contribution Draft、独立 collaboration repository、每 Run worktree 和单例 `.oyster/WORK.md`
- 关联文档：[统一 Repository、全局事实层与 Run](../architecture/unified-git-agent-collaboration.md)

## Context

Knowledge 位于 SQLite、Artifact 位于独立 Git Repository、加工又位于 collaboration repository/worktree 时，同一现实状态被拆成多套权威位置。把工作清单固定为 `.oyster/WORK.md` 又把 Run 状态误表达成单例，无法清楚区分不同次加工。

另一方面，若 Maintainer 的任务与 Observation 只通过 `read_activity`、`read_activity_attachment`、`read_evidence` 等专用工具传入，文件型任务、普通附件和固定 Evidence snapshot 会被表达成额外的领域能力。Agent 的任务说明、输入和工作状态缺少一个可直接检查、可持久交接的统一工作面。

## Decision

Oyster 只有一个标准 Git Repository 和一个物理工作树。根目录固定包含：

- `knowledge/`：全局唯一 Knowledge；
- `artifacts/`：全局唯一 Artifact；
- `runs/<run-id>/`：一级、持久的工作过程。

一个结构化知识加工 Processing Run 使用一个独立、持久的 `runs/<run-id>/`：

- 固定 `TASK.md` 表达任务与全局 Repository 坐标；
- 固定 `inputs/` 保存选中确定版本的 Canonical Activity、从 Raw Evidence 固定行模型生成的 locator 文本页和附件文件，并由 `README.md` 解释格式；
- 可变 `WORK.md` 保存 Maintainer/Reviewer 清单与 handoff；
- `workspace.json` 以路径、大小和 hash 固定 `TASK.md` 与 `inputs/`，绑定初始 `WORK.md` 定义，并记录 Run 创建时 Knowledge/Artifact 的 Git status、tracked working-tree diff、staged index diff 与未跟踪普通文件或 symlink 的 Git mode 和内容指纹；这既阻止另一份任务清单复用同一 Run，也使进入 Run 的已有 Repository 修改成为显式输入。当前可变 `WORK.md` 不要求保持初始 hash。上游 `sourceRef` 仍单独绑定外部原始字节；
- Full Chain 的终态 `run.json` 保存配置、结果和完整 Agent Run records；当前单阶段 Debug Run 不生成该文件。

Run 不拥有 Knowledge 或 Artifact。`runs/` 不进入候选内容 commit，Knowledge/Artifact 始终位于全局目录，其状态由 Git revision 区分。Run 工作空间不是 Git worktree，也不包含领域文件副本。

Maintainer 与 Reviewer 从本次 Run 目录启动，都只使用普通 `read`、`bash`、`edit`、`write`。它们依据 `TASK.md` 访问全局 Repository；专用 Observation 读取工具被文件输入取代。在结构化知识加工工作流中，Maintainer 创建 Knowledge/Artifact commit；Reviewer 请求修改时创建带 Review marker 的反馈 commit，批准时不创建新 commit。Harness 在角色启动前校验固定 workspace、processing branch 和精确 revision，并拒绝域外脏文件；新 Run 首个 Maintainer 可以接收 manifest 已固定且启动前重新验证的 Knowledge/Artifact working tree、index 与未跟踪文件，Reviewer 与后续 Maintainer 则从干净工作树启动。无法由外层 revision/diff 唯一表达的 nested working-tree 未提交内容不会被接受为 Run 输入。Harness 在 handoff 时校验干净工作树、工作清单与 marker，再在 `WORK.md` 自动记录角色和精确 candidate OID。Reviewer 不 merge。

统一 Repository 只有一个物理工作树，当前进程内同时只允许一个结构化知识加工角色运行。这只是防止 Maintainer/Reviewer 或两个 Run 交叉修改同一工作树的完整性门禁，不引入队列、租约或通用并发治理。

一个完整闭环中的多次 Maintainer/Reviewer 调用共享同一个 Run 工作空间和 processing branch，但每次调用仍是具有独立 ID 的 Agent Run，并在 Full Chain 的终态 `run.json` 中分别记录。Reviewer 不读取 `inputs/` 是 System Prompt 和上下文定义的行为边界，不是当前文件系统强制的权限边界。这组角色和交接规则不自动适用于其他 Artifact 维护方式。

Knowledge 浏览改为直接扫描 Markdown 文件；Artifact 页面扫描统一 Repository 的 `artifacts/`；Chat Agent 也从统一根工作。SQLite Knowledge、独立 Artifact Git、独立 collaboration Git、worktree 根和专用 Knowledge CRUD 不再是当前模型。

## Consequences

- 一个路径和一个 revision 可以解释 Knowledge/Artifact 的共同状态；
- 每次知识加工都有独立、可检查的文件工作面，多轮 Agent 调用不会混用任务或工作状态；
- Run 历史与固定输入稳定存在，同时不会伪装成 Knowledge/Artifact 事实或污染候选 diff；
- Agent 使用相同的普通文件能力；任务、证据和工作产物以文件表达，文件格式不再要求专用读取工具；
- 当前 Maintainer/Reviewer 仍只是结构化知识加工的角色，不成为 Artifact Domain 的角色；
- 不需要 Git worktree、Knowledge/Artifact workspace 副本、symlink 或跨 Store 同步；
- 固定 Observation 的 Run-local 副本增加持久存储与敏感信息管理责任；当前 Reviewer 的 source-blind 依赖行为契约，不能声称为安全隔离；
- 多进程并发、锁、队列、强权限隔离、promotion 和远端治理延期到有明确需求时决定。
