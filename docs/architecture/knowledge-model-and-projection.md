# Knowledge、Artifact、Task 与 Projection

> 状态：当前架构
>
> 日期：2026-08-11
>
> 术语遵循：[Oyster 术语与执行模型](terminology.md)

## 1. 四个边界

系统区分四类事实：

1. 观察层表达外部 Agent 实际发生了什么；
2. Knowledge 表达当前可复用的理解；
3. Artifact 表达围绕持久 Attention 维护的实际产物；
4. Knowledge Processing Task 表达一次结构化知识加工尝试及其协作过程。

外部原文归来源 Harness 所有。Discovery 用 Source Conversation 标识一条逻辑对话；用户选定并接受其精确版本后形成 Source Snapshot。Host 把该 Snapshot 物化成 Task-local 固定输入。Knowledge、Artifact 与 Task 分别位于统一 Oyster Repository 的 `knowledge/`、`artifacts/` 和 `tasks/`，但 Task 不拥有或复制全局 Knowledge 与 Artifact。

## 2. Knowledge

`knowledge/**/*.md` 中一个文件保存一条 Knowledge Statement：

- 第一个 H1 是 canonical title，剩余 Markdown 是自足正文；
- canonical title 在一个 revision 中唯一；
- `[[canonical title]]` 或 `[[canonical title|display text]]` 表达关系；
- 文件路径是 locator，不是 Statement 身份。

Knowledge 浏览器直接扫描这一文件层。全文搜索、邻域图和引用关系是可重建 Projection，不是第二份权威 Knowledge Store。

## 3. Artifact

`artifacts/<artifact>/` 保存一个 Artifact。其根 `AGENTS.md` 表达持久 Attention，其他文件结构任意。Artifact 内容不会仅因存在而自动成为 Knowledge；一次现实修改可以在同一个 commit 中同时更新两层。

根 `AGENTS.md` 是当前 Artifact 说明，也是本地维护契约的表达载体。除持久 Attention 外，它以自然语言说明维护目标、证据边界、质量义务和完成条件，不规定固定 Agent 名称、数量、调用次数或编排拓扑。

Artifact Domain 不定义全局 Maintainer、Reviewer 或 Critic。结构化知识加工中的 Maintainer 和 Reviewer 是 Knowledge Agent Definition，只服务于具体 Task。Artifact 也可以由用户、通用 Chat Agent、临时协作 Agent 或未来其他机制修订。若未来需要可强制的独立审批、权限分离或 promotion，应由采用它的工作流定义。

## 4. Knowledge Processing Task

每个 Task 使用 `task/<taskId>` branch 和 Repository 外的 linked worktree。`tasks/<taskId>/` 是与领域变化一起被 Git 跟踪的 Task 记录：

- `BRIEF.md` 固定目标、Source Snapshot 引用、Repository 坐标、base revision 与完成边界；
- `inputs/README.md` 解释输入视图，`inputs/activity/`、`inputs/evidence/` 与 `inputs/attachments/` 保存 Source Snapshot 的固定文件表示；
- `PROGRESS.md` 保存 Maintainer / Reviewer 共用的检查清单和 handoff；
- `pi-sessions/` 保存 Maintainer / Reviewer 的 Pi Session；
- `task.json` 从 Task 创建起保存 `open | completed | abandoned` 生命周期、配置、结果或最近执行错误。

Task 不拥有或复制 Knowledge/Artifact，但 Task 文件、Knowledge 与 Artifact 变化可以出现在同一 commit。Task start commit 固定输入，后续 commit 同时回溯 Agent Session、Review handoff 和候选内容。

一个 Task 包含一个或多个 Collaboration Round。每轮由一次 Maintainer Agent Invocation 形成候选 revision，随后由一次 Reviewer Agent Invocation 批准或要求修改。要求修改会开启下一轮，不会续写前一次 Invocation。所有轮次共享同一 Task worktree 和 branch，但每次 Invocation、Turn、Model Call 与 Tool Call 都有独立身份。

Task 是持续业务工作，不是 Agent 执行的同义词。Agent Invocation 失败或取消后 Task 仍为 `open`；只有 Reviewer 完成契约时为 `completed`，用户明确放弃时才为 `abandoned`。Agent Preview 只执行一个知识 Agent，用于调试输入和活动，不进入 `task/*` 历史。

## 5. Source Snapshot 与文件化输入

Source Adapter 从外部 Harness 的原始位置读取所选 Source Conversation 的精确版本。Raw Evidence 保留上游格式；Canonical Activity 是其确定性、可定位、对话优先的语义投影：

- 用户与 Assistant 消息以及上下文压缩产生的语义摘要保留完整正文；
- 工具活动只保留操作身份，并分别绑定调用和结果的 Raw locator；
- 参数、结果、模型内部 reasoning、压缩 replacement history、协议包装和重复上下文快照不进入默认正文；
- 图片等附件从工具结果中独立提取。

Host 将完整 Canonical Activity 切分为有界 Markdown 文件，从固定 Raw Evidence 行模型生成带 locator 的文本页，并将附件还原为普通二进制文件，一并写入 Task 的 `inputs/`。上游 `sourceRef` 绑定外部原始字节与版本；Task start commit 固定物化文件自身。

Maintainer 使用普通文件工具扫描 Activity、查看附件并按需回查 Evidence。原始 Task 定义可由 Task start revision 回溯，不再维护平行 manifest 或全量 hash。Reviewer 与 Maintainer 共用 Task worktree 和普通工具，但 System Prompt 明确排除 `inputs/`；这是可审计的行为与上下文边界，不是文件系统安全隔离。

## 6. Projection

Projection 从 Knowledge、Attention 和必要的当前状态形成可消费输出，或初始化、修订 Artifact。它是一项活动，不是新的权威存储域。任何缓存、搜索索引、邻域图或临时 Context Packet 都必须能够从正式层重建，不能与 Knowledge 或 Artifact 形成平行真相。
