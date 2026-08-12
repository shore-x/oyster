# ADR-0001：定位为 Agent-agnostic 的知识与协作产物中心

- 状态：Accepted；历史决策记录
- 日期：2026-07-22
- 后续演进：[当前 Git 协作架构](../architecture/unified-git-agent-collaboration.md) 取代了早期的物理存储与执行方案；[ADR-0002](0002-unified-git-agent-collaboration.md) 保留中间阶段的历史理由

## Context

Oyster 最初从 AI 浏览器和 Context Workbench 演进而来。进一步分析发现，跨产品更稳定的问题并不是缺少另一个浏览器或 Agent Harness，而是不同 Agent 把活动、结论与产物分散在各自会话、外部工作目录和私有格式中。用户难以复用过去的调查，也难以核查模型总结来自哪里。

如果同时把浏览器、Agent 执行、知识中心和自主编排作为产品主轴，MVP 无法验证最核心的价值。

## Decision

Oyster 以本地优先、跨 Agent 的知识与协作产物中心为主要产品身份：

- 保留 Observation、Knowledge 与 Artifact 三种不同的信息形态；
- 从外部 Agent 活动形成可修订的 Knowledge，并把人类指令纳入可选 Observation 输入方向，而不把聊天副本直接当作知识；
- 让 Artifact 保留用户与 Agent 共同维护的真实文件，不把它简化为可覆盖重建的 Knowledge 投影；
- 通过通用 Agent 对话连接这些内容，同时不把产品绑定到某个 Provider、Runtime 或外部 Harness；
- 采用本地标准 Git Repository 保存正式内容和修订历史。

这项决定不引入 Oyster Project 或 Workspace 实体。外部工具中的项目路径只是来源语境。

## Why

三种信息具有不同的变更语义：Observation 要保真，Knowledge 要能被纠正，Artifact 要保留用户接纳的状态。分开表达它们，可以在不复制全部外部历史的情况下追溯来源，也可以让任意文件产物继续使用成熟 Coding Agent 与 Git 工具。

选择通用 Agent 和普通文件，而不是大量专用 CRUD、Artifact 类型或固定编排，是为了让早期架构保持可解释，并把语义判断留给能力足够的 Agent。

## Consequences

- 产品价值不依赖某一个 Agent、模型或 Harness；
- 外部来源格式和访问失效成为长期适配成本；
- Knowledge provenance、Artifact 重命名和协作治理仍需要后续设计；
- Agent 以当前 OS 用户权限操作本地文件，MVP 接受高信任模型带来的风险；
- 物理 Repository 与 Task 的 Git 协作由[当前架构文档](../architecture/unified-git-agent-collaboration.md)定义，不再由本记录持续追踪执行细节。

## Rejected alternatives

- 继续把浏览器作为产品主体；
- 只做跨 Agent 聊天查看器或向量 Memory；
- 把模型摘要自动当成正式知识；
- 因为 Knowledge 和 Artifact 都可能是 Markdown，就把它们合并成同一类节点；
- 在缺少真实证据时预先建设 Project 模型、固定多 Agent 工作流或复杂权限治理。
