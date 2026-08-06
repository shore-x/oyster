# Agent 运行历史与模型调用调试

> 状态：方案 B 已确认并实施
>
> 日期：2026-08-06
>
> 实施结果：通用 Agent Run 使用独立版本、稳定 `agentId` 和统一校验；加工历史升级为 V5 终态 Envelope；成功、失败和取消均可下钻 Agent Run 与单次 Model Call。

## 1. 研究问题

加工测试的历史结果需要同时回答两类问题：这次测试最终产生了什么，以及 Agent 为什么产生这个结果。用户应能从一次历史测试进入对应 Agent 运行，再下钻到任意一次 LLM 调用，查看模型实际收到的 Pi Context、工具定义、生成参数、输出、用量和错误。

本设计只解决本地历史调试，不建设通用可观测平台。分布式 Trace、跨应用聚合、在线指标、采样、自动保留期限、Provider HTTP Payload 和运行恢复均不在范围内。

成功标准是：

- 产品测试运行、Agent 运行和 LLM 调用的身份与生命周期不再混淆；
- 成功、失败和取消都能留下足够的终态调试记录；
- Chat、加工测试及未来 Agent 可以复用同一个 `AgentRunRecord` 和展示组件；
- 列表读取保持轻量，详情按用户选择读取；
- 不为尚未出现的查询、规模或分布式需求引入 Trace/Span 平台。

## 2. 改造前实现分析

### 2.1 已经合理的部分

- `PiAgentRunRecorder` 在实际 `streamFn` 边界记录调用，因此得到的是经过 `transformContext` 和 `convertToLlm` 后的 Pi Context，而不是无法证明实际送入模型的高层消息推测。
- `AgentRunRecord` 已经区分 Turn、Message、Tool Call 和 Model Call；Agent 主调用与 Context Compaction 也有明确 `purpose`。
- 记录生成参数时采用显式安全字段集合，不复制 API Key、Header、回调、环境变量或 Provider Payload。
- 加工历史 SQLite 用普通列保存列表摘要、用 `payload_json` 保存不可变详情。列表不读取完整正文，用户打开记录后才读取 JSON；对当前本地调试产品，这是简单而合适的访问边界。
- Chat、实时加工和加工历史已经复用 `AgentRunExplorer`。Assistant Message 能定位相应 Model Call，Context Compaction 等没有普通 Assistant Message 的调用则作为独立 Timeline 事件展示。

### 2.2 改造前需要修正的部分

1. **产品运行与 Agent 运行共用同一个 ID。** 完整链路在读取 Session 前就创建一个形似 `AgentRunRecord` 的空调试记录；如果来源读取失败，实际上没有 Agent 被调用，却仍会出现一个 Agent Run。一次加工测试与其中一次 Agent Runtime 调用是两个不同生命周期，不能依赖当前“一次链路只有一个 Maintainer”的偶然关系合并。
2. **历史只保存成功运行。** `history.save` 位于成功路径，失败和取消只更新进程内 `debugTraces`。应用重启后，最需要调试的运行消失。
3. **持久记录把 Agent Run 藏在成功结果内部。** `result.maintenance.debugTrace.run` 无法自然表达“产品运行失败但 Agent 已运行”，也无法表达失败发生在 Agent 启动前。
4. **共享格式没有自己的版本。** Chat 以 `oyster-agent-run-v1` Custom Entry 保存，知识加工以 V4 业务 Payload 间接保存，但 `AgentRunRecord` 本身没有 `formatVersion`。物理所有者不同是合理的，格式升级边界不一致则不是。
5. **Schema 升级直接删除整个历史表。** 在历史仍是开发期临时数据时可以接受；一旦它成为用户可见的调试入口，静默清空全部记录就不再是稳定的产品语义。
6. **完整 Context 会重复。** 每次 LLM 调用都保存累计 Context，同时 Run Timeline 还保存消息。调用次数增加时 Payload 会重复增长。不过“查看某次模型实际输入”本身要求保留每次调用的有效 Context；当前没有实际数据证明需要为此增加内容寻址、差量编码或独立 Blob Store。

## 3. 成熟方案证据

| 来源 | 机制 | 对 Oyster 的启示 |
| --- | --- | --- |
| [OpenAI Agents SDK Tracing](https://openai.github.io/openai-agents-python/tracing/) | 一个 Trace 表示端到端 workflow；Span 通过 `trace_id` 和 `parent_id` 形成层级，Generation 与 Function Tool 各有独立 Span。多个 Agent `run()` 可以属于同一个更高层 Trace。 | 产品执行与其中的 Agent/LLM/Tool 操作应有不同身份；单次 LLM 调用是一等下钻边界。 |
| [LangSmith Observability Concepts](https://docs.langchain.com/langsmith/observability-concepts) | 每个模型调用、工具调用或检索是一个 Run；一次操作的 Runs 形成 Trace，多轮会话再用 Thread 聚合。Trace 保留嵌套与时序，Trajectory 只是消息投影。 | 调试 Timeline 不应退化成 Chat transcript；消息视图可以由运行记录投影，不应成为唯一事实。 |
| [Langfuse Data Model](https://langfuse.com/docs/observability/data-model) | LLM、Tool 等步骤是可嵌套 Observation，Trace 用共同 `trace_id` 聚合。当前实现把 Observation 作为可独立查询的行，并保存 input/output、model、usage、cost 等字段。 | 行级 Observation 适合跨 Trace 检索和分析，但 Oyster 当前只按一次本地测试读取详情，没有复制其分析型存储的必要。 |
| [OpenTelemetry GenAI Spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) | 输入、输出和指令被明确视为敏感且通常很大；默认建议不记录，调试场景可选择记录到 Span，生产规模下可把内容放到外部存储并只留引用。完整消息、系统指令和工具定义都是 Opt-In。 | Oyster 的加工测试是明确的本地调试入口，可以保存完整 Pi Context，但必须如实披露敏感性；在没有规模证据前不增加外部 Blob Store。 |
| [OpenInference Trace Config and Data Masking](https://github.com/Arize-ai/openinference/blob/main/js/packages/openinference-core/docs/trace-config-and-masking.md) | 输入、输出、消息、工具和图片可以在导出前分别移除或脱敏。 | “不记录传输凭据”与“Context 本身可能敏感”是两个边界。当前安全字段白名单是必要的，但不能把本地 Context 描述成无敏感数据。 |

这些项目的共同机制是“根执行 + 可嵌套操作 + 单次生成详情”，不是某一种数据库。Langfuse 的 Observation 表、OpenTelemetry exporter 和远端 Trace 后端服务的是跨运行检索、聚合与运营规模；这些假设目前不适用于 Oyster。

## 4. 方案比较

### 方案 A：保持 V4 不变

优点是没有持久化改动，成功历史的 UI 已满足查看 Agent Timeline 和单次 LLM 调用。

缺点是失败与取消无法调试，产品运行与 Agent 运行仍被混为一体，后续 Maintainer/Reviewer 多次运行会迫使业务结果继续嵌套特殊字段。不能作为稳定方向。

### 方案 B：终态业务快照内保存版本化 Agent Runs（推荐）

加工历史仍是一份不可变终态业务快照，SQLite 仍使用摘要列加 JSON Payload。快照明确记录产品运行状态，并直接携带零个或多个版本化 `AgentRunRecord`：Agent 尚未启动时为零，当前单 Maintainer 链路通常为一个，未来同一测试中的 Maintainer/Reviewer 可自然为多个。

它保留单次事务写入、按需读取和领域所有权，同时消除当前成功结果内部的 `debugTrace` 特例。Chat 仍可把同一格式的 Agent Run 作为 Pi Session Custom Entry 保存，不需要为了“物理统一”复制两份数据或处理跨 Store 删除一致性。

### 方案 C：全局 Agent Run / Span 数据库

把所有 Agent、Tool 和 LLM 调用规范化为全局表，再由业务记录引用。它适合跨业务搜索、统计、保留策略和大 Payload 局部读取。

当前没有这些需求。它会立即引入 Owner/Scope、级联删除、跨 Store 原子性、事件升级、孤儿清理和权限边界，复杂度高于已验证问题，因此暂不采用。

### 方案 D：内容寻址或外部 Blob Store

它可以降低多次完整 Context 的重复并支持独立访问控制，但需要引用计数、垃圾回收、完整性校验和损坏恢复。只有实际历史 Payload 证明读取或磁盘成本不可接受时再设计。

## 5. 最小设计

### 5.1 只保留三个已有概念

- **加工测试运行**：从用户启动到链路成功、失败或取消的一次产品执行；拥有输入选择、冻结配置、终态结果或错误。
- **Agent Run**：一次真正进入通用 Agent Runtime 的模型—工具循环；在 Runtime 创建时才产生。
- **Model Call**：一次实际 `streamFn` 调用；属于一个 Agent Run。

不新增 Trace、Span、Observation、Trajectory 或 Log Event 作为 Oyster 领域概念。外部术语只用于比较机制。

### 5.2 共享 Agent Run 格式

`AgentRunRecord` 增加自己的格式版本和稳定 Agent 身份：

```ts
interface AgentRunRecord {
  formatVersion: 1
  id: string
  agentId: string
  parentRunId?: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  // 现有时间、错误、turns、messages、toolCalls、modelCalls 保持不变
}
```

`agentId` 表示逻辑 Agent 定义，例如 `knowledge_maintenance_agent` 或 `chat_agent`，不是本次产品运行 ID，也不是临时实例名称。`parentRunId` 只表达 Agent Run 之间真实存在的父子关系，不指向加工测试运行。

### 5.3 加工历史终态 Envelope

下一版加工历史记录应从“成功结果快照”改为“终态运行快照”：

```ts
interface KnowledgeFullChainRunRecord {
  formatVersion: 5
  runId: string
  status: 'completed' | 'failed' | 'cancelled'
  startedAt: string
  completedAt: string
  durationMs: number
  input: RunKnowledgeFullChainInput
  configuration: { maintainer: KnowledgeFullChainStageSnapshot }
  agentRuns: AgentRunRecord[]
  result?: KnowledgeFullChainResult
  error?: string
}
```

终态约束为：

- `completed` 必须有 `result`，且没有顶层 `error`；
- `failed | cancelled` 必须有 `error`，且没有可导入的 `result`；
- `agentRuns` 只包含真正启动过的 Agent；来源解析或 Sandbox 创建提前失败时可以为空；
- 数组顺序是 Agent 实际启动顺序；当前链路不另外引入步骤关系 Schema；
- 所有 Agent Run 在持久化前必须已终态化，运行中的快照只用于实时 UI；
- 历史写入失败仍应使整次测试报告失败，避免用户看到成功结果却误以为已经进入历史。

`KnowledgeProcessingDebugTrace` 只保留为实时页面的 View Model（Agent Run 加 Workspace 状态），不再作为持久化实体，也不再出现在成功业务结果内部。

### 5.4 写入与读取

- 完整链路在终态统一冻结记录，并以一次 SQLite 事务插入；成功、失败和取消走同一保存出口。
- 第一阶段仍只保存终态，不为进程崩溃恢复增加增量事件日志。进程被强制终止时可能没有历史记录，这是明确非目标。
- SQLite 继续保存列表需要的状态、时间、Session 摘要、模型和计数列，完整 Envelope 继续放在 `payload_json`。
- 列表 API 不返回 Agent 消息、Context 或结果正文；详情 API 按 `runId` 返回完整 Envelope。
- 选择某个 Model Call 时，Renderer 继续从已加载的 Agent Run 打开现有 Inspector。暂不增加“按 call ID 单独读数据库”的接口；只有实测单条 Payload 过大时再拆分。
- V5 可以在当前开发期做最后一次明确重建；从稳定 V5 开始，SQLite Schema 变更使用显式迁移，不再把“升级即清空全部历史”作为默认策略。无法解析的旧 Payload 应明确报出版本问题，而不是静默伪装为空历史。

### 5.5 历史 UI

- 历史列表展示所有终态运行及状态；失败项优先展示错误，结果按钮只对 `completed` 可用。
- “运行详情”先展示该加工测试的状态和错误，再展示实际存在的 Agent Runs。当前只有一个时直接进入；多个时按启动顺序选择。
- Agent Timeline 与 Model Call Inspector 继续完全复用现有组件。单次调用详情继续显示 System Prompt、完整 Pi Context、工具定义、安全生成参数、输出、用量和错误。
- 页面继续明确说明记录可能包含原始材料和完整 Context，只保证不含已排除的传输凭据与 Provider Payload。

## 6. 借用、调整与拒绝

- **借用**：成熟方案中端到端执行与单次操作分层、单次生成输入输出可独立查看、父子关系只表达真实调用关系。
- **调整**：Oyster 用已有 `AgentRunRecord` 和 `ModelCallRecord` 表达这套层级，不引入 Trace/Span 名词；完整内容只在本地调试历史中保存。
- **拒绝**：暂不复制 Langfuse 的 Observation 分析表、OpenTelemetry exporter、采样、自动 TTL、远端 Trace 服务或内容 Blob 引用。
- **保留**：业务聚合拥有自己的 Agent Run 快照。Chat JSONL 与加工 SQLite 可以是不同物理 Store，只要保存同一版本化格式并复用同一展示语义。

## 7. 验证边界

### 数据与生命周期

- 来源读取失败：历史为 `failed`，`agentRuns` 为空，不能导入结果。
- Agent 首次模型调用失败：历史为 `failed`，包含一个失败 Agent Run 和失败 Model Call。
- 用户取消：历史为 `cancelled`，所有仍在运行的 Turn、Tool Call 和 Model Call 被终态化。
- 成功：结果、配置和 Agent Run 在同一条不可变记录中，重复 `runId` 仍被拒绝。
- Chat Custom Entry 与加工历史都拒绝未知的 `AgentRunRecord.formatVersion`。

### UI

- 成功、失败、取消三类卡片状态正确，只有成功项可以查看或导入结果。
- 历史详情的 Timeline 事件数与持久记录一致。
- 从普通 Assistant Message、独立 Context Compaction 和失败 Model Call 都能打开相应 Inspector。
- Inspector 展示的 Context、Tools、Options 和 Output 与 Recorder 在 `streamFn` 边界捕获的数据一致。

### 非功能检查

- 列表返回值不含 Prompt、消息、工具结果或 Statement 正文。
- Payload 不包含 API Key、Authorization Header、AbortSignal、回调或 Provider Payload。
- 用真实长运行记录测量单条 Payload 大小、详情读取时间和 Renderer 峰值内存；只有指标成为问题时才启动 Model Call 分表或 Blob Store 设计。

## 8. 尚未决定但不阻塞本方案的问题

- 是否提供删除单条或清空历史的显式入口。完整 Context 具有敏感性，最终产品需要用户可控的数据生命周期；当前不应以隐藏的 TTL 或磁盘配额代替这个产品决定。
- 未来统一 Git 协作的一次加工测试如何给多个 Maintainer/Reviewer Agent Run 增加业务标签。只有实际编排模型确定后再定义，不把临时研究角色提前固化进通用 Runtime。
