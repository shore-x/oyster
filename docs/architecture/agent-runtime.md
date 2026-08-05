# 通用 Agent Runtime

> 状态：当前实现规格
>
> 日期：2026-08-05

## 1. 目的与边界

Oyster 的内置工具使用 Agent 共享同一套通用 Runtime 能力。Runtime 只负责模型—工具循环、上下文管理、运行期 Todo 和结束检查，不理解 Knowledge Maintainer、Reviewer、Evidence 或 Artifact 等业务职责。角色差异继续由各次运行的 System Prompt、Workspace、授权工具与 Host 对运行结果的解释定义。

Todo 是 Agent 为当前运行组织工作的通用清单，不是业务状态机、Knowledge、Artifact、Raw Evidence 或长期审计记录。业务层可以把需要处理的工作投影为初始 Todo，但 Todo 不因此获得业务 Schema；Contribution Draft 等具有独立内容语义的运行期工作材料仍由对应业务层持有。

## 2. Todo 状态与工具

每个 Agent 实例拥有一份 Host 管理的 Todo Store。最小条目只包含稳定的运行期 ID、自由文本内容和 `pending | completed` 状态。当前不增加 `in_progress`、优先级、依赖、编辑、删除、重开或业务类型。

所有内置 Agent 始终获得三项相同工具：

- `add_todos({ todos })`：批量增加 Todo，由 Host 分配 ID；
- `complete_todos({ ids })`：批量标记完成，重复完成同一 ID 是幂等操作；
- `list_todos({})`：读取当前运行绑定的完整 Todo 列表。

状态修改工具按顺序执行。工具结果返回本次操作和当前 pending 数量，使 Agent 在主动调用后可以继续判断；三项工具本身都不要求终止 Agent。

Runtime 在创建 Agent 时可以接收 `initialTodos`。这些条目直接进入 Todo Store，与初始 Prompt、用户消息和 transcript 构造彼此独立；启动时不会把 Todo 列表变成消息，也不会在每次 LLM 调用前附加 Todo 快照。模型需要主动调用 `list_todos` 才能读取完整列表。

## 3. 通用结束检查

Runtime 接受若干返回自由文本原因的 **End Check**。Todo Store 自动提供一项检查；pending Todo 只是 Agent 当前不能结束的一种原因，业务 Runtime 可以注册其他原因，但通用层不解释原因中的领域概念。

当一次 Assistant turn 以正常 `stop` 自然结束、没有工具结果并且没有已经排队的消息时，Runtime 执行所有 End Check：

- 没有原因时允许 Agent 结束；
- 存在一个或多个原因时，把原因合并成一条内部 **Runtime Feedback**，放入 Pi Core 的 Follow-up Queue，再次唤起同一 Agent；
- Provider error、取消和 aborted turn 不会被续跑机制改写；已经排队的用户 steering 或 follow-up 先按原语义处理，Runtime 不重复插入消息。

Runtime Feedback 在 Agent transcript 中使用独立的内部消息类型，只在 LLM 边界转换成普通 follow-up user message。Chat Session 可以保存它以保持后续模型上下文连续，但不会把它投影成用户发送的消息。这里的消息只在结束被实际拒绝时出现，不是每轮 Context 注入。

End Check 不判断 Agent 的工作质量，也不证明 Todo 已被正确完成；它只让 Host 持有的未完成条件能够阻止一次自然结束。Runtime 不引入固定轮次、重试次数、工具次数或总时长配额，运行仍可由用户取消。

## 4. 当前 Pi Core 接入

当前实现使用 `@earendil-works/pi-agent-core` 的普通 `Agent`：

- 三项 Todo 工具与 Tool Catalog 来自同一个通用定义，Chat Agent、Knowledge Maintenance Agent 及其配置页投影复用该定义；
- 结束检查订阅 `turn_end`，因为 Pi Core 会在该事件的订阅者完成后读取 Follow-up Queue；到 `agent_end` 再排队已经太晚；
- Todo Store 独立于 `transformContext`，现有 transcript compaction 不负责保存、重建或注入 Todo；
- Runtime Feedback 通过统一 `convertToLlm` 转换，保持 Host 内部消息与真实用户消息的身份区别。

Knowledge Maintenance Agent 使用同一 Todo Store 跟踪本次调查工作，并独立持有 Contribution Draft。Host 在启动时把完整 Raw Evidence 确定性分页，每一页作为普通 initial Todo 绑定到运行；Agent 可继续增加调查 Todo，但 Runtime 不引入证据专用状态或工具。Agent 主动使用 `list_todos`、`add_todos` 和 `complete_todos`，Runtime 不在每次模型调用前注入工作清单。

Knowledge Maintenance Agent 也没有专用的提交或终止工具。只要仍有 pending Todo，通用结束检查就会拒绝自然结束并续跑；当 Todo 全部完成且 Agent 自然结束时，Host 才把完整的当前 Draft 冻结为本次 Knowledge Contribution。这是 Host 对整次运行的解释，不是单次工具调用的提交。

## 5. 当前非目标

当前 Runtime 不负责 Maintainer 与 Reviewer 的外层交接，不定义跨 Agent 工作项协议，也不把 Todo 持久化为新的领域对象。跨运行恢复、运行级 UI、Todo 历史以及更一般的工作交接只有在出现明确需求后再设计。
