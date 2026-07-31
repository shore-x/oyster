# ADR-0001：将 Oyster 定位为 Agent-Agnostic Knowledge Hub

- 状态：Accepted
- 日期：2026-07-22
- 修订：2026-07-24，明确预处理、知识维护 Agent、共享 Attention 与投影的边界
- 修订：2026-07-26，明确 Observation Preprocessor、Knowledge Maintenance Agent、Knowledge Contribution 与 Knowledge Statement 的定义
- 修订：2026-07-26，明确本地外部 Agent 历史原地按需读取，不复制到 Oyster
- 修订：2026-07-27，明确 Knowledge Maintenance Agent 使用通用 Agent Runtime，不由固定轮次、工具次数或总时长定义
- 修订：2026-07-28，明确 Statement 是领域语义的 Source of Truth，多元关系由自由文本正文中的显式 Statement 名称引用表达
- 修订：2026-07-28，确定正文采用读取时动态解析的 canonical title 引用；Statement 生命周期与追溯方式留给治理设计
- 修订：2026-07-28，明确候选发现、开放调查与知识裁决的边界
- 修订：2026-07-29，明确 canonical title 只指称知识主体，语境、属性和关系由正文表达
- 修订：2026-07-29，明确 Observation、Knowledge 与第三类协作产物状态是三个状态与权威域，Projection 是形成消费输出或维护协作产物的活动；英文命名留待后续修订
- 修订：2026-07-30，正式采用 Artifact Domain / Artifact；无限定词 Artifact 专指第三个权威域，观察侧产物使用 Activity Artifact，Discovery 来源记录使用 Source Record
- 修订：2026-07-30，确定 Artifact Repository MVP：固定本地 Git Repository、一级目录 Artifact、根 `AGENTS.md` 持久 Attention 和文件系统直读；维护 Agent 与自动 Git 工作流延后
- 修订：2026-07-30，确定 Git Runtime 边界：随 APP 捆绑私有标准 Git，内部按绝对路径调用；未来仅向 Oyster 管理的 Agent Shell 注入标准 `git` CLI，不依赖系统 Git 或引入专用 Git Tool
- 修订：2026-07-31，将现有对话 Agent 扩展为单一通用管理 Agent：所有 Session 常驻 Knowledge 与 Coding 工具，不绑定 Artifact、Project 或 `cwd`，由 Agent 自主发现相关 Artifact
- 修订：2026-07-31，确定通用 Agent 的高信任 MVP：Coding 工具从固定 Artifact Repository 根开始，但不设置路径边界、Shell Sandbox、逐次审批、selector/router/lock；System Prompt 只提供必要环境事实
- 关联文档：[Product Brief](../product/product-brief.md)、[本地 Agent 发现与外部证据访问](../product/local-agent-discovery-mvp.md)、[AI Backend MVP](../product/ai-backends-mvp.md)、[知识加工验证 MVP](../product/knowledge-processing-mvp.md)、[Artifact Repository MVP](../product/artifact-repository-mvp.md)、[知识加工、Projection 与 Artifact](../architecture/knowledge-model-and-projection.md)

## Context

旧项目从 AI 浏览器起步，新仓库交接时已转向 Context Workbench。进一步分析发现，最稳定且跨产品的用户问题不是缺少新的浏览器或 Agent Harness，而是 Claude Code、Pi、Codex 等工具把活动和知识分别保存在不同会话、项目与私有格式中。

用户需要一个独立系统来发现和利用历史、持续接入新活动、保留出处、构建知识，并把经过 Scope 控制的结果重新提供给多个 Agent。若 Oyster 同时把浏览器、Agent 执行和知识中心都作为 MVP 主轴，产品价值与工程边界会再次发散。

## Decision

Oyster 的主要产品身份是：本地优先、跨 Agent、跨项目的知识库维护中心。

系统保留三个相互区分的状态与权威域：

1. 观察层：Raw Evidence 以来源和版本身份引用 Harness 原始 transcript 与人类指令，并由 Source Adapter 在原始位置按需读取；Canonical Activity 确定性标准化 Session、Turn、Message、Tool 和 Activity Artifact 等活动；
2. 知识层：受控 Knowledge Maintenance Agent、经授权的知识生产 Pipeline 和用户从观察或已有知识形成可引用、可修订的 Knowledge Statement；Statement 以语义丰富的自然语言正文及其中对 canonical title 的显式引用表达对象、概念与任意多元关系，不建立独立的领域 Relation 实体；
3. Artifact Domain（协作产物域）：保存用户与 Agent 围绕 Attention 持续维护的 Artifact。Artifact 具有独立身份、当前状态和修订生命周期，不限定为 Markdown 或单一文件，可以是文档、配置、模板、代码、脚本、资产或它们的组合，并接纳用户编辑。

Projection 是从知识、Attention 和必要的当前状态形成可消费输出的活动，而不是第三个持久状态域本身。它可以形成按需消费输出，也可以初始化 Artifact，或基于当前 Artifact 形成下一次修订。Context Packet 是当前临时消费输出的候选形式，其与持久 Artifact 之间的转换关系不由本 ADR 决定。

三个域保持不同的数据所有权，但知识加工、Projection 和 Artifact 维护通过共享 Attention 耦合。Observation Preprocessor 负责从有界观察中发现带回源线索的待调查问题，而不生成 Session 摘要或提前决定 Knowledge Statement。候选进入一次运行的开放调查清单；Knowledge Maintenance Agent 依据当前知识和 Raw Evidence 补充并裁决这些问题，再独立形成 Contribution Draft。开放清单与 Contribution Draft 是可丢弃的运行期工作材料（Run-local Working Material），不是第四个状态域。候选不是事实或 Statement，也不与最终 Statement 一一对应。Oyster Core 统一执行该知识加工 Pipeline 的 Workspace 与提交边界。无论知识由 Agent、Pipeline 还是用户产生，都进入同一个知识层，不按处理器或 Artifact 建立不同的真相存储。

Attention 可以让 Artifact 自然形成分组，但是否正式引入 Project，以及这种分组的身份和生命周期，仍是未决定事项。任何 Artifact 分组都不得把共享知识划分为彼此隔离的真相。

当前 Artifact Repository MVP 使用 Oyster 管理的固定本地目录 `app.getPath('userData')/artifacts/`，并将其初始化为一个标准 Git Repository。Repository 中每个带有可读取的普通根 `AGENTS.md` 的一级目录是一个 Artifact；`AGENTS.md` 以无固定 Schema 的 Markdown 表达该 Artifact 的持久 Attention，其余内部结构任意。APP 直接扫描文件系统，使用一级目录的 Repository 相对路径作为当前身份，不建立 manifest、稳定 `artifactId`、Artifact 类型或数据库镜像。缺少或无法读取根 `AGENTS.md` 的可见一级目录不是 Artifact，并在 UI 中明确显示为无效目录。初始化失败只影响 Artifact 功能并可重试，不阻止 APP 的其他功能启动。

Git 在这一 MVP 中只是文件历史基础。Oyster 随 APP 捆绑并始终使用私有的标准 Git Runtime；APP 发起 Git 操作时直接调用包内 Git 可执行文件的绝对路径，不通过进程 `PATH` 查找，也不以系统 Git 作为前置条件。私有 Runtime 仍产生可由普通 Git CLI 读取的标准 Repository，不形成 Oyster 专有格式或 Git 方言。

APP 自身不自动 commit，不创建 branch 或 worktree，也不实现 diff 审核、merge 或冲突处理。当前通用管理 Agent 可以在普通对话中完成 Artifact 初始化、修订和知识选择，不建立独立 Artifact Agent 或固定 Projection Pipeline。其 `bash` 局部 `PATH` 暴露同一个标准 Git CLI，让 Agent 使用普通 `git` 命令，不增加专用 Git Tool 或替代协议。Harness 不自动编排 Git 工作流，也不限制 Agent 根据当前任务使用普通 Git。外部终端和其他外部进程默认不获得这一 PATH 注入。该实现不把 Git、目录或 `AGENTS.md` 提升为 Artifact Domain 的长期本体。

面向用户的现有对话 Agent 扩展为一个通用管理 Agent。每个 Session 始终拥有 `read`、`edit`、`write`、`bash`、`search_knowledge`、`read_knowledge` 和 `upsert_knowledge`；Session 只保存对话与模型配置，不绑定 Artifact、Project、Workspace 或 `cwd`。四个 Coding 工具以固定 Artifact Repository 根作为初始坐标，但工具按 APP 当前 OS 用户权限运行，该坐标不是访问或安全边界。Harness 不建立 Artifact selector、router、锁、路径限制、命令白名单、Shell Sandbox 或 Bash 逐次审批。

没有预选 Artifact。通用管理 Agent 根据对话和当前文件系统识别相关的零个、一个或多个 Artifact，并读取各自根 `AGENTS.md` 以理解持久 Attention。Harness 不自动加载某个 Attention，也不把 Artifact 清单塞入上下文。System Prompt 只给出 Repository 绝对路径、一级目录 Artifact、根 `AGENTS.md` 和没有预选 Artifact 等必要环境事实，不加入允许/禁止清单或工具使用原则。

Knowledge Statement 是知识层领域语义的 Source of Truth。canonical title 使用专名、术语或自然名词短语稳定指称一个知识主体，而不把“X 在 Y 中的含义”“X 与 Y 的关系”等命题或场景概括成标题；主体的语境、范围、属性、关系、条件、例外和不确定性由正文表达。正文使用 `[[canonical title]]`，或在需要局部措辞时使用 `[[canonical title|local display text]]`，同时引用多个 Statement；局部显示文本不参与目标选择。名称引用在读取时动态指向当前知识视图中拥有该 canonical title 的 Statement，不永久绑定正文写作时的存储记录。出站引用、反向引用、图或超图等表示只能作为派生能力。canonical title 与正文都应具有实际语义，不以机械编号、枚举关系或路由规则代替知识。普通 Statement 可以解释一个词语在不同语境下可能指向哪些具体 Statement，但它只服务外部消歧；内部含义已经确定时应直接使用具体 Statement 的 canonical title。

正式 Knowledge Statement 应能够追溯到原始观察或输入知识；具体记录和校验方式，以及当前 MVP 是否完整实现，不由本 ADR 决定。

Knowledge Maintenance Agent 是普通、可替换的工具使用 Agent，其角色由 System Prompt、Workspace、工具权限和提交边界定义，不引入专用状态机或任意的总轮次、工具次数和时长配额。具体 Runtime、上下文管理和工具协议属于可替换实现。

Artifact 不是新的世界事实，也不是可由知识层覆盖式重建的纯派生物。用户可以直接创建或编辑 Artifact；Agent 的后续更新以当前 Artifact 状态为输入，并延续已经接纳的编辑。通用管理 Agent 同时拥有 Knowledge 与文件工具，但文件修改不会自动回流为知识；调用 `upsert_knowledge` 是对知识层作出的另一项明确修改。是否为需要深入核查的反馈建立 `Knowledge Need` 或其他异步协议尚未决定。

本地历史和未来实时来源进入同一观察处理边界。输出侧优先通过 MCP 和本地 API 提供 Pull-based Search/Context。通用管理 Agent 已作为内置协作界面；自动上下文注入、浏览器和其他专用执行产品能力仍延后。

当前对具有稳定原始位置的本地历史采用以下访问策略；它不预先决定未来其他来源是否由 Oyster 托管正文：

- Conversation transcript 与人类编写的 Agent 指令是当前支持的两类外部 Raw Evidence；
- Oyster 只保存稳定来源身份、内部 locator 和轻量版本指纹，不复制每个 Harness 的 JSONL、Markdown 或其他原始正文；
- 轻量 header/metadata 解析只用于 catalog、统计和变化判断。使用证据时，Source Adapter 校验并读取用户选择的确定版本；完整标准化与 LLM 理解发生在后续可重建层；
- 外部记录可以变化或消失。当前加工运行记录所使用的来源与版本；再次展开失败必须明确暴露，不能静默改用另一个版本。正式知识采用何种追溯结构留给治理设计；
- Agent 自动生成的 memory 不作为来源。它属于外部 Agent 的派生结果，而且扫描时的当前版本不能证明某个历史 turn 实际看到的版本。

## 本 ADR 未决定的事项

以下内容仍是可探讨方向，不属于本 ADR 已接受的决定：

- 当前目录式 Artifact 是否成为长期载体，以及何时需要稳定 ID、其他 Artifact 类型或验证契约；
- Context Packet 等临时消费输出能否提升为 Artifact，以及提升语义；
- 是否正式引入 Project、Collection、Workspace 等分组类型；
- Artifact 之间的引用、依赖、组合和构建语义；
- Artifact 的移动、重命名、版本、合并、同步、失效、删除与来源治理，以及 APP 是否应管理 Git 修订；
- `Knowledge Need` 等异步反馈或深度调查协议；
- 真实使用是否证明需要为当前高信任通用 Agent 增加权限、Sandbox、审批或并发治理；
- 代码或脚本的独立验证、构建、分发和安装产品能力。

## Consequences

### Positive

- 产品价值不依赖单个 Agent、模型、浏览器或 Harness；
- 大型历史可以按 Session 使用，无需维护第二份完整数据；
- 原始证据和 LLM/Agent 推断分离，知识可审查、重建和删除；
- Candidate Agenda、Contribution Draft、Knowledge Contribution 与 Knowledge Statement 的边界清晰，正式知识生产者复用统一的贡献和治理契约；
- Artifact 可以采用适合交付目标的异构形式，而不与共享知识或临时消费视图混为一种状态；
- 固定 Repository、一级目录和根 `AGENTS.md` 提供了无需额外 Schema 或专用编辑器的最小可验证载体；
- 捆绑的标准 Git Runtime 消除了系统 Git 和用户 `PATH` 差异，同时保留普通 Git 工具的互操作性；
- 单一通用管理 Agent 可以在同一对话中跨 Knowledge 与多个 Artifact 工作，不需要用户先选择 Project 或 Workspace；
- 最小 Harness 把语义相关性判断留给 Agent，避免 Artifact router、Session 类型和权限策略提前固化产品模型；
- 跨项目关系和跨 Agent 检索成为一等能力；
- MCP 等开放协议可以作为消费者边界，而不污染内部模型。

### Negative

- Connector 和上游格式兼容性成为长期维护成本；
- Oyster 对外部目录及格式保持运行时依赖，记录变化或消失后可能无法再次核查原文；
- 三个状态域、共享 Attention 与 Agent 维护边界比“消息 + 向量库”复杂；
- 异构 Artifact 不能被简化为随时覆盖重建的物化视图，未来需要处理自己的编辑与生命周期问题；
- 路径暂作身份且 APP 不管理 Git 修订，因此移动连续性、自动历史和并发冲突当前没有产品保证；
- Oyster 需要随 APP 维护、验证和更新捆绑的 Git Runtime；
- 文件与 Shell 工具以当前 OS 用户权限运行，Artifact Repository 根不是安全边界；模型误判或不可信内容导致的命令后果由当前高信任模型直接承担；
- 不建立 Artifact 锁或自动冲突处理时，多个 Session 可能同时修改同一共享 working tree；
- 知识质量需要真实评测与人工治理，不能只靠模型能力；
- 相邻产品已提供跨 Agent Memory/MCP，必须持续证明 Oyster 在历史访问、异构保真和治理上的差异。

## Rejected alternatives

- 继续以独立浏览器为产品主体；
- 把产品退化为只有通用 Agent Harness、再附加记忆，而不保留 Observation、Knowledge 与 Artifact 的独立权威模型；
- 只做统一聊天记录查看器；
- 只做向量数据库和 MCP Memory CRUD；
- 默认自动注入所有检索结果；
- 因知识和 Artifact 都可以表现为 Markdown，就把它们合并为同一类无差别节点；
- 把第三类状态固定为 Markdown 文档，或把可编辑产物当作可以从知识层随时覆盖重建的纯投影视图；
- 现在就把 Project 固化为知识分区或核心知识本体；
- 让用户选择任意目录作为当前 Artifact Repository，或为每个 Artifact 建立独立 Repository；
- 依赖系统 Git 或用户 `PATH` 完成 APP 内部 Git 操作，以及为 Agent 设计专用 Git Tool 或非标准 Repository 格式；
- 为 Knowledge 与 Artifact 建立两个互斥的对话 Agent，或按 Artifact / Project 切分 Session；
- 在没有真实问题证据时加入 Artifact selector/router/lock、路径 Sandbox、Shell 白名单或逐次 Bash 审批；
- 为追求统一而丢弃 Harness 原始事件与分支语义。

## Review trigger

出现以下证据之一时复审本 ADR：

- 目标 Harness 提供稳定、通用且可枚举、读取的标准历史协议；
- 用户研究表明跨 Harness 历史访问和检索没有显著价值；
- 上游变化频率使按需读取无法提供足够的版本确定性；
- MVP 无法在真实查询集上显著减少重复解释或重复尝试；
- 浏览器或执行能力被证明是知识价值闭环不可缺少的前置条件；
- 真实场景表明第三类产物不需要独立持久状态，或 Attention 不能解释其组织边界；
- 固定单 Repository、目录式 Artifact 或路径身份无法满足真实 Artifact 的权限、迁移或协作需求；
- 高信任全本机工具在真实使用中造成无法由 Agent 判断与用户可见性解决的重复性风险。
