# ADR-0001：将 Oyster 定位为 Agent-Agnostic Knowledge Hub

- 状态：Accepted
- 日期：2026-07-22
- 关联文档：[Product Brief](../product/product-brief.md)、[本地 Agent 发现与历史同步 MVP](../product/local-agent-discovery-mvp.md)、[可行性分析](../architecture/agent-knowledge-hub-feasibility.md)、[本机 Agent 发现与存量数据定位](../architecture/agent-discovery-and-history-import.md)、[知识模型与 Attention 驱动投影](../architecture/knowledge-model-and-projection.md)

## Context

旧项目从 AI 浏览器起步，新仓库交接时已转向 Context Workbench。进一步分析发现，最稳定且跨产品的用户问题不是缺少新的浏览器或 Agent Harness，而是 Claude Code、Pi、Codex 等工具把活动和知识分别保存在不同会话、项目与私有格式中。

用户需要一个独立所有者来回填历史、持续采集、保留出处、构建知识，并把经过 Scope 控制的结果重新提供给多个 Agent。若 Oyster 同时把浏览器、Agent 执行和知识中心都作为 MVP 主轴，产品价值与工程边界会再次发散。

## Decision

Oyster 的主要产品身份是：本地优先、跨 Agent、跨项目的知识库维护中心。

系统采用三个明确分层：

1. Raw Evidence：保留 Harness 原始 transcript 和人类编写的指令及其来源，不导入 Agent 自动生成的 memory；
2. Canonical Activity：标准化 Session、Turn、Message、Tool 和 Artifact 等活动；
3. Derived Knowledge：由规则、LLM 和用户审查生成的可修订知识。

2026-07-23 的知识模型分析对这三个加工/存储阶段作了进一步的认识论澄清：Raw Evidence 与 Canonical Activity 共同属于“观察层”，Derived Knowledge 属于“知识层”，其上还有按用户 Attention 生成且可重建的“投影层”。这不改变原始证据与派生结果分离的决策，也不要求投影成为新的事实存储。

历史导入和实时插件进入同一幂等 Ingestion Pipeline。输出侧优先通过 MCP 和本地 API 提供 Pull-based Search/Context。自动上下文注入、内置 Agent、浏览器和执行能力延后，在不改变知识所有权与安全边界的前提下增加。

“Data Lake”只作为保真收集与分层加工的类比，不采用企业数据湖基础设施作为 MVP 默认路线。

历史导入遵循以下策略：

- Conversation transcript 与人类编写的 Agent 指令是必须保存的两类原始证据；
- 每个 Harness 的 JSONL、Markdown 或其他格式按源文件字节和扩展名保存，导入时不统一 Schema、不拼接指令与 transcript；
- 轻量 header/metadata 解析只用于 catalog、统计和增量判断，完整标准化与 LLM 理解发生在后续可重建层；
- Agent 自动生成的 memory 不导入。它属于外部 Agent 的派生结果，而且扫描时的当前版本不能证明某个历史 turn 实际看到的版本；未来精确上下文由实时 Connector 的 turn-level snapshot 解决。

## Consequences

### Positive

- 产品价值不依赖单个 Agent、模型、浏览器或 Harness；
- 旧历史可以回填，离线漏采可以恢复；
- 原始证据和 LLM 推断分离，知识可审查、重建和删除；
- 跨项目关系和跨 Agent 检索成为一等能力；
- MCP 等开放协议可以作为消费者边界，而不污染内部模型。

### Negative

- Connector 和上游格式兼容性成为长期维护成本；
- 保存完整 Agent 历史带来高敏数据、安全和删除责任；
- 三层模型与出处比“消息 + 向量库”复杂；
- 知识质量需要真实评测与人工治理，不能只靠模型能力；
- 相邻产品已提供跨 Agent Memory/MCP，必须持续证明 Oyster 在历史回填、异构保真和治理上的差异。

## Rejected alternatives

- 继续以独立浏览器为产品主体；
- 先建设通用 Agent Harness，再附加记忆；
- 只做统一聊天记录查看器；
- 只做向量数据库和 MCP Memory CRUD；
- 默认自动注入所有检索结果；
- 为追求统一而丢弃 Harness 原始事件与分支语义。

## Review trigger

出现以下证据之一时复审本 ADR：

- 目标 Harness 提供稳定、通用且可回填的标准历史协议；
- 用户研究表明跨 Harness 回填和检索没有显著价值；
- 安全/隐私要求使本地完整历史保存不可接受；
- MVP 无法在真实查询集上显著减少重复解释或重复尝试；
- 浏览器或执行能力被证明是知识价值闭环不可缺少的前置条件。
