# Oyster 设计文档

本目录记录 Oyster 的产品理由、概念定义、稳定架构取舍、历史决策和研究证据。设计文档解释“为什么这样设计”和需要长期保持的边界；精确字段、像素、重试次数、目录扫描上限及测试清单由代码和测试维护。

## 建议阅读顺序

1. [Product Brief](product/product-brief.md)：产品解决什么问题，以及当前阶段的承诺和边界；
2. [领域概念](architecture/terminology.md)：Observation、Knowledge、Artifact 等名词的含义；
3. [信息模型](architecture/knowledge-model-and-projection.md)：三种信息形态为什么分开，以及如何在同一 Repository 中协作；
4. [Agent Runtime](architecture/agent-runtime.md)：Agent 执行层的职责和高信任边界；
5. [统一 Repository 与 Agent Git 协作](architecture/unified-git-agent-collaboration.md)：Task、revision 与 worktree 的协作模型。

按功能继续阅读：

- [Artifact 与工作台](product/artifact-repository-mvp.md)
- [通用 Chat Agent](product/chat-agent-mvp.md)
- [知识加工](product/knowledge-processing-mvp.md)
- [本地 Agent 来源发现](product/local-agent-discovery-mvp.md)
- [AI Connection](product/ai-backends-mvp.md)
- [外部 Skill 发现](product/skill-discovery-mvp.md)与 [Skill 绑定](product/skill-symlink-injection-mvp.md)
- [文件浏览](product/folder-browser-mvp.md)、[局部知识图](product/knowledge-local-graph-mvp.md)与 [UI 基础](product/ui-foundation.md)

## 文档分工

文档不以整份文件自称“全局权威”。不同内容按其问题域承担责任：

- `product/` 说明用户问题、体验边界和产品方向；
- `architecture/` 定义跨功能概念、关系和稳定技术取舍；
- `decisions/` 保存重要取舍中仍有解释价值的历史理由，不充当当前实现说明。ADR 可以删除已经造成误导的陈旧执行细节，但必须明确标注取代关系；当前规范由 `product/` 与 `architecture/` 承担。只有需要保留独立决策历史的新核心取舍才新增 ADR；
- `research/` 保存证据、比较和沟通底稿，不参与当前设计冲突的裁决；
- 代码与测试表达精确实现。如果设计不变量与代码不一致，应显式修订其中一方，而不是在另一份文档中增加平行定义。

## 状态表达

同一文档可以同时包含不同成熟度的内容，使用以下标签就地说明：

- **当前**：已经采用、并应与代码保持一致的设计；
- **目标**：已经确认的产品方向，但可能尚未形成完整实现；
- **候选**：有待真实场景验证的提案，不构成实现承诺；
- **历史**：帮助理解演进的事实，不用于定义当前行为。

日期只能说明一次编辑发生的时间，不能证明文档仍与代码同步。新增内容应优先引用已有定义，避免复制路径表、接口清单或功能盘点。

## 决策与研究

- [ADR-0001：Agent-agnostic 知识与协作产物中心](decisions/0001-agent-agnostic-knowledge-hub.md)
- [ADR-0002：统一 Repository、tracked Task 与独立 worktree（已取代）](decisions/0002-unified-git-agent-collaboration.md)
- [Agent Invocation 历史持久化研究](research/agent-invocation-history-persistence.md)
- [Coding Agent Skill 生态调研](research/agent-skill-discovery-and-format.md)
- [2026-08-11 设计文档审计与批注](research/design-document-audit-2026-08-11.md)：非规范性的沟通底稿，保留用户批注和当时的代码证据。
