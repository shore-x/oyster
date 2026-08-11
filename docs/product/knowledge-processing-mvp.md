# 知识加工验证 MVP

> 状态：当前实现
>
> 日期：2026-08-11
>
> 术语遵循：[Oyster 术语与执行模型](../architecture/terminology.md)

## 目标

用真实 Maintainer → Reviewer 链路验证：Source Conversation 的精确版本能够被完整读取；Task、Agent Session 和 Knowledge/Artifact 变化能够在同一 Git 历史中回溯；用户主 checkout 不被 Agent Task 占用；多个 Task Agent 能在不同 worktree 并行；完整 Agent Invocation 活动可以离线检查。

## Repository 与运行布局

```text
<Electron userData>/
├── repository/                         # 用户主 checkout
│   ├── knowledge/
│   ├── artifacts/
│   └── tasks/<taskId>/                 # tracked Task record
│       ├── BRIEF.md
│       ├── PROGRESS.md
│       ├── inputs/
│       ├── pi-sessions/
│       └── task.json
├── worktrees/<taskId>/                 # Agent linked checkout
├── agent-runtime/<taskId>/             # 不进 Git
└── agent-debug/invocations/            # 不进 Git
```

Task 使用 `task/<taskId>` branch。Host 从已提交的 `main` 创建 linked worktree，并用 `task: start` commit 固定 BRIEF、inputs、初始进度和生命周期记录。`tasks/` 与 `knowledge/`、`artifacts/` 由同一个 Repository 跟踪。

Task start revision 已能固定物化输入，因此不再存在 `manifest.json`、working-tree 指纹或自定义 `workspaceRevision`。

## 文件化输入

Source Adapter 校验所选 Source Conversation 的精确 `sourceRevision`，生成可定位的 Canonical Activity，并保留 Raw Evidence locator。Host 在 Task 的 `inputs/` 中物化：

- 有序、完整、有界的 Canonical Activity Markdown page；
- 由固定 Raw Evidence 行模型生成的文本 page 和 locator index；
- 从 Base64 恢复的真实图片附件；
- 解释来源、格式和读取顺序的 `inputs/README.md`。

这些文件是 Source Snapshot 的 Task-local 工作视图，不是新的来源权威。上游 `sourceRef` 绑定外部版本，Task start commit 绑定本地文件。

## Agent 协作

Maintainer 和 Reviewer 共用 Pi Coding Agent SDK，但固定为 `resourceMode: disabled`，只暴露普通 `read`、`bash`、`edit`、`write`，不加载 Chat 的 Extension、Skill、Prompt、Theme、Todo 或子 Agent。

1. Maintainer 从 Task worktree 根启动，读取 `tasks/<taskId>/`，修改 Knowledge/Artifact 并更新 PROGRESS；
2. Host 保存 Pi Session、Task handoff 和所有 worktree 修改，创建 Maintainer checkpoint；
3. Reviewer 审阅当前 Task branch，不读取 inputs；需要修改时写 REVIEW marker 和未完成项，否则直接结束；
4. Host 根据 tree 与 PROGRESS 记录 changes requested 或 approval checkpoint；
5. 要求修改时开始新的 Round，批准时把 `task.json` 更新为 `completed`。

Agent 不负责 branch、worktree 或 checkpoint commit。Prompt 要求其不执行 commit/reset/clean/stash/merge/rebase/push；Host 不为此增加路径 Sandbox 或复杂权限层。

## 状态与失败恢复

Task 状态为 `open | completed | abandoned`。Agent Invocation 继续使用 `in_progress | completed | failed | cancelled`。

Agent 失败或取消时，Task 保持 `open`。Host 尽量把 Pi Session、`lastError` 和当前修改 checkpoint 到 Task branch，不 reset、clean 或删除 worktree。当前 UI 还没有继续和放弃按钮，但历史记录会显示可继续的 Task。

## 并发和用户修改

- 用户拥有主 checkout；其未提交修改不阻止 Task 创建，也不进入 Task branch；
- 每个 Task 使用独立 worktree，不同 Task 可以并行；
- 同一 Task 的 Maintainer 与 Reviewer 串行；
- 进程内只阻止同一个 worktree 同时启动两个 Agent；
- Agent 启动前若 Task worktree 已 dirty，Host 先创建 pre-Agent checkpoint；
- 用户手工接管 Task worktree 前应暂停 Agent，运行中同时编辑无法可靠区分逐行归属。

当前 Renderer 仍只允许一个前台 Knowledge Task；取消按钮会中止当前进程内的全部 Knowledge Task Invocation。底层不同 worktree 已支持并行，按 `taskId` 独立启动、展示和取消属于后续 UI/API 工作。

## UI、历史与 Debug

Task 列表从 `refs/heads/task/*` 和 `main:tasks/` 读取 `task.json`，并兼容读取旧版 Git 外记录但不删除它们。Task Repository 是权威索引，不建立 Task 数据库。

Pi Session 位于 tracked `tasks/<taskId>/pi-sessions/`。完整 Pi Context、工具结果和最终 Provider 请求/响应位于本地 Debug Store；凭据和敏感 header 值不保存，其他业务内容不自动脱敏。

## 当前边界

当前 Task 完成后仍保持“批准但不 merge”，promotion UI 尚未实现。后续 promotion 必须先把最新 `main` merge 到 Task branch、解决冲突并重新 Review，再 fast-forward；用户主 checkout dirty 时不得自动 stash 或强行更新。

当前通用 Chat Agent 仍直接从主 checkout 工作，尚未迁移到 repo-writer worktree 契约。MVP 不引入多进程租约、远端同步、自动 rebase、强文件系统隔离或权限审批系统。
