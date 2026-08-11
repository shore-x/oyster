# Agent Invocation 历史持久化研究

> 状态：已归档；当前结论已实施
>
> 初始研究：2026-08-06
>
> 更新：2026-08-11
>
> 当前规范：[Oyster 术语与执行模型](../architecture/terminology.md)、[Agent Runtime](../architecture/agent-runtime.md)、[ADR-0002](../decisions/0002-unified-git-agent-collaboration.md)

## 1. 研究问题

本研究要解决的不是如何命名一个笼统的“运行”，而是如何分别回答：

- 一次结构化知识加工业务尝试最终产生了什么；
- 其中实际调用了哪些 Agent；
- 每个 Agent 如何通过模型和工具形成结果；
- Chat 中的持续对话怎样与多次 Agent 执行区分；
- 本地调试记录是否需要升级为通用遥测平台。

这些对象拥有不同生命周期，不能共用 ID 或持久化边界。

## 2. 成熟方案证据

| 来源 | 原生定义 | 对 Oyster 的启示 |
| --- | --- | --- |
| [OpenAI Agents SDK Tracing](https://openai.github.io/openai-agents-python/tracing/) | Trace 表示端到端 workflow；Agent、Generation、Function 与 Handoff 使用不同 Span。 | 业务尝试、Agent 执行、模型调用和工具调用需要分层身份。 |
| [LangSmith Observability Concepts](https://docs.langchain.com/langsmith/observability-concepts) | 外部系统把单项工作称为 Run，相关 Runs 组成 Trace，多轮交互再由 Thread 聚合。 | 业界的 `Run` 并没有统一粒度，不能直接作为 Oyster 领域名词。 |
| [Langfuse Data Model](https://langfuse.com/docs/observability/data-model) | Trace 聚合可嵌套 Observation，Session 再聚合相关 Trace。 | 分析型实体适合跨执行查询，但不要求本地产品照搬其存储模型。 |
| [OpenTelemetry Traces](https://opentelemetry.io/docs/concepts/signals/traces/) | Trace 表示请求路径，Span 表示工作单元及父子关系。 | Trace / Span 应保留给遥测，不应取代业务实体。 |
| [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) | GenAI 事件和 Span 可以携带调用属性，但输入输出具有敏感性和高体积。 | 本地调试可以显式保存完整上下文，但必须披露敏感性，且不能复制凭据。 |

共同点是“端到端活动与内部操作分层”，而不是某一套统一术语或数据库。Langfuse 的分析存储、OpenTelemetry exporter、采样和远端 Trace 后端服务于跨执行聚合；当前 Oyster 没有证据需要这些机制。

## 3. 采用的领域模型

Oyster 采用以下最小关系：

```text
Knowledge Processing Task
└─ Collaboration Round
   ├─ Maintainer Agent Invocation
   └─ Reviewer Agent Invocation

Chat Conversation
└─ Agent Invocation

Agent Invocation ──ref──> Pi Session / Session range
Agent Invocation ──ref──> Local Agent Debug Record
```

- Knowledge Processing Task 是一次业务尝试，ID 为 `taskId`；
- Agent Invocation 是对稳定 Agent Definition 的一次独立执行请求，ID 为 `invocationId`；
- Chat Conversation 是可跨多次用户消息和 Invocation 持续存在的产品对话；
- Pi Session 是 message、Tool Result、compaction 与分支历史的事实来源；
- Agent Debug Record 是本地调试投影，其中才包含 Agent Turn、Model Call 和 Tool Call；
- Trace / Span 不作为这些实体的别名，只在未来遥测系统中使用。

Task 的活动态是 `open`；Invocation 的活动态是 `in_progress`。Invocation 终态不可继续追加，但失败或取消不会自动终结所属 Task。

## 4. 当前持久化结论

### 4.1 三层持久化

一次执行不再把所有信息复制进一个大对象，而是分为三个职责单一的层：

```text
Pi Session JSONL
└─ transcript / tool result / compaction / branch

AgentInvocationRecord
└─ lifecycle envelope + Pi Session ref + counters + Debug Record ref

AgentInvocationDebugRecord
└─ context / model and tool activity / final provider request / response
```

`AgentInvocationRecord` 是共享、版本化、Renderer-safe 的精简 envelope：

```ts
interface AgentInvocationRecord {
  formatVersion: 3
  id: string
  agentId: string
  parentInvocationId?: string
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  completedAt?: string
  error?: string
  session?: {
    sessionId: string
    sessionFile?: string
    startEntryId?: string
    endEntryId?: string
  }
  debugRecordId: string
  modelCallCount: number
  toolCallCount: number
}
```

`agentId` 表示逻辑 Agent Definition，例如 `knowledge_maintainer` 或 `chat_agent`。`parentInvocationId` 只表达真实父子调用关系，不指向 Task 或 Chat Conversation。Runtime 初始化失败可以形成没有 Session entry 的失败 Invocation；没有真正接受执行请求时不伪造 Invocation。

### 4.2 Pi Session

Chat Conversation 使用 Pi `SessionManager` 的 append-only JSONL 保存完整 message、Tool Result 和 compaction。每次根 Invocation 在 envelope 中记录开始与结束 entry；子 Agent 使用带 `parentSession` 的独立持久化 Session，不把完整子 transcript 复制回父 Tool Result。

Knowledge Maintainer 和 Reviewer 的每个 Invocation 也创建持久化 Session，位于 `tasks/<taskId>/pi-sessions/`。这消除了“Chat 持久化、Knowledge 内存态”的特殊分支，使所有 Agent 执行都能按 Pi 原生格式检查。

### 4.3 本地 Debug Store

`AgentInvocationDebugRecord` 位于 `<Electron userData>/agent-debug/invocations/<invocationId>.json`。Recorder 在 Pi StreamFn 边界保存模型实际收到的 Context，并通过 Provider callback 保存 Extension hook 处理后的最终 payload、请求 header 视图、响应状态和响应 header；同时保存消息、Turn、工具活动、输出、用量与错误。

API Key、Authorization、Cookie 等 credential-bearing header 值不会写入，生成选项也使用安全字段白名单。除此以外不做内容采样或业务数据脱敏，因此 Context、工具结果和 Provider payload 可能含有敏感内容。

每个 Invocation 一个 JSON 文件，更新时原子替换。该方案没有数据库、exporter、后台服务或外部依赖，足以支持“打开某次调用查看实际上下文与请求”的本地离线调试。未来如果实际数据量需要治理，只增加按时间删除旧 Debug Record 的策略，不连带删除 Pi Session 或 Task 历史。

### 4.4 Knowledge Processing Task 历史

每个 Task 从创建起在 `task/<taskId>:tasks/<taskId>/task.json` 保存一个 `KnowledgeTaskRecord`：

- `formatVersion: 2`；
- `taskId`、输入、冻结配置、开始与更新时间；
- `open | completed | abandoned` 生命周期；
- 按实际启动顺序保存的全部精简 `agentInvocations` envelope；
- 成功时保存结果和 Collaboration Round；Invocation 失败或取消时保存 `lastError` 并保持 `open`。

Task start commit 保存初始记录，后续 Host checkpoint 追加 Invocation、Review 和结果历史。Task/Pi Session/Knowledge/Artifact 由同一 branch 跟踪。

Source Snapshot 在 Task 接受前被拒绝时不创建 Task branch。Task 接受后的失败和取消保存为可恢复 checkpoint。历史从 `task/*` 和 `main:tasks/` 读取；旧版 Git 外记录只读兼容，不再删除。

### 4.5 Chat Conversation 历史

Chat Conversation 由 Chat repository 持久化：Pi Session JSONL 保存完整对话事实及终态 Invocation envelope custom entry；Oyster descriptor 固定模型/System Prompt binding，并让空 Conversation 也可持久化。每条用户消息可产生新的 Invocation；取消当前 Invocation 不终止 Conversation。

Task 与 Chat 不需要共享一个全局 Invocation 数据库。它们各自拥有精简 envelope，通过 `debugRecordId` 按需读取同一个本地 Debug Store，从而避免把大型调试数据复制到 `task.json` 和 Chat Session。

## 5. UI 与读取边界

- Task 列表只返回状态、时间、来源摘要、模型和计数，不返回 Prompt、消息、工具结果或 Knowledge 正文；
- 用户打开 Task 后才读取完整 `task.json`，并按其中的 `debugRecordId` 读取 Debug Record；
- Task 详情先展示业务状态和 Round，再下钻到 Agent Invocation；
- Invocation 详情使用 Debug Record 按时间线展示 Turn、Message、Model Call 和 Tool Call；
- Model Call Inspector 展示实际 Pi Context、工具定义、安全生成参数、最终 Provider payload、脱敏 header、响应、输出和错误；
- Agent Preview 复用 Invocation 展示，但不创建 Task 历史。

完整 Context、Provider payload 与普通工具结果会增大 Debug Record，并可能重复 Evidence。这是本地调试入口的显式取舍。只有真实数据证明文件大小、读取时间或 Renderer 内存不可接受时，才考虑 retention 或其他存储优化。

## 6. 未采用的方案

- 不用一个 ID 同时表示 Task 和 Agent Invocation；
- 不把 Invocation 藏在成功结果的临时 debug 字段内；
- 不建立全局 Agent Invocation / Span 数据库；Debug Store 只是按 ID 读取的本地文件目录；
- 不把 Chat transcript 当作唯一调试事实；
- 不因字段升级静默删除未知高版本数据；
- 不为尚未出现的规模问题引入采样、TTL、远端 Trace、内容寻址或恢复日志；
- 不引入 Phoenix、OpenTelemetry 或其他需要 exporter/backend 的观测组件；
- 不继续维护与 Pi Provider 平行的 HTTP streaming/调试 transport。

## 7. 结论

当前设计用最薄的三层边界解决问题：Task / Conversation 记录业务，Invocation envelope 记录一次 Agent 生命周期，Pi Session 保存原生执行历史，Debug Record 保存本地检查所需的完整内部活动。Trace / Span 留给未来真正的遥测需求。早期 SQLite、单一大型 Invocation 快照、内存 Knowledge Session、`runId` 和平行 Provider transport 均不再是实现规范。
