# 知识加工验证 MVP

> 状态：当前实现
>
> 日期：2026-08-11
>
> 术语遵循：[Oyster 术语与执行模型](../architecture/terminology.md)

## 目标

用真实 Maintainer → Reviewer 链路验证：外部 Source Conversation 的精确版本能够被完整读取；每次 Knowledge Processing Task 拥有独立文件工作空间；Agent 只用普通文件与 Shell 工具维护全局 Knowledge/Artifact；Reviewer 能独立反馈或批准；完整 Agent Invocation 活动可在同一窗口查看。

## Repository 与 Task 工作空间

应用固定使用 `<Electron userData>/repository/`：

```text
repository/
├── knowledge/
├── artifacts/
└── tasks/<taskId>/
    ├── BRIEF.md
    ├── PROGRESS.md
    ├── manifest.json
    ├── inputs/
    │   ├── README.md
    │   ├── activity/
    │   ├── evidence/
    │   │   └── INDEX.md
    │   └── attachments/
    ├── pi-sessions/
    └── task.json
```

Knowledge Processing Task 是从一个已接受 Source Snapshot 到批准候选 revision 的一次业务尝试。Task 使用一个 `tasks/<taskId>/` workspace 和一个 `knowledge-task/<taskId>` branch，不创建 Git worktree 或领域文件副本。Knowledge 与 Artifact 全局唯一，Task 目录由 `.gitignore` 排除，不进入候选内容 commit。

- `BRIEF.md`：固定目标、Attention、Source Snapshot、Repository 坐标和完成边界；
- `PROGRESS.md`：Maintainer / Reviewer 共用的可变检查清单和 handoff；
- `inputs/`：Host 从 Source Snapshot 物化的普通文本、图片与说明文件；
- `manifest.json`：固定 `BRIEF.md`、初始 `PROGRESS.md` 定义、全部输入文件以及 Task 创建时 Knowledge/Artifact 的 Repository 状态指纹；
- `pi-sessions/`：该 Task 内每次 Maintainer / Reviewer Invocation 的持久化 Pi Session；
- `task.json`：Task 的不可变终态记录，保存输入、配置、状态、结果或错误及全部精简 Agent Invocation envelope。

Task 活动态为 `in_progress`。一旦进入 `completed`、`failed` 或 `cancelled` 就不可恢复或原地重试；再次尝试必须创建新的 `taskId`。Source Snapshot 在 Task 接受前不可用、变化或无法读取时，返回结构化拒绝，不创建 workspace 或失败历史。

## 文件化输入

Source Adapter 读取所选 Source Conversation 的精确 `sourceRevision`，生成可定位的 Canonical Activity，并保留 Raw Evidence locator。Host 在 Task 的 `inputs/` 中物化固定输入视图：

- Canonical Activity 按模型上下文边界生成有序、完整的 Markdown page；
- 固定 Raw Evidence 的规范化行模型生成有界文本 page，`evidence/INDEX.md` 把 `Lxxxxxx:Cn` locator 映射到文件；
- Base64 图片解码为真实图片文件；
- `inputs/README.md` 说明来源、格式、读取顺序、locator 与附件元数据。

这些文件是 Source Snapshot 的 Task-local 工作视图，不是新的来源权威，也不是 Knowledge 或 Artifact。上游 `sourceRef` 绑定外部字节与版本；`manifest.json` 固定物化文件自身。特殊格式由说明文件解释，不产生 Observation 专用 Agent 工具。

## Agent Definition、Invocation 与 Round

Maintainer 和 Reviewer 是两个稳定的 Knowledge Agent Definition。每次对其中一个 Agent 发起执行请求都会创建新的 Agent Invocation 和独立持久化 Pi Session；Invocation 覆盖该 Agent 的模型—工具循环，并通过 `sessionId` / `sessionFile` 引用原生执行历史。

两者与 Chat 共用 Pi Coding Agent SDK `AgentSession` 适配层，但使用 `resourceMode: disabled`：不发现 Extension、Skill、Prompt、Theme 或 context file，只暴露 `read`、`bash`、`edit`、`write`，不继承 Chat 的 Pi 生态资源、`spawn_agent` 或通用 Todo。这是 Knowledge Agent Definition 的显式能力边界，不是另一套执行引擎。

一个 Collaboration Round 由一次 Maintainer Invocation 和紧随其后的一次 Reviewer Invocation 构成：

1. Maintainer 从 `tasks/<taskId>/` 启动，读取 `BRIEF.md`、`PROGRESS.md` 与 `inputs/`，核查 Repository 初始状态，修改 `knowledge/` 或 `artifacts/` 并创建候选 commit。
2. Reviewer 从同一 workspace 和干净工作树启动，只读取 `BRIEF.md`、`PROGRESS.md` 与候选 revision。需要修改时加入完整 `REVIEW` block、追加未完成项并创建反馈 commit；批准时不创建 approval commit。
3. Host 校验 workspace、branch、精确 revision、清单和 marker，在 `PROGRESS.md` 写入绑定 commit OID 的 handoff。
4. Reviewer 要求修改时创建下一轮及新的 Maintainer Invocation；批准时 Task 完成。

Reviewer 不读取 `inputs/`，Host 也不把 Source Snapshot 或 Maintainer transcript 注入其上下文。当前 Coding Tools 仍以应用的 OS 用户权限运行，因此这是 System Prompt 与上下文定义的行为边界，不是文件系统安全沙箱。

## Agent Preview

Agent Preview 是用户显式启动单个知识 Agent 的调试入口。它显示固定输入、Agent Invocation 活动和候选输出，但不创建 Knowledge Processing Task、不生成 Collaboration Round，也不进入 Task 历史。Preview 的调用与 Task 中的调用使用同一种 Agent Invocation 记录格式。

## UI 与历史

Task 详情按 Collaboration Round 和 handoff 顺序展示 Maintainer / Reviewer Agent Invocation。Source Conversation 选择器消费 Discovery 的 catalog snapshot；选择同时绑定 `sourceConversationId` 与 `sourceRevision`，刷新后版本变化或记录消失都会撤销选择。

历史列表只展示包含合法 `task.json` 的终态 Task。记录保存 Source Conversation 摘要、Source Snapshot、Agent 配置、全部 Invocation envelope、批准 revision、变更路径以及 revision 对应的 Knowledge/Artifact 视图。Task 详情按 envelope 的 `debugRecordId` 从本地 Debug Store 加载完整调试记录。低于当前支持版本的旧 Task 目录在读取时删除；高于当前版本的记录保留并明确报错。

Invocation Recorder 把普通工具结果、完整 Pi Context、模型输出以及最终 Provider 请求/响应保存到 `<Electron userData>/agent-debug/invocations/`，不再复制进 `task.json`。Agent 实际读取的 Evidence 仍可能在 Debug Record 中重复出现；这是当前本地无损调试的明确取舍，不把文件工具误当作脱敏边界。凭据与敏感 header 值不保存，其他业务内容不自动脱敏。

## 当前边界

统一 Repository 只有一个物理工作树，当前 Host 同时只允许一个结构化知识加工角色执行。这是防止不同 Invocation 或 Task 交叉修改 working tree 的进程内完整性门禁，不是队列或分布式锁。

MVP 不定义 promotion、多进程并发治理、租约、远端同步、自动 rebase、复杂冲突策略、Task 清理策略或强文件系统隔离。它只保证：每个 Task 有独立工作空间；业务目标、输入与工作状态通过文件表达；Knowledge 与 Artifact 只存在于全局正式层和 Git revision 中。
