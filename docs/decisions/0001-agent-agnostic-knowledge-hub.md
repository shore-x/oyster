# ADR-0001：将 Oyster 定位为 Agent-Agnostic Knowledge Hub

- 状态：Accepted
- 日期：2026-07-22
- 修订：2026-07-24，明确预处理、知识维护 Agent、共享 Attention 与投影的边界
- 修订：2026-07-26，明确 Observation Preprocessor、Evidence Map、Knowledge Maintenance Agent、Knowledge Contribution 与 Knowledge Statement 的定义
- 修订：2026-07-26，明确本地外部 Agent 历史原地按需读取，不复制到 Oyster
- 关联文档：[Product Brief](../product/product-brief.md)、[本地 Agent 发现与外部证据访问](../product/local-agent-discovery-mvp.md)、[AI Backend MVP](../product/ai-backends-mvp.md)、[知识加工验证 MVP](../product/knowledge-processing-mvp.md)、[知识加工与协作式投影](../architecture/knowledge-model-and-projection.md)

## Context

旧项目从 AI 浏览器起步，新仓库交接时已转向 Context Workbench。进一步分析发现，最稳定且跨产品的用户问题不是缺少新的浏览器或 Agent Harness，而是 Claude Code、Pi、Codex 等工具把活动和知识分别保存在不同会话、项目与私有格式中。

用户需要一个独立系统来发现和利用历史、持续接入新活动、保留出处、构建知识，并把经过 Scope 控制的结果重新提供给多个 Agent。若 Oyster 同时把浏览器、Agent 执行和知识中心都作为 MVP 主轴，产品价值与工程边界会再次发散。

## Decision

Oyster 的主要产品身份是：本地优先、跨 Agent、跨项目的知识库维护中心。

系统采用三个认识论层次：

1. 观察层：Raw Evidence 以来源和版本身份引用 Harness 原始 transcript 与人类指令，并由 Source Adapter 在原始位置按需读取；Canonical Activity 确定性标准化 Session、Turn、Message、Tool 和 Artifact 等活动；
2. 知识层：受控 Knowledge Maintenance Agent、经授权的知识生产 Pipeline 和用户从观察或已有知识形成可引用、可修订的 Knowledge Statement；
3. 投影层：由共享知识和 Attention 初始化、由用户与 Projection Agent 基于当前版本共同维护的持久文档，以及临时 Context Packet。

三层保持不同的数据所有权，但知识加工与投影通过共享 Attention 耦合。Observation Preprocessor 负责解析、降噪、索引和有界局部理解，只产生称为 Evidence Map 的可丢弃、可重算、可回源 Working Artifact；Knowledge Maintenance Agent 负责多步探索现有知识，并通过 Knowledge Contribution 提出对一条或多条 Knowledge Statement 的创建、补充、限定、修订或关联；Oyster Core 统一拥有 Scope、出处校验、审计、提交和删除。任何 Pipeline 若被授权直接产生 Knowledge Contribution，就成为正式知识生产者并服从同一治理契约，不按处理器或投影建立不同的真相存储。

投影文档不是新的世界事实，也不是可由下层覆盖式重建的纯派生物。后续更新必须基于当前文档版本；Projection Agent 可以提出 Knowledge Need，但不能把当前 Markdown 自动回流为知识。

本地历史和未来实时来源进入同一观察处理边界。输出侧优先通过 MCP 和本地 API 提供 Pull-based Search/Context。自动上下文注入、内置 Agent、浏览器和执行能力延后，在不改变知识所有权与安全边界的前提下增加。

本地历史遵循以下策略：

- Conversation transcript 与人类编写的 Agent 指令是当前支持的两类外部 Raw Evidence；
- Oyster 只保存稳定来源身份、内部 locator 和轻量版本指纹，不复制每个 Harness 的 JSONL、Markdown 或其他原始正文；
- 轻量 header/metadata 解析只用于 catalog、统计和变化判断。使用证据时，Source Adapter 校验并读取用户选择的确定版本；完整标准化与 LLM 理解发生在后续可重建层；
- 外部记录可以变化或消失。知识出处继续保留当时使用的来源与版本身份；再次展开失败必须明确暴露，不能静默改用另一个版本；
- Agent 自动生成的 memory 不作为来源。它属于外部 Agent 的派生结果，而且扫描时的当前版本不能证明某个历史 turn 实际看到的版本。

## Consequences

### Positive

- 产品价值不依赖单个 Agent、模型、浏览器或 Harness；
- 大型历史可以按 Session 使用，无需维护第二份完整数据；
- 原始证据和 LLM/Agent 推断分离，知识可审查、重建和删除；
- Evidence Map、Knowledge Contribution 与 Knowledge Statement 的边界清晰，正式知识生产者复用统一的贡献和治理契约；
- 跨项目关系和跨 Agent 检索成为一等能力；
- MCP 等开放协议可以作为消费者边界，而不污染内部模型。

### Negative

- Connector 和上游格式兼容性成为长期维护成本；
- Oyster 对外部目录及格式保持运行时依赖，记录变化或消失后可能无法再次核查原文；
- 三层状态、共享 Attention 与 Agent 维护边界比“消息 + 向量库”复杂；
- 知识质量需要真实评测与人工治理，不能只靠模型能力；
- 相邻产品已提供跨 Agent Memory/MCP，必须持续证明 Oyster 在历史访问、异构保真和治理上的差异。

## Rejected alternatives

- 继续以独立浏览器为产品主体；
- 先建设通用 Agent Harness，再附加记忆；
- 只做统一聊天记录查看器；
- 只做向量数据库和 MCP Memory CRUD；
- 默认自动注入所有检索结果；
- 为追求统一而丢弃 Harness 原始事件与分支语义。

## Review trigger

出现以下证据之一时复审本 ADR：

- 目标 Harness 提供稳定、通用且可枚举、读取的标准历史协议；
- 用户研究表明跨 Harness 历史访问和检索没有显著价值；
- 上游变化频率使按需读取无法提供足够的版本确定性；
- MVP 无法在真实查询集上显著减少重复解释或重复尝试；
- 浏览器或执行能力被证明是知识价值闭环不可缺少的前置条件。
