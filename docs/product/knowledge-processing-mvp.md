# 知识加工

本文说明 Oyster 为什么把知识加工设计为 Maintainer 与 Reviewer 在 Git Task 中协作。跨功能的 Git 约束见[统一 Repository 与 Agent Git 协作](../architecture/unified-git-agent-collaboration.md)。

## 验证目标

聊天记录不能因为被摘要就自动成为 Knowledge。知识加工需要验证一条更严格的链路：用户选择的外部活动能在接受时被固定，Agent 能在已有 Knowledge 基础上形成必要修改，独立 Reviewer 能判断结果是否自足，最终变化能进入正式 Repository 并被回溯。

MVP 采用两个角色，不是为了建立通用多 Agent 编排框架，而是为了隔离两种必要判断：

- Maintainer 可以查看来源，负责理解证据并维护内容；
- Reviewer 不查看来源，负责检查结果本身是否清楚、一致并且可以复用。

## Source Snapshot 与 Task

当前结构化入口让用户按稳定 `sourceConversationId` 选择一份 Source Conversation，而不是选择 catalog 元数据所表示的“精确版本”。接受时，Source Adapter 读取来源当时的当前内容，并检查读取期间没有发生变化；陈旧 catalog 可以刷新后重试，只有来源在读取期间持续变化时才拒绝本次接受。成功读取的字节通过 SHA-256 形成不可变 `sourceRef`。

Adapter 随后把本次加工所需的 Canonical Activity、Raw Evidence 定位信息和附件固定到 Task revision。固定材料使后续 Review 能回答“当时依据了什么”，同时不把 Oyster 的副本伪装成仍由外部来源拥有的最新事实。人类指令已经确定为可选输入形态，但其结构化选择与加工入口尚未实现，属于后续目标。

Task 是持续的 Git 工作过程。它可以包含多轮 Maintainer → Reviewer 协作和多次 Agent Invocation；一次模型失败、重试或取消不应产生新的领域实体。Task 与 Knowledge、Artifact 共享 Git 历史，但 Task 只记录输入、进度和必要摘要，不拥有一份结果快照。

## Maintainer 与 Reviewer

Maintainer 从 Task worktree 阅读固定输入、相关 Knowledge 和 Artifact，直接维护正式文件并提交变化。它应形成长期可复用的理解，而不是保存聊天摘要、工作日志或模型推理过程。

Reviewer 审阅 Task 定义、进度和完整候选 tree，但不读取原始 Observation 输入。这个证据隔离是内容质量测试：如果候选内容必须依赖原始对话才能解释，说明它还不适合作为正式 Knowledge 或 Artifact。

Reviewer 要求修改时，直接在可定位的位置或统一进度记录中留下具体反馈并提交，Maintainer 在下一轮解决。Reviewer 接受内容后，还需要基于最新 `main` 整理 Task 历史、处理冲突并重新检查，最后仅以 fast-forward 方式整合到 `main`。语义编辑、commit 和冲突解决由 Agent 完成；Oyster 的 Repository 协作服务只创建执行坐标并验证 Git 结果。

## 接受与状态语义

当前 Task 只需要两个可由 Git 验证的状态：

- `open` 表示工作仍未进入正式分支，可以继续；
- `completed` 表示 Reviewer 接受的精确结果已经进入 `main`；

显式放弃和清理是后续生命周期设计，不在当前模型中预留无法到达的状态。

Agent Invocation 的成功、失败或取消只描述一次执行。Reviewer 说“批准”但尚未把结果整合进 `main` 时，Task 仍不是 `completed`。这使知识库和工作台能够把 `main` 作为一致的正式内容边界，不需要再解释“已完成但尚未生效”的中间状态。

## 记录边界

Git 保存理解业务变化所需的 Task 材料、协作进度以及 Knowledge/Artifact revision。`task.json` 是创建时的轻量定义，只保存来源与执行配置摘要；完成状态、结果 revision 和 changed paths 由 commit graph 重建。完整 Knowledge 可以直接从对应 revision 读取，不应再次序列化到 Task 记录。

Pi Session、Agent Invocation 明细和 Debug Record 回答的是如何继续或诊断一次执行，可能包含完整上下文、工具结果和 Provider 数据。它们位于 Repository 外，不随 Task Git 历史传播。调试数据的保留期限尚未确定，后续应由统一设置和清理模块治理。

## 并发与当前边界

每个 Task 使用独立 branch/worktree，因此多个 Task 可以并行；同一 worktree 在任一时刻只交给一个写入者。用户主 checkout 的未提交内容既不阻止 Task 创建，也不会被静默纳入 Task。

**当前限制**：Renderer 与 IPC 仍以单个前台知识加工流程组织交互，取消入口可能中止进程内全部活动 Knowledge Task Invocation。按 `taskId` 独立展示、继续和取消属于后续交互设计。

**当前限制**：Invocation 失败后，Task 在语义上仍应保持 `open`，branch/worktree 也为恢复提供基础；但应用退出、崩溃及不同失败阶段的可靠继续尚未被定义为当前保证。

**候选方向**：通用 Chat Agent 可以在未来迁移到独立 writer worktree，让对话修改也通过 Agent 完成 Git 整合。该方案仍需验证用户如何接受变化以及如何处理冲突，目前不作为知识加工 MVP 的既定能力。
