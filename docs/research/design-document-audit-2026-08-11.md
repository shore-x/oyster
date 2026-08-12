# Oyster 设计文档审计与待确认问题

> 状态：供批注的审计草案，不是当前设计规范
>
> 日期：2026-08-11
>
> 目的：记录现有文档与代码之间已经验证的差异、尚未解释的设计取舍和文档重组建议，作为后续逐项确认与修订设计文档的沟通底稿。

## 1. 审计结论

Oyster 当前并不缺少设计内容，主要问题是缺少清晰的信息层级和时间边界。同一概念经常同时出现在 Product Brief、Architecture、ADR、MVP 文档和 README 中；这些副本分别混合了产品承诺、当前实现、目标状态、候选方向和实现常量。代码快速演进后，读者已经难以判断哪一处是权威定义、哪一处只是历史或计划。

本轮最需要先确认的不是具体文案，而是以下几组产品与架构问题：

1. 哪类文档分别拥有产品定位、领域定义、架构约束和历史决策，发生冲突时如何裁决；
2. 主工作树中用户和 Chat Agent 可见的未提交内容，何时成为 Knowledge Processing Task 可见的正式 revision；
3. Task 的 `completed`、Reviewer 的批准与内容进入主分支分别表示什么；
4. Attention 是否真的是一个共享概念，以及它目前在 Artifact 和 Task 中为何是两份没有身份关联的文本；
5. “知识可核查出处”是否是当前核心承诺，以及正式 Knowledge 为何没有保留来源关系；
6. 本地 Agent 以完整 OS 权限运行、Debug Store 保存完整上下文、通用文件浏览器可读取任意绝对路径时，Oyster 的信任和数据保留模型是什么。

在这些问题确认前直接精简文案，容易只删除表面重复，却继续保留互相矛盾的模型。

## 2. 范围、方法与标记

本轮检查了：

- `README.md`；
- `docs/architecture/` 4 份文档；
- `docs/decisions/` 2 份 ADR；
- `docs/product/` 11 份文档；
- `docs/research/` 2 份文档；
- Main、Preload、Renderer 的共享契约、领域服务、IPC 和主要 UI；
- 相关测试和 Git 历史。

共计 19 份设计文档、2254 行 Markdown，另有 108 行 README。`npm run typecheck` 和 `npm test` 均通过；测试结果为 63 个测试文件、327 个测试。因此，本文列出的多数问题不是“代码不能运行”，而是设计语义、承诺边界或长期一致性尚未成立。

本文使用以下标记：

- **已验证事实**：可以直接由当前文档、代码或 Git 历史确认；
- **风险推断**：事实可能导致的结果，尚未由真实用户数据证明；
- **待确认**：需要补充产品意图或架构背景，不能由代码替用户决定；
- **建议方向**：供讨论，不代表已确定方案。

优先级表示建议的讨论顺序，而不是实现排期：`P0` 会改变其他文档的含义，`P1` 涉及核心边界，`P2` 是局部一致性或维护性问题。

## 3. 明确陈旧或互相冲突的内容

### STALE-01（P0）：README 仍描述已废弃的 Run 架构

**已验证事实**

- `README.md:20-23, 80, 98, 100-102` 仍使用 Pi Agent Core、`runs/<run-id>/WORK.md`、`run.json`、`processing/<run-id>`、`chat-sessions/` 和“所有 Agent 使用同一物理工作树”等旧定义。
- 当前代码使用 Pi Coding Agent SDK、`tasks/<taskId>/`、`task/<taskId>`、Repository 外 linked worktree 和 `chat-conversations/`。
- Git 历史显示 `583a694` 已完成 worktree 重构，之后 README 又因工作台命名被修改，但旧运行模型没有同步清除。
- 这也直接违反 `terminology.md:92` 不再以 `runId` 表示 Oyster 领域实体的规则。

**风险推断**

README 当前不是“不够完整”，而是会让新读者建立错误的 Repository、持久化和并发心智。手工日期或“当前实现”标签也已被证明不能保证新鲜度。

**建议方向**

README 只保留产品入口、开发方式和非常短的当前能力摘要，不再复制存储拓扑与完整业务流程。

> 用户批注：合理, README只作为入口即可, 不要写太多详细的设计. 可考虑让README作为其他设计文档的根目录, 对其他文档进行引用. 目前的文档太散乱了, 很多文档的定义不清晰.

### STALE-02（P0）：Product Brief 同时充当定位、当前实现、MVP 目标和路线图

**已验证事实**

- `product-brief.md:5` 将自身称为当前产品定位的 source of truth。
- 同一文档又用当前流程或“必须完成”的语气描述尚不存在的 Connector、实时采集、MCP、Context Packet、Secret/PII 检测与可见 Redaction 等能力。
- 当前 IPC 和业务模块中没有这些能力；`local-agent-discovery-mvp.md:111-119` 又明确把其中若干能力排除在当前切片之外。

**待确认**

Product Brief 中的“必须完成”是本阶段验收范围、长期产品承诺，还是早期愿景？其中哪些安全条目是发布 Gate，哪些只是演进原则？

**建议方向**

Product Brief 只保留问题、目标用户、产品承诺、边界、当前阶段和非目标。当前功能清单、实现状态和路线图不要继续混入定位文档。

> 用户批注：Product Brief 写的简单一点即可,  可考虑对 Product Brief 进行重构, 删除多余的重复内容

### STALE-03（P1）：Discovery 的启动行为和 Canonical Activity 状态互相冲突

**已验证事实**

- `product-brief.md:110-117` 写启动后执行本地发现；当前 `DiscoveryService.initialize()` 只加载持久状态，真正探测和刷新由用户按钮触发。
- `local-agent-discovery-mvp.md:7, 38, 88, 111-119` 多处把 Canonical Activity 排除在当前切片之外。
- 当前三个 Discovery Adapter 已实现 `createObservation()`，`readSourceSnapshot()` 也同时返回 Raw Evidence 和 Canonical Activity；Product Brief 与架构文档又把这条链路写成当前设计。

**待确认**

启动自动探测是否仍是目标体验？Discovery 文档想排除的是 Canonical Activity 的领域定义和消费职责，还是曾经确实未实现该能力？

> 用户批注：启动自动探测确实是目标体验. 我希望启动后可以自动探测本地的其他agent的状态, 并且未来可能也会支持其他信息的探测. 后续可能需要设计统一的管理模块来管理启动时执行的探测.

### CONFLICT-01（P0）：项目中存在多个自称权威的来源

**已验证事实**

- `terminology.md:3-7` 声称是全局权威词汇表，冲突时以它为准。
- `product-brief.md:5` 又称自身为 source of truth。
- Architecture 文档使用“当前架构”，MVP 文档使用“当前实现规格”，ADR 使用 Accepted，但同一 Artifact、Task、Repository 规则在多处重复改写。
- `docs/` 没有索引、阅读顺序、状态词定义或冲突裁决规则。

**待确认**

“权威”应该按文档分层，还是只保留一份总规范？本文在第 8 节给出一种分层建议。

> 用户批注：“权威”应该按文档分层, 不同文档只负责某个领域的权威. 并且后续在更新文档时, 需要注意避免把待定的内容写成权威. 我希望尽量不要把整个文档定义为权威, 最好文档中既包括确定性的权威内容, 也包括待定的内容, 文档中的内容要自解释, 并且最好能说明背景, 而不是生硬的声称自己为权威.

### CONFLICT-02（P0）：Task 声称不复制 Knowledge，实际持久化完整 Knowledge 快照

**已验证事实**

- `knowledge-model-and-projection.md:18, 51` 声明 Task 不拥有或复制 Knowledge/Artifact。
- `KnowledgeTaskResult` 包含 `knowledge: KnowledgeStatement[]`。
- Task 完成时，`KnowledgeTaskGitRepository.revisionView()` 读取候选 revision 的整个 `knowledge/` 树，Service 再把全部 Statement 的标题和正文写入 `result.knowledge`。
- 该结果随 `tasks/<taskId>/task.json` 持久化；历史 UI 用它统计和展示 Statement。
- 主要证据：`src/shared/knowledge-processing.ts:178-191`、`knowledge-task-git-repository.ts:536-554`、`knowledge-task-service.ts:203-225`、`knowledge-task-history.ts:162-179`。

**风险推断**

这不是临时 UI Projection，而是与每个 Task 一起增长的正式副本；它还会产生删除、保留和迁移语义。

**待确认**

Task 结果应只保存批准 revision、changed paths 和必要摘要，还是产品确实需要每次保存完整 Knowledge Snapshot？若保留，领域文档必须承认它的所有权和用途。

> 用户批注：Task 本身结果应只保存批准 revision、changed paths 和必要摘要. 不同的task其实都是在不同的git tree中修改同一个仓库(包括知识和产物, 以及task的文件夹), task目录下只需要保存任务的摘要即可. 目前的设计中, 产品实际上不需要使用额外的逻辑保存完整 Knowledge Snapshot, 因为整个仓库的历史都是通过git来维护的. 你所说这些文档中的内容可以已经比较陈旧了, 是改造为使用git之前的设计文档.
### CONFLICT-03（P0）：Chat、工作台和 Task 使用两个不同的“当前事实”

**已验证事实**

- Chat Agent 直接以用户主 checkout 为 `cwd`，Host 不自动为 Chat 修改 commit。
- Knowledge 浏览器和工作台直接读取主 working tree，因此立即看到未提交修改。
- 新 Knowledge Processing Task 从已提交的 `main` revision 创建 linked worktree，明确不包含主 checkout 的 dirty changes。
- `unified-git-agent-collaboration.md:43-49, 136` 记录了这项差异，但没有定义正常修改由谁、何时提交。

**风险推断**

用户刚在对话中创建或修订并能在 UI 中看到的 Knowledge/Artifact，随后启动结构化 Task 时可能被静默忽略。

**待确认**

谁负责把用户当前看到的正式文件状态变成 Task 可见 revision：Chat Agent 自主 commit、用户显式保存、Host checkpoint，还是未来将 Chat 也迁入独立 worktree 并 promotion？

> 用户批注：关于这个的思路我还没有确定的结论, 但是我倾向于, 让用户和chat agent也对应特定的git worktree分支, 由agent来负责merge和rebase. 可以先记录这个思路, 但仅作参考. 目前还没有实现让用户手动编辑的能力, 这部分的设计可以之后再考虑.

### CONFLICT-04（P1）：“不复制聊天正文”的承诺没有区分发现与消费阶段

**已验证事实**

- Discovery catalog 的确只保存轻量摘要，不复制上游聊天正文。
- 用户接受 Source Snapshot 后，Task 会持久化 Canonical Activity、Raw Evidence、附件、Pi Session，以及含 Context、工具结果和 Provider payload 的 Debug Record。
- 因而同一来源可能在本地出现多种长期副本。
- `README.md:11, 96` 和 `product-brief.md:294-304` 的表达容易被理解为 Oyster 全程不保存正文。

**待确认**

接受 Task 后的物化输入、Session 和 Debug Record分别保留多久？用户解除来源、删除 Task 或删除 Conversation 时是否联动删除？

**建议方向**

精确区分“发现阶段不复制”“用户接受后为可审计处理而物化”和“调试数据完整落盘”三种边界。

> 用户批注： 目前对于debug数据的保存时间还没有很确定性的结论, 目前倾向于永久保留, 后续我希望设计统一的保留时间设置(例如30天), 并使用统一的模块来管理这些debug数据的清理.

### CONFLICT-05（P1）：Knowledge 的文档格式与主要阅读体验不一致

**已验证事实**

- 架构把 Knowledge Statement 定义为 H1 后跟 Markdown 正文。
- Knowledge 浏览器和 Chat Inspector 当前把正文作为普通文本渲染，只对 `[[...]]` 引用做特殊处理；没有使用共享 Markdown Renderer。

**待确认**

Knowledge 正文究竟是 Markdown，还是“支持 wikilink 的自然语言纯文本”？如果是 Markdown，当前 UI 是未完成体验；如果不是，文件格式定义需要修改。

> 用户批注：Knowledge 正文应该是markdown格式,  并且支持wikilink, 你可以把它认为是一种自定义的扩展markdown. 不过其中的正文比较偏向自然语言, 不再引入更多markdown格式.

### CONFLICT-06（P1）：Knowledge 的“清空全部”绕过 Git 协作语义

**已验证事实**

- Knowledge 页面可直接调用 `FileKnowledgeStore.clear()` 删除主 working tree 中全部正式 Knowledge 文件。
- 这条路径不经过 Agent、Task、统一 Git Runtime 或 commit。
- UI 声称“无法撤销”，但已提交内容理论上可由 Git 恢复；未提交内容才可能真正丢失。

**待确认**

这是 fixture/bootstrap 遗留，还是正式用户能力？若保留，需要定义删除、恢复、并发和 Task 可见性；若不保留，应从产品界面移除。

> 用户批注：清空全部属于之前遗留的测试能力, 与当前使用git的设计冲突了, 目前应该移除这个功能

### CONFLICT-07（P2）：权威字段命名与共享契约不一致

**已验证事实**

- `terminology.md:74-92` 规定 Knowledge Agent Definition 使用 `agentId`、Agent Invocation 使用 `invocationId`、Chat Conversation 使用 `conversationId`。
- 当前持久 `AgentInvocationRecord`、`KnowledgeAgentDefinitionView` 和 `ChatConversationSummary` 分别使用无前缀 `id`。

**待确认**

无前缀 `id` 是否被允许用于局部 View Model？如果允许，词汇表应写明边界；如果不允许，代码迁移尚未完成。

> 用户批注：这里的无前缀 id 可能是历史遗留问题, 应该按照 terminology.md 中的定义来改造. 不过你需要review terminology 中的定义是否合理, 你需要保证terminology和实际的实现一致, 但不必把 terminology 当前状态当作不可更改的权威.

### CONFLICT-08（P2）：AI Model 刷新语义与文档承诺不一致

**已验证事实**

- `ai-backends-mvp.md:37` 声称刷新后 Connection/Model 不可用会明确报错且不静默替换。
- 当 `/models` 不再返回已保存的默认 Model ID 时，当前服务会把它重新补入目录并将 Connection 标为 ready。

**风险推断**

实现可能是在支持手填 Model ID，因为目录缺席不能证明调用不可用；问题在于理由和验证时机没有被文档说明。

**待确认**

自定义 Model 的可用性应在目录刷新时验证，还是只在测试/调用时验证？

> 用户批注：自定义 Model 的可用性在测试/调用时验证即可

### CONFLICT-09（P2）：Skill Scope 与“output 不被读取”的表述过度承诺

**已验证事实**

- `skill-symlink-injection-mvp.md:90-100` 称服务边界保留通用 scope 语义，但共享契约和 Managed Skill Service 只接受硬编码的 `user` scope。
- 同文档称 Oyster 不读取 `output/` 中脚本和可执行文件；实际上工作台通用文件浏览器和 Chat Agent 都可能通过普通能力读取它们。

**建议方向**

精确改为“Skill Binding/Discovery 服务不解释或执行输出内容”；项目级 scope 在真实需求出现时另行设计，不必宣称已预留通用模型。

> 用户批注：按照建议方向执行.

### CONFLICT-10（P1）：Project 仍被保留为开放概念，与最新定义冲突

**已验证事实**

- 最新工作台定义明确不引入 Project 或 Workspace。
- `product-brief.md:96`、`ADR-0001:53, 93` 仍把是否正式引入 Project/Collection/Workspace 写成未决定事项。

**建议方向**

后续修订时删除这项旧的开放问题。外部来源携带的 `projectPath` 可以继续是来源元数据，但不因此建立 Oyster Project 领域。

> 用户批注：不需要引入Project概念

### CONFLICT-11（P2）：Product Brief 对 Host commit 的表述内部冲突

**已验证事实**

- 当前流程说明 Host 会在 Agent 活动后 checkpoint 候选 revision。
- “明确不做”一节又写 Harness 不代理 commit。
- 代码实际由 Host 执行 `git add -A` 和 `git commit`；Agent 负责修改语义内容，并不直接决定 commit 边界。

**待确认**

原意是否是“Harness 不代替 Agent 生成领域内容”，而不是“不代为 commit”？需要把内容所有权和 Git checkpoint 职责分开表述。

> 用户批注：Host除了app初始化时之外, 不需要执行git操作, 我希望当前的设计是让agent来执行git相关命令即可, host不负责维护git

## 4. 核心定义中需要补充背景的地方

### TERM-01（P0）：Attention 是核心关系词，但没有权威定义

**已验证事实**

- 文档反复使用“Attention 耦合 Knowledge、Artifact 和 Task”，但术语表没有定义 Attention。
- `ArtifactSummary.attention` 是 Artifact 根 `AGENTS.md` 的完整正文。
- `StartKnowledgeTaskInput.attention` 是单次 Task 的可选自由字符串。
- 两者没有共享 ID、引用或同步关系，代码中也不存在 Attention 实体。

**待确认**

Attention 是一个独立且持久的领域概念、Artifact 的自然语言说明，还是泛指用户当前目标？如果后两者已经足够，就不应继续用“共享 Attention”暗示不存在的身份关系。

> 用户批注：Attention 是抽象的概念, 这个概念目前其实不是很必要. Attention代表的是用户关系的内容, 它对应的实体是artifact目录中的任务说明文档. 目前文档中可以弱化 Attention 概念.

### TERM-02（P1）：Projection 的边界过宽

**已验证事实**

当前文档把搜索结果、局部引用图、Context Packet、Artifact 初始化和 Artifact 修订都称为 Projection。前三者是可重建读模型，后两者会修改正式领域文件。

**待确认**

Projection 是否真的需要作为核心名词？如果它只是“从正式事实派生活动或输出”的统称，可能不足以区分读模型、上下文装配和领域写入，反而增加概念数量。

> 用户批注：Projection不需要作为核心名词. 可以弱化这个概念.

### TERM-03（P0）：知识“可核查出处”的承诺没有落到正式 Knowledge 模型

**已验证事实**

- Product Brief 将“可核查出处”列为核心价值，ADR 也要求正式 Knowledge 可追溯。
- `KnowledgeStatement` 只有 `title` 和 `content`，没有 source/provenance。
- Reviewer 被 Prompt 明确要求不读取 `inputs/`，只检查候选内容是否自足和一致，因此审批并不验证来源正确性。

**待确认**

可追溯是 MVP 核心承诺，还是未来治理方向？如果是核心承诺，为何当前允许 Statement 与 Source Snapshot 的关系在加工完成后丢失？Reviewer 的 source-blind 是为了角色独立性、控制上下文，还是刻意只做内容质量检查？

> 用户批注：可追溯确实是 MVP 核心承诺, 不过目前确实还没有实现这个能力, 关于具体如何实现我还没有考虑清楚, 具体方案后续待定.

### TERM-04（P1）：Source Snapshot 的“精确版本”与两种指纹语义不一致

**已验证事实**

- 术语把 Source Snapshot 定义为 `sourceConversationId + sourceRevision` 标识的精确不可变版本。
- Discovery 的 `sourceRevision` 由 sourceId/externalId/size/mtime 计算；真正读取内容后，字节 SHA-256 另成为 `sourceRef`。
- 同大小且 mtime 被保留的内容变化，理论上不会被 selection revision 检出。

**待确认**

元数据指纹为什么足以称为“精确不可变版本”？`sourceRevision` 是否更适合称为 catalog revision/selection hint，而 `sourceRef` 才是已读取内容的精确身份？

> 用户批注：这个是之前agent开发时自己定义的设计, 可能已经不适用了, 你需要重新设计合理的方案. 元数据指纹的概念可能有些定义的不合适, 可以考虑移除, 换为更简洁容易理解的设计.

### TERM-05（P1）：Knowledge Statement 和 Artifact 都缺少稳定身份解释

**已验证事实**

- Statement path 被定义为 locator，canonical title 又可修改，模型没有稳定 ID。
- Artifact 声称具有独立身份和生命周期，但当前身份实际上只是 `artifacts/` 下的一级目录路径；移动或改名后连续性会丢失。

**待确认**

当前是否刻意接受“内容身份由当前名字表达”，并依赖 Git 历史回溯重命名？标题/目录重命名、大小写、Unicode 规范化和 `[[...]]` 引用迁移由谁负责？在没有真实跨设备/长期引用需求前，也不应为了稳定 ID 预先引入 manifest。

> 用户批注：“内容身份由当前名字表达”确实是设计原则. 标题/目录重命名、大小写、Unicode 规范化和 `[[...]]` 引用迁移作为后续的治理能力是需要实现的, 但是目前还没有确定的方案.

### TERM-06（P1）：`AGENTS.md` 同时承担三种职责

**已验证事实**

Artifact 根 `AGENTS.md` 同时被描述为 Artifact 说明、持久 Attention 载体和 Agent 维护契约；Pi Coding Agent 又会把同名文件视作上下文/指令约定。

**待确认**

选择 `AGENTS.md` 是为了复用 Coding Agent 生态约定，还是希望它只是一份面向用户的说明？当文件来自不可信 Artifact 或包含与 Host Prompt 冲突的指令时，信任优先级是什么？

> 用户批注：选择 `AGENTS.md` 确实是为了复用 Coding Agent 生态约定. AGENTS.md是关于如何维护这个artifact的权威说明.  Host Prompt的信任优先级更高. 不过, 目前不需要考虑两者冲突的问题, 这些治理层面的细节问题在MVP阶段不需要关心.

### TERM-07（P1）：Task 的 `completed` 与 promotion/用户接受关系未定义

**已验证事实**

- Reviewer 批准后 Task 立即成为 `completed`，但候选 branch 不 merge 到 `main`。
- Knowledge 浏览器仍读取主 checkout。
- 当前没有 promote、resume 或 abandon API/UI；页面仍以“加工测试”为主要定位。
- 架构文档却已经为未来 promotion 写了 merge 最新 main、重新 Review 和 fast-forward 的确定流程，现有状态模型无法执行它。

**待确认**

`completed` 表示自动加工链路完成、Reviewer 认为合格，还是业务内容已被用户接受？Knowledge Processing 是正式产品工作流，还是验证 Harness？未来 promotion 是同一 Task 的阶段、新 Task，还是用户的普通 Git 操作？

> 用户批注：后续确实应该让Reviewer来负责merge等操作, 只不过目前未实现. 未来 promotion 是task的一部分. 合并之后才算完成. 这个功能是近期需要实现的, 你需要按照这个实现代码并更新文档.

### TERM-08（P2）：Debug Store 与“日志不记录正文”的数据分类不清

**已验证事实**

Product Brief 一处说明 Debug Store 保存完整 Context 和 Provider payload，另一处又把“不在日志中记录聊天正文或 Prompt”列为底线。

**待确认**

“日志”和“Debug Store”是否是两类明确不同的数据？需要定义它们的可见性、敏感性、保留期和删除行为，避免读者把两段话理解为自相矛盾。

> 用户批注：它们不是不同的数据, 并且我希望后续使用统一的模块来管理这些debug信息.

### TERM-09（P2）：应用语言与 Agent 输出语言被耦合

**已验证事实**

同一个应用语言设置同时决定 UI 文案和 Agent 回复/Repository 内容语言。文档只记录了行为，没有说明两种偏好为何必须一致。

**待确认**

这是当前最小体验取舍，还是产品上希望知识内容永远跟随 UI 语言？已有 Conversation 或 Artifact 在切换语言后应保持原语言还是迁移？

> 用户批注：这个是之前考虑的不周全.我希望可以支持分别设置  UI 语言 和Agent 回复/Repository 内容语言. 需要实现这个能力.

### TERM-10（P1）：Observation、Source 与 Task 到底是“领域”还是过程记录

**已验证事实**

- ADR-0001 把 Observation、Knowledge、Artifact 称为三个状态与权威域。
- `knowledge-model-and-projection.md` 又把 Knowledge Processing Task 加入“四类事实”；Product Brief 有时说三个域，有时把 Task 放进“状态与权威域”表格。
- 代码中的 `AgentObservation` 是 Raw Evidence 与 Canonical Activity 的组合，但文档中的 Observation 有时表示一层事实、有时表示对象或文件化输入。
- Discovery 会发现并统计人类指令，但当前 Source Conversation catalog 和结构化加工入口主要暴露 conversation；人类指令是否只是来源能力元数据并不清楚。

**待确认**

Observation、Knowledge、Artifact 是否是三个权威事实域，而 Task 只是版本化过程记录？Source Record、Source Conversation、Source Snapshot、Raw Evidence、Canonical Activity 和 AgentObservation 的最小关系是什么？人类指令是否应成为可选加工来源？

> 用户批注：人类指令可成为可选加工来源. 目前这些概念定义的有些太多了, 很多概念并不是我提出的, 而是之前agent开发时自由发挥的, 应该缩减这些概念. Observation、Knowledge、Artifact是重要的概念, 但它们并不算是权威事实域, 只不过是三种信息的形态.

## 5. 代码暴露出的架构味道与未定义边界

### ARCH-01（P0）：Reviewer 的文本 marker 协议与任意 Artifact 内容冲突

**已验证事实**

- Artifact 被定义为可包含代码、图片、二进制和完整工程的任意内容。
- Reviewer checkpoint 遍历候选 revision 中整个 `knowledge/` 和 `artifacts/` 树，对每个文件执行 `git show` 并搜索文本 REVIEW marker。
- Git 子进程输出上限为 16 MiB。

**风险推断**

一个与 Review 无关的大文件或二进制 Artifact 就可能让 Knowledge Task 失败；文本 marker 协议也被意外扩展成所有 Artifact 的内容约束。

**待确认**

Review 反馈是否应只存在于 Host 拥有的 `PROGRESS.md`，或至少只扫描明确的文本候选？当前“全树无 marker 即批准”的自然语言协议为什么足够可靠？

> 用户批注：Reviewer不应该仅存在于 PROGRESS.md . 我的思路是, 信任Reviewer能在合理的位置插入marker. 它应该避免在二进制文件中增加marker. 原则是: 文档型内容原地插入marker, 其他内容或者是没有合适的文档的情况, 则在统一的地方(如 PROGRESS.md)插入marker. 注意, 本项目的设计的核心原则(不仅限于这个问题)是, 信任agent维护整个git 仓库的能力, 不要定义太多的治理规则, 让设计尽量保存简洁. 太多的治理规则反而会很快成为技术债.

### ARCH-02（P0）：Reviewer approval 是“没有反对信号”，不是显式决策

**已验证事实**

Reviewer 正常结束后，Host 只检查未完成 checkbox 和 REVIEW marker；两者都没有即视为批准。若模型忘记写反馈但正常结束，也会批准。

**待确认**

这是刻意采用的最小自然语言协议，还是应保留一个明确但不必新增领域实体的 approval 证据？Reviewer 的独立性只是模型行为目标，还是安全/证据保证？目前它拥有完整文件和 shell 工具，source-blind 也只是 Prompt 约定。

> 用户批注：这是刻意采用的最小自然语言协议. 后续可以考虑让Host增加更多的校验能力, 但目前不需要做这件事. 此外, Host这个名词其实不太合适, 改为 Agent Runtime或者harness可能更合适.

### ARCH-03（P0）：Debug Store 的凭据与 Header 保证不成立

**已验证事实**

- `agent-runtime.md:86` 和 UI 声称不会保存凭据，敏感请求 Header 会脱敏。
- 请求 Header 只匹配一组精确名称；Response Header 被原样写入 Debug Record，可能包含 `set-cookie` 或 Provider 自定义 token Header。
- Recorder 捕获的请求 Header 还是进入 stream wrapper 时的视图，API key 可能在之后加入，因此也不一定是“最终实际请求 Header”。

**风险推断**

当前文档和 UI 对用户给出了强于实现的安全保证。

**待确认**

Debug Record 是否需要保存任意响应 Header？“最终请求”应定义为哪一个观察边界？这项问题应作为安全修复独立处理，而不只是修改文案。

> 用户批注：这个问题你可以自行处理. 总体原则是, 不需要附加太多的安全保证, 尽量参考成熟的方案, 保证代码简洁即可. 当前MVP阶段中, 架构的简洁和可维护 > 安全保证.

### ARCH-04（P1）：删除 Conversation 不删除它拥有的完整执行数据

**已验证事实**

- Chat 子 Agent 使用独立持久 Pi Session。
- 删除 Conversation 只删除 descriptor 和根 Session 文件。
- Agent Debug Store 没有删除 API，子 Session 与根/子 Invocation 的 Debug Record 会成为 UI 不可达的孤儿数据。

**待确认**

“删除对话”是只删除产品入口，还是删除其拥有的全部本地执行数据？同样需要定义 Task、Preview、Source 解除和 Debug 数据的所有权与 retention。

> 用户批注：目前其实不需要 “删除对话” 能力. 这些逻辑有些复杂了, 你可以进行简化. 产品其实不需要实现“删除对话” 能力

### ARCH-05（P1）：Preview 和失败 Task 的资源生命周期不完整

**已验证事实**

- Agent Preview 虽然“不进入 Task 历史”，仍会创建永久 `preview/<id>` branch、linked worktree、输入、commit 和 Pi Session。
- 当前没有 remove/prune preview branch、worktree、runtime 的路径。
- 开放 Task 失败时，已完成的 Collaboration Round 只留在 Git/PROGRESS/Invocation 中，不进入结构化 `rounds`；API 也不能继续或放弃 Task。

**待确认**

Preview 是可丢弃临时执行还是持久实验？“open 可恢复”当前是否只表示保留了恢复所需的物理材料，而非产品已经支持恢复？

> 用户批注：Preview 当前的定义是可丢弃临时执行. 后续应该实现清理的逻辑. 不过目前我不希望为此设计太多的规则, 因为加工测试只是临时的debug能力, 我倾向于当前阶段让由用户主动触发对话agent清理这些临时内容即可, 不需要做额外的太多设计.

### ARCH-06（P1）：Task 接受、退出和崩溃恢复不是完整事务

**已验证事实**

- Task 创建先建立 branch/worktree，再逐个写文件和 start commit；中间失败没有 rollback，可能留下历史 UI 不可见的物理孤儿。
- 应用 `before-quit` 只触发 abort/dispose，不等待 checkpoint。
- 未发现启动时将持久 `in_progress` Invocation 调和为 interrupted/failed 的逻辑。

**待确认**

文档中的“失败恢复”只承诺受控执行异常，还是包含正常退出、主进程崩溃和创建中断？若物理孤儿不构成业务 Task，也应说明清理和启动修复策略。

> 用户批注：“失败恢复”应该包含各种异常情况. 但是这个留作之后待实现的内容即可, 当前阶段无需过度关注失败恢复

### ARCH-07（P1）：通用文件浏览器的信任和单次 I/O 边界过宽

**已验证事实**

- Renderer 可向 IPC 提交任意绝对路径；Markdown 相对链接可以用 `../` 跳出最初浏览根。
- Main 只检查绝对路径和普通文件，没有基于一次浏览会话限制根目录。
- 目录树递归一次性构建；文件完整读入并通过 IPC 传输；打开目录后自动读取第一文件；没有文件大小、目录深度或条目数边界。
- 文档明确说当前没有 allowlist/Sandbox，但没有给出 threat model 和规模假设。

**风险推断**

大型目录或大文件可能阻塞主进程或占满 IPC/Renderer；未来 Artifact `index.html` 静态交互视图绝不能继承这组受信 Renderer 能力。

**待确认**

当前是否以“整个 Renderer 与本机用户等价受信”为前提？文件浏览器的最小单次 I/O 边界是什么？这是 I/O 完整性边界，不等同于限制 Agent 正常探索的行为配额。

> 用户批注：保留这个设计即可, 当前的设计以简洁为主, 不要增加过多的治理逻辑.

### ARCH-08（P1）：Knowledge、Artifact 和 Source Evidence 都缺少明确规模假设

**已验证事实**

- FileKnowledgeStore 每次 browse/read/neighborhood 都同步递归扫描并解析整个 `knowledge/**/*.md`；一个坏文件或重复标题会让整个视图失败。
- 声明的 `MAX_KNOWLEDGE_STATEMENT_CONTENT_LENGTH` 没有被使用。
- Artifact 列表每次完整读取所有根 `AGENTS.md`，没有大小限制。
- Knowledge Processing 读取 Source Evidence 时没有传 `maxBytes`，会完整分配、UTF-8 decode 并生成 Canonical Activity。

**待确认**

这些是明确的 bootstrap 取舍，还是遗漏？当前预期的 Statement 数、Artifact 数、单文件和 transcript 规模是什么？何种实测信号才触发索引、异步读取或错误隔离？

> 用户批注：这是早期的取舍. 可以保留这个逻辑. 

### ARCH-09（P1）：Pi Extension 的权限与产品身份需要解释

**已验证事实**

Pi Extension 在 Electron 主进程中以当前 OS 用户完整权限运行；Chat 和 Knowledge Agent 拥有普通文件及 shell 工具，没有路径 Sandbox 或逐次审批。

**待确认**

这使 Oyster 在执行时更接近 Agent Harness。产品仍定位为 Agent-agnostic Knowledge Hub 的理由是什么：agnostic 指输入来源、知识格式，还是执行 Runtime 可替换？安全承诺应基于什么信任假设？

> 用户批注：当前阶段无需过度关注安全治理.

### ARCH-10（P1）：Skill 识别使用过于通用的隐式标记

**已验证事实**

任何 Artifact 根出现名为 `output` 的文件系统项，都会被 Skills 页面识别为 Skill Artifact 或无效 Skill，即使普通产物自然使用了同名目录。

**待确认**

为什么 `output` 足以证明 Skill intent？是否有真实场景支撑该约定，还是当前为了避免 manifest 的最小捷径？这里不必立即增加类型或 manifest，但需要记录碰撞风险和判断依据。

> 用户批注：`output` 确实不足以证明 Skill intent . 这个设计不合理. 我希望使用其他基于文件系统的简洁的方式来声明artifact是skill.

### ARCH-11（P2）：外部项目 Skill 发现耦合历史 Conversation catalog

**已验证事实**

项目级 Skill 的候选路径来自 Source Conversation catalog 的 `projectPath`，因此用户必须先发现历史对话，Skills 页面才能知道某些外部项目。

**待确认**

这是临时复用已有路径来源，还是长期设计？若未来不引入 Oyster Project，项目路径还应由什么稳定入口提供？

> 用户批注：这是临时复用, 后续需要设计更合理的探测发现方式.

### ARCH-12（P2）：Codex Backend 保留了第二套未使用的执行抽象

**已验证事实**

当前 AiBackendService 只用 Codex Adapter 发现本机账号，但 `AgentBackendAdapter` 和 `CodexAgentAdapter` 仍携带登录与 `codex exec` 任务执行能力；Service 从不调用，测试仍维护它们。

**风险推断**

这看起来像上一代“Codex Runtime 作为执行 Backend”的遗留，会与当前 Pi OAuth Coding Plan 形成两套认证/执行心智。

**待确认**

这套执行能力是否有确定的未来用途？若没有，建议收窄成 Codex Account Discovery，并补充为何依赖 `@earendil-works/pi-*` fork、由谁维护和如何升级。

> 用户批注：未来没有确定的用途, 可以清理.

### ARCH-13（P2）：并发能力、取消语义和单写入者边界没有对齐

**已验证事实**

- 底层支持多个 Task 使用独立 worktree 并发。
- 当前 cancel API 不带 `taskId`，会取消所有活动 Task。
- `agent-runtime.md` 一处说 Runtime 不理解 Task/Git，另一处又把每-worktree单写入者门禁归为 Runtime；代码实际在 Knowledge Processing 业务服务中实现。
- Chat 的单 Conversation 门禁在终态 envelope 完成持久化前释放，存在很小的并发窗口。

**待确认**

多 Task 并发是明确产品需求，还是基础设施自然支持但 UI 暂未承诺？取消是全局紧急停止还是单 Task 操作？单写入者约束应属于 Host/业务编排，而不是 Runtime。

> 用户批注：多 Task 并发是明确产品需求. 取消暂时认为是全局紧急停止即可, 后续会设计更精细的管理方案. 单写入者无需过度约束, 信任agent即可.

### ARCH-14（P2）：Task 记录包含本机绝对路径

**已验证事实**

Invocation envelope 原样保存 Pi `sessionFile`，Knowledge Task 的 `task.json` 又被 Git 跟踪；该路径很可能包含本机 worktree 绝对位置。Chat descriptor 则会把根 Session 路径正规化为相对路径。

**待确认**

Task branch 是否只保证当前单机可审计？如果 Repository 未来会迁移、同步或被用户用 Git 检查，绝对路径不应成为可移植的正式引用。

> 用户批注：debug信息不需要git追踪, 但是 `task.json`是任务信息, 被git追踪是合理的. Task branch 保证当前单机可审计即可, 暂时不需要考虑迁移或同步的情况.

### ARCH-15（P2）：Debug Store 的同步全量重写可能形成写放大

**已验证事实**

Debug Store 在 Electron 主进程同步、原子地重写整份 JSON；Recorder 在工具 partial update、Provider callback 等多个活动边界都会保存。

**风险推断**

大 Context/Tool Result 下可能产生 O(n²) 写放大并阻塞主进程。目前没有真实数据证明必须优化，按照项目原则不应预先引入复杂存储，但应把它记录为需要测量的 bootstrap 取舍。

> 用户批注：合理.

### ARCH-16（P2）：工作台的“更新于”不是 Artifact 更新时间

**已验证事实**

工作台卡片显示的 `modifiedAt` 只是根 `AGENTS.md` 的 mtime；Artifact 内其他文件变化不会更新它。UI 却标成整个 Artifact 的“更新于”。

**建议方向**

若不计算整个目录的更新时间，应把文案改成“说明更新于”，并在需要前不要引入新的 Artifact metadata。

> 用户批注：更新文案

### ARCH-17（P2）：UI 基础文档与共享层实际能力发生漂移

**已验证事实**

- `ui-foundation.md` 要求 Inspector 内部导航提供返回，但 Chat Knowledge Inspector 只替换标题，没有历史。
- 文档要求共享 Tab、Inspector 和 page styles 优先进入共享层；当前共享层只导出 Button、Icon、Markdown，至少三套 Inspector 各自实现。
- 文档要求 Overlay 使用统一阴影，代码仍有多套硬编码阴影。

**风险推断**

这类问题不需要成为领域架构，但说明 UI Foundation 同时扮演设计原则和精确实现验收表，已经开始与代码分叉。

> 用户批注：应该按照UI Foundation 为准, 避免UI实现发生漂移

## 6. 文档组织和内容密度问题

### DOC-01（P0）：缺少文档入口、阅读顺序和状态定义

`docs/` 没有 `README.md` 或 index。应用内直接打开整个 `docs/` 目录，Research、历史 ADR、当前规范和 MVP 实现说明处于同一可见层级。`README.md:108` 和 Product Brief 手工列出部分文档，但 `ui-foundation.md`、`knowledge-local-graph-mvp.md` 等没有任何入链。

> 用户批注：确实应该优化文档的结构

### DOC-02（P1）：文档重复的是“事实清单”，而不是设计理由

Artifact 的目录规则、`AGENTS.md`、Attention、无 Project 和 Chat 创建方式，在 README、Product Brief、Architecture、Artifact MVP 和 ADR-0001 中重复。Skills 四对象、`output/` 与 symlink 规则也在三份文档中重写。只要其中一份更新不完整，就产生冲突。

> 用户批注：文档确实应该记录设计理由, 不应该啰嗦的罗列事实清单.

### DOC-03（P1）：ADR-0001 已失去历史决策记录的形态

ADR-0001 被原地修订二十余次，同时又声明部分内容被 ADR-0002 取代。它现在既像历史决策、当前领域总览，也保留 Project 等旧开放项。ADR 若持续随实现重写，就无法回答“当时为什么做出这个选择”。

> 用户批注：可考虑删除陈旧的内容

### DOC-04（P1）：大量实现常量不应由设计文档重复拥有

以下内容尤其容易随代码分叉：

- `knowledge-local-graph-mvp.md` 的力导向算法、像素、字号、曲线路由和 ResizeObserver 行为；
- `ui-foundation.md` 的 CSS 文件名、精确 px/weight、lint 和测试窗口尺寸；
- Skill 文档的 Agent 路径矩阵、64 KiB/2 MiB、UI 字段、逐项绑定步骤和测试清单；
- Discovery 文档的 96 KiB、JSON 持久化细节和当前兼容矩阵；
- AI、Runtime 文档的 SDK 调用细节、重试次数、formatVersion 和精确存储路径。

只有当某个数值构成用户承诺、安全/I/O 边界或跨模块稳定契约时，才应留在设计文档；否则代码和测试更适合拥有它。

> 用户批注：这些常量不应该定义在文档中, 而是应该在代码中维护. 文档应该维护的是高抽象维度的内容例如设计理由, 至于具体的实现, 文档中仅说明以哪些代码为准即可

### DOC-05（P1）：文档状态词过多且没有统一语义

当前存在“当前产品定位 source of truth”“权威架构词汇表”“当前架构”“当前实现”“当前实现规格”“当前纵向实现规格”“Accepted”等标签。日期也被当作新鲜度信号，但 README 的漂移说明日期和人工状态不足以建立代码同步机制。

> 用户批注：这些不合理, 应该修复这些文档漂移的问题.

## 7. 现有文档逐份建议去向

本节只建议后续整理方向，不在本轮执行。

| 文档 | 当前主要价值 | 主要问题 | 建议去向 |
| --- | --- | --- | --- |
| `README.md` | 项目入口、开发命令 | 大段运行模型已陈旧 | 重写为短入口；链接设计索引，不拥有架构细节 |
| `architecture/terminology.md` | 身份、生命周期、字段语言 | Attention/Knowledge/Artifact 等核心领域不完整；与代码字段冲突 | 收敛为唯一 Glossary/Domain Model，定义概念而非存储实现 |
| `architecture/knowledge-model-and-projection.md` | Knowledge、Artifact、Task 的边界 | 与术语表和 Product Brief 重复；Projection/Attention 不清 | 与术语表合并或明确分工；保留“为什么分层” |
| `architecture/unified-git-agent-collaboration.md` | Git 协作不变量和 worktree 理由 | 混入尚未可执行的 promotion 方案和当前状态清单 | 保留核心取舍、可见性和失败语义；候选 promotion 明确标注待验证 |
| `architecture/agent-runtime.md` | Runtime/领域边界、Session/Debug 区分 | 混入具体资源策略、存储和错误承诺；职责归属有冲突 | 收敛为 Runtime 与信任边界；实现细节交给代码 |
| `decisions/0001-agent-agnostic-knowledge-hub.md` | 产品转向的历史理由 | 被长期原地改写，残留旧开放项 | 冻结为历史 ADR，注明被哪些后续决定修订；新决定新增 ADR |
| `decisions/0002-unified-git-agent-collaboration.md` | worktree 决策理由 | 与当前 Architecture 重复较少 | 冻结；Architecture 只引用，不复制决策历史 |
| `product/product-brief.md` | 用户问题、产品身份、长期承诺 | 327 行，混合当前/目标/实现/安全/路线图 | 大幅精简，只保留 why、用户、承诺、边界、阶段和非目标 |
| `product/ai-backends-mvp.md` | Provider/Connection/Model 区分较清楚 | 后半段深入 SDK、重试和 payload | 保留用户模型与不回退理由；运行细节移出设计规范 |
| `product/artifact-repository-mvp.md` | 简短，候选 `index.html` 明确非确定性 | 领域定义与 Architecture 重复 | 核心定义归 Domain Model；仅保留待验证候选方向或并入产品路线 |
| `product/chat-agent-mvp.md` | 解释通用管理 Agent 的最小能力 | 主要是当前工具、cwd 和实现状态 | 将稳定理由并入 Product/Runtime；其余作为实现说明归档或删除 |
| `product/folder-browser-mvp.md` | 解释为何复用通用浏览器 | 以能力清单和 IPC 边界为主，缺 threat model/规模 | 保留用户目标和信任边界；精确行为由代码测试拥有 |
| `product/knowledge-local-graph-mvp.md` | 局部图交互的实现记录 | 几乎逐句复述算法和视觉常量 | 从设计规范移出；保留一句产品理由，细节由代码/测试拥有 |
| `product/knowledge-processing-mvp.md` | 当前纵向链路的集中说明 | 与 Architecture/ADR 重复；“验证”与正式产品语义混合 | 先确认 Task 的产品地位；稳定协作约束并入 Architecture |
| `product/local-agent-discovery-mvp.md` | 外部所有权、identity != locator、按需读取理由 | Canonical 状态陈旧；大量兼容与实现常量 | 提炼为 Observation Access 设计；兼容矩阵移到实现文档或测试 |
| `product/skill-discovery-mvp.md` | 外部注册事实与管理对象分离 | 路径、格式、UI 和安全检查过细 | 与注入文档合并为 Skill 产品设计，只保留对象边界和理由 |
| `product/skill-symlink-injection-mvp.md` | symlink、外部所有权和可撤销性理由 | 与 Brief/Discovery 重复；scope/output 表述偏差 | 与上一份合并；实现矩阵和字节常量由代码拥有 |
| `product/ui-foundation.md` | 导航层级、渐进披露、滚动和详情交互原则 | 后半混入精确 CSS 与测试规则并已漂移 | 保留稳定交互原则；tokens/lint/test 直接约束实现 |
| `research/agent-invocation-history-persistence.md` | 当时的外部证据与取舍 | 又复述当前持久化结论，易被误当规范 | 标为历史 Research，只保留证据和当时结论；当前规则引用 Architecture |
| `research/agent-skill-discovery-and-format.md` | 多 Agent 官方资料和兼容证据 | 与 Product Skill 文档有少量重复 | 保留为非规范性 Research，标明检索日期和适用版本 |

> 用户批注：

## 8. 建议的新信息架构

建议先建立规则，再移动内容。目标不是增加更多文档，而是让每条设计事实只有一个权威位置。

```text
docs/
├── README.md                         # 阅读顺序、状态和权威层级
├── product/
│   └── product-brief.md              # 用户问题、承诺、边界、当前阶段
├── architecture/
│   ├── domain-model.md               # 唯一术语、身份、关系和生命周期
│   ├── repository-collaboration.md   # Git 事实、可见性、并发和 promotion 边界
│   ├── observation-access.md         # 外部来源、Snapshot、出处与物化边界
│   └── agent-runtime-and-trust.md    # Runtime、权限、Session、Debug 和数据保留
├── decisions/                        # 不可变 ADR；新决定新建文件
└── research/                         # 非规范证据与历史研究
```

建议的权威规则：

1. Product Brief 拥有“为什么做、为谁做、承诺什么、不做什么”，不拥有当前模块清单；
2. Domain Model 拥有领域名词、身份、关系和生命周期；其他文档只链接，不重新定义；
3. Architecture 拥有跨模块不变量、信任边界和关键取舍，不复述 UI 字段、路径矩阵或代码常量；
4. ADR 记录“当时为什么选择”，接受后不随实现持续改写；新方向用新 ADR 取代或修订；
5. Research 只提供证据和历史，不参与当前规范冲突裁决；
6. 代码和测试拥有精确实现、协议字段、像素、重试数和兼容矩阵；只有构成稳定外部契约的常量才上升到设计文档；
7. 当前功能状态放 README 的短摘要或 Release Notes，不再混入设计权威文档。

> 用户批注：

## 9. 建议的确认顺序

后续不建议从逐句润色开始。以下顺序可以减少反复修改：

1. **DOC-AUTH**：确认第 8 节的文档层级和 ADR 是否保持不可变；
2. **PRODUCT-STAGE**：确认 Product Brief 的阶段含义，以及 Knowledge Processing 是验证 Harness 还是正式产品工作流；
3. **REPOSITORY-TRUTH**：确认主 working tree、committed `main`、Task branch、`completed` 和 promotion 的关系；
4. **DOMAIN-MINIMUM**：确认 Attention、Projection、Knowledge/Artifact 身份是否有必要作为当前核心概念，并彻底删除 Project 开放项；
5. **PROVENANCE**：确认“可核查出处”的承诺、Source Snapshot 两种 revision 和 Reviewer source-blind 的理由；
6. **TRUST-RETENTION**：确认 Agent 权限、通用文件读取、Debug 数据、Conversation/Task/Preview 删除与保留策略；
7. **IMPLEMENTATION-OWNERSHIP**：确认哪些 UI 和兼容性常量属于稳定产品契约，其余从设计文档移出；
8. 最后再按确认结果精简和重写现有文档，并同步修复已确认的代码/文案偏差。

## 10. 本轮不应直接做出的决定

- 不因为 Statement/Artifact 身份不稳定就立即增加数据库 ID 或 manifest；先确认真实生命周期需求。
- 不因为当前扫描和 Debug Store 可能有规模问题就预先引入复杂索引、配额或新存储；先定义单次 I/O 边界并测量。
- 不把候选 `index.html` 交互视图写成已确定方案；它仍只是需要隔离设计和用户场景验证的方向。
- 不把本文列出的所有文档偏差都自动解释为代码缺陷；有些代码可能正确地代表最新方向，有些文档可能描述尚未实现的目标，关键是先明确状态。
- 不在批注确认前大范围重写现有设计文档，以免替用户决定尚未清楚的产品和架构问题。
