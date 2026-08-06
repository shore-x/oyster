# 通用 Agent Runtime

> 状态：通用 Runtime 当前实现规格；统一 Git 协作已在独立原型复用
>
> 日期：2026-08-06

## 1. 目的与边界

内置工具使用 Agent 共享同一套通用 Runtime。Runtime 只负责模型—工具循环、上下文管理、运行期 Todo、结束检查和 Run Recorder，不理解 Knowledge Maintainer、Reviewer、Evidence、Review marker、Git branch 或 Artifact 等业务含义。

角色差异来自各次运行的 System Prompt、Workspace、工具集合和 Harness 调度。Maintainer 与 Reviewer 可以复用同一个 Pi Agent Core loop，但不会因此拥有相同来源输入或业务职责。

Git 协作状态不进入 Runtime：Agent 在文件中表达工作并用 commit 交接，Harness 只向下一次运行传递 revision。Runtime 不保存 Contribution Draft、Reviewer issue 或跨运行 Todo。

## 2. Todo 状态与工具

每个 Agent 实例可以拥有一份 Host 管理的 Todo Store。最小条目只包含运行期 ID、自由文本内容和 `pending | completed` 状态。当前不增加业务类型、优先级、依赖、编辑、删除或重开。

通用 Todo 工具有：

- `add_todos({ todos })`：增加自由文本 Todo，由 Host 分配 ID；
- `complete_todos({ ids })`：标记完成，重复完成同一 ID 保持幂等；
- `list_todos({})`：读取当前运行的完整清单。

Runtime 创建时可以接收 `initialTodos`。它们直接进入 Todo Store，不转换成 Prompt 或 transcript，也不在每次模型调用前重复注入。Agent 需要主动调用 `list_todos` 才能读取。

Maintainer 使用 Todo 覆盖 Evidence Segment 和本次调查；Reviewer 的跨运行反馈不进入 Todo Store，而是直接提交到 collaboration branch 的文件中。Harness 再次调度 Maintainer 时，可以增加一条“处理当前 HEAD 中 Review 标记”的普通 initial Todo，但不复制标记正文。

## 3. 通用结束检查

Runtime 接受返回自由文本原因的 End Check。Todo Store 自动提供一项检查：存在 pending Todo 时，Agent 不能自然结束。

当 Assistant turn 以正常 `stop` 结束、没有工具结果且没有已排队消息时，Runtime 执行全部检查：

- 没有原因时允许结束；
- 存在原因时，将原因合并成内部 Runtime Feedback，通过 Pi Core Follow-up Queue 再次唤起同一 Agent；
- Provider error、取消和 aborted turn 不被续跑机制改写。

End Check 只表达当前运行尚未完成，不判断工作质量。统一 Git 协作中的 commit parent、working tree clean、Review marker 和 merge ancestry 由 Agent 自然结束后的 Harness 读取 Git 状态验证，不塞入通用 Runtime。

## 4. Pi Core 接入

当前实现使用 `@earendil-works/pi-agent-core` 的普通 `Agent`：

- Todo 工具由同一个通用定义创建；
- 结束检查订阅 `turn_end`，在 Pi Core 决定是否读取 Follow-up Queue 前加入反馈；
- Todo Store 独立于 `transformContext`，上下文压缩不保存或重建 Todo；
- Runtime Feedback 在 `convertToLlm` 边界转换为模型可读的 user message，但保持内部身份。

Run Recorder 订阅 Agent、turn、message 和 tool execution 事件，并包装实际 `streamFn`，保存统一的 Run、Turn、Message、Tool Call 和 Model Call。它可以记录转换后的 Pi Context、工具 Schema 和模型输出，但不保存凭据、Header、环境变量或 Provider Payload。

Run Record 是开发和解释界面，不是 Knowledge、Artifact、Raw Evidence 或 Git history。Agent 之间的持久工作交接应从 Repository revision 重建，而不是依赖 Recorder transcript。

## 5. Run 身份与持久化边界

`agent-runtime` 模块统一拥有 Runtime、Recorder 和 Run Record 校验。每个业务 Agent 创建 Runtime 时必须提供稳定的 `agentId`；Runtime 自己分配或接收本次 `runId`，并只在真实创建 Runtime 时产生 Agent Run。业务流程 ID 不复用为 Agent Run ID。

共享 `AgentRunRecord` 当前使用 `formatVersion: 1`，保存 `agentId`，并可用 `parentRunId` 表达真实的父子 Agent 调用。格式版本、身份、生命周期和终态字段由通用校验边界负责；Knowledge Maintainer、Chat Agent、Reviewer 等业务代码不各自维护一份记录结构。

运行中的 Record 只通过观察回调用于实时 UI。持久化只接受 `completed | failed | cancelled` 终态 Record。物理存储仍由拥有生命周期的业务聚合负责：Chat 保存到 Pi Session Custom Entry，加工测试把零个或多个 Agent Runs 保存到一次终态业务快照。两者不为物理统一复制数据，但使用相同的格式、校验器、Timeline 和 Model Call Inspector。

业务层只负责提供 `agentId`、Prompt、工具与 Workspace，并解释最终结果。它可以验证“本业务结果引用的是哪一次 Agent Run”，但不能改变通用 Run、Turn、Message、Tool Call 或 Model Call 的定义。

## 6. Maintainer 与 Reviewer 的 Runtime 使用

Maintainer 使用 Pi `read`、`bash`、`edit`、`write`，以及外部 `read_evidence` 和通用 Todo。它完成所有 Todo、解决当前 tree 中的 Review 标记、创建 commit 并保持 working tree clean 后自然结束。

Reviewer 使用 Pi `read`、`bash`、`edit`、`write`，但没有 Raw Evidence、Maintainer Todo 或 `submit_review`。它发现问题时修改原文件并提交 Review marker commit；通过时用普通 Git 创建 `--no-ff` merge commit。

两类 Agent 的 commit 和 merge 都由普通 `bash` 执行，不增加专用 Git Tool。Harness 在运行结束后读取 revision 并调度下一次运行；它不把 Reviewer 反馈复制成消息协议。

## 7. 当前非目标

当前 Runtime 不提供分布式 Trace、Provider Payload 检查、跨运行恢复、长期 Todo 历史、Agent 消息总线或专用协作 API。串行 collaboration branch 已能验证核心链路，因此暂不增加并发队列、远端 Git、自动 rebase 或复杂 merge conflict 处理。
