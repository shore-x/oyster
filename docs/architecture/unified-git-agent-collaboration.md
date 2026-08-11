# 统一 Repository 与 Knowledge Processing Task

> 状态：当前架构
>
> 日期：2026-08-11
>
> 术语：[Oyster 术语与执行模型](terminology.md)

## 1. 最小整体模型

Oyster 管理一个标准 Git Repository 和一个物理工作树：

```text
<Electron userData>/repository/
├── .git/
├── knowledge/
├── artifacts/
└── tasks/
    └── <taskId>/
        ├── BRIEF.md
        ├── PROGRESS.md
        ├── manifest.json
        ├── inputs/
        │   ├── README.md
        │   ├── activity/
        │   ├── evidence/
        │   └── attachments/
        ├── pi-sessions/
        └── task.json
```

- `knowledge/` 是全局唯一 Knowledge 事实层；
- `artifacts/` 是全局唯一 Artifact 事实层；
- `tasks/<taskId>/` 是一项 Knowledge Processing Task 的工作空间与终态记录。

Task 不拥有 Knowledge 或 Artifact，也不复制它们。正式内容状态由全局工作树的 Git revision 表达；Task workspace 是任务、固定输入、协作进度和历史的文件边界，不是 Git worktree 或候选内容目录。

## 2. 文件与版本边界

Git commit 只表达 `knowledge/` 与 `artifacts/` 的一致内容 revision。`tasks/` 由根 `.gitignore` 排除，因此切换内容 revision 不删除 Task 历史，也不把过程文件混入候选 diff。

- `BRIEF.md` 保存固定目标、Attention、Source Snapshot 引用、Repository 路径、`knowledge-task/<taskId>` 分支、base revision 和完成边界；
- `inputs/` 保存 Host 从 Source Snapshot 物化的 Canonical Activity、Evidence page 和附件；
- `PROGRESS.md` 保存 Maintainer / Reviewer 共用的可变检查清单与带角色 handoff；
- `manifest.json` 固定 `BRIEF.md`、`inputs/`、初始 `PROGRESS.md` 定义和 Task 创建时 Knowledge/Artifact working tree 的状态与内容指纹；
- `pi-sessions/` 保存该 Task 内各 Knowledge Agent Invocation 的 Pi Session JSONL；
- `task.json` 仅由 Host 在 Task 进入 `completed`、`failed` 或 `cancelled` 后写入，保存输入、冻结配置、结果或错误，以及精简 Agent Invocation envelope。完整调试活动由应用级本地 Debug Store 按 `debugRecordId` 保存。

上游 `sourceRef` 绑定外部 Raw Evidence 字节；`manifest.json` 绑定物化后的 workspace 文件。两者不是同一个 hash，也不共享身份。

## 3. Task 创建与输入接受

用户先选择 Source Conversation 的精确 `sourceRevision`。Discovery 验证并读取该 Source Snapshot；不可用、已变化或不可读会在 Task 接受前返回结构化拒绝，因此不创建 Task workspace 或失败历史。

Source Snapshot 被接受后，Knowledge Task Service 创建新 `taskId`、Task workspace 和 `knowledge-task/<taskId>` branch。Task 终态后不能原地重试；再次尝试必须创建新的 Task。

新 Task 可以接收创建前已经存在的 Knowledge/Artifact working-tree 修改，但必须把它们记录为明确的初始输入：

- `manifest.json` 固定 working tree、index 和未跟踪普通文件或 symlink；
- 首个 Maintainer Invocation 前重新采集并要求完全一致；
- Knowledge/Artifact 之外的修改被拒绝；
- clean gitlink 可由外层 revision 表达，nested working tree 中未提交且无法唯一固定的内容被拒绝。

Reviewer 与后续 Maintainer Invocation 必须从干净 working tree 和精确 handoff revision 启动。

## 4. Maintainer / Reviewer 协作

Maintainer：

1. 读取 `BRIEF.md`、`PROGRESS.md`、完整 Canonical Activity、必要附件和 Evidence page；
2. 评估 Task 创建时已有的 Knowledge/Artifact 修改；
3. 修改全局 `knowledge/` 与 `artifacts/`，完成清单并解决所有 `REVIEW` marker；
4. 创建一个普通单亲 commit；
5. Harness 校验后向 `PROGRESS.md` 追加绑定 candidate revision 的 Maintainer handoff。

Reviewer 只审阅精确 candidate revision：

- 要求修改时，在实际文件写入完整 `REVIEW` block，在 `PROGRESS.md` 增加未完成项，并创建一个反馈 commit；
- 批准时不创建空 approval commit；Harness 验证后追加绑定精确 OID 的 Reviewer approval；
- Reviewer 不删除 `PROGRESS.md`，也不 merge 目标分支。

一次 Maintainer 交接与紧随其后的 Reviewer 决策组成一个 Collaboration Round。若 Reviewer 要求修改，下一轮创建新的 Maintainer 和 Reviewer Agent Invocations。所有 Rounds 共享同一个 Task、固定输入、`PROGRESS.md` 和 processing branch，但每次 Invocation 都有独立身份与记录。

## 5. 完整性与并发边界

Harness 在每次 Agent Invocation 前验证：

- workspace 坐标、`manifest.json` 和固定输入文件树；
- 当前 branch 与精确输入 revision；
- 域外修改、working-tree 清洁度和初始状态不变量。

在 handoff 时再次验证 workspace、commit 父节点、变更路径、工作清单和 Review marker。Task workspace 文件不进入候选 revision。

当前只有一个物理 working tree，因此进程内同时只允许一个结构化知识 Agent Invocation。这是最小数据完整性边界，不是队列或分布式锁协议。多进程写入、租约、自动 rebase、复杂冲突、远端同步、强文件权限隔离和 promotion 治理均不在当前范围。

本工作流中的 Maintainer / Reviewer 是 Knowledge Processing Task 的业务角色，不是 Artifact Domain 的全局角色。其他 Artifact 维护可以使用不同角色、临时子 Agent、单 Agent 或非 Agent 机制。

## 6. 历史兼容

Task workspace 格式与终态 `task.json` 独立版本化。读取历史时：

- 低于当前支持版本的 Task 目录被删除，避免把不兼容开发期数据解释成当前事实；
- 高于当前支持版本的记录保留原文件并明确报错，旧应用不得删除或覆盖新格式数据；
- 已存在的 `task.json` 只允许 Host 在终态保存流程中管理，Agent 无权占用该保留路径。
