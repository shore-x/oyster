# ADR-0002：统一 Repository、tracked Task 与独立 worktree

- 状态：Accepted；核心链路已实现
- 日期：2026-08-06
- 修订：2026-08-11，Task 纳入 Git、Agent 改用外置 linked worktree、失败恢复改为保持 Task open
- 取代：Knowledge/Artifact 分离存储、Git 外 Task sidecar、单一共享 working tree 和全局 Agent 串行门禁
- 关联文档：[统一 Repository 与 Agent Git 协作](../architecture/unified-git-agent-collaboration.md)、[术语与执行模型](../architecture/terminology.md)

## Context

Knowledge、Artifact 和一次加工的 Task 输入/过程如果分别由 Git 与旁路目录保存，同一个业务变化会形成两套无法原子回溯的时间线。把所有 Agent 放在用户主 checkout 中又会让用户手工修改、Chat 和多个 Knowledge Task 互相污染，并迫使 Host 增加大量脆弱的 dirty-tree 检查。

Pi Coding Agent 提供文件、Shell、Pi Session 和执行生命周期，但不管理 Git branch 或 worktree。Git 拓扑与写入隔离因此属于 Oyster Host。

## Decision

Oyster 使用一个标准 Git Repository：

- `knowledge/`：Knowledge；
- `artifacts/`：Artifact；
- `tasks/<taskId>/`：tracked Task 定义、输入、进度、Pi Session 和生命周期记录。

Task 使用 `task/<taskId>` branch。Host 从已提交的 `main` 创建 Repository 外的 `worktrees/<taskId>/` linked worktree，Agent 从该 checkout 根目录运行。`.pi-runtime` 和完整 Debug Store 位于 Repository 外。

Task start commit 固定 `BRIEF.md`、`inputs/`、初始 `PROGRESS.md` 与 `task.json`。Git revision 已能表达精确输入，因此删除 `manifest.json`、working-tree 指纹和 `workspaceRevision`。

Host 创建 branch/worktree 和 checkpoint commit；Agent 负责语义编辑。Prompt 要求 Agent 不执行 branch/worktree/reset/clean/stash/merge/rebase/push 等拓扑操作。该约定不升级为路径 Sandbox 或复杂权限系统。Host 不要求恰好一个 commit，也不使用精确 Task 根目录 allowlist。

不同 Task worktree 可以并行；同一 worktree 同时只允许一个 Agent 写入。用户主 checkout 不属于任何 Task，未提交修改不阻止 Task 创建，也不被自动吸收。Task worktree 的已有修改在下一次 Agent 前由 Host checkpoint。

Task 状态为 `open | completed | abandoned`。Agent Invocation 仍使用 `in_progress | completed | failed | cancelled`。Invocation 失败或取消不会自动终结 Task；Host 保存能够保存的 Session、错误和修改，Task 保持 `open`。

Task 历史从 `task/*` refs、`main:tasks/` 和只读 legacy fallback 读取。旧记录不再因版本较低而删除。

## Consequences

- 一个 Git revision 可以同时回溯任务输入、Agent/Reviewer 过程和领域修改；
- 用户主 checkout 与 Agent Task 隔离，多个 Task 可以并行；
- Git 替代自定义 workspace 指纹和大量防御性检查；
- failure recovery 依赖保留 branch/worktree，而不是 reset 和重建；
- Pi Session 进入 Git，会增加历史体积并可能包含敏感 Task 内容；完整 Provider Debug Record 仍只保存在本地 Debug Store；
- promotion 需要显式整合最新 `main`，不能用自动 rebase 改写 Task 历史；
- 当前通用 Chat Agent 仍直接写主 checkout，后续需要迁移到同一 repo-writer worktree 契约。
