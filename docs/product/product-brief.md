# Oyster Product Brief

> 实现状态（2026-08-11）：Oyster 已按 [ADR-0002](../decisions/0002-unified-git-agent-collaboration.md) 统一为一个 Repository；Knowledge、Artifact 与 Knowledge Processing Task 分别位于根级 `knowledge/`、`artifacts/`、`tasks/`。Agent Runtime 已统一迁移到 Pi Coding Agent SDK，并采用 Pi Session、精简 Agent Invocation 和本地 Debug Store 三层持久化。术语以[《Oyster 术语与执行模型》](../architecture/terminology.md)为准。

> 状态：当前产品定位（source of truth）
>
> 日期：2026-08-11
>
> 决策记录：[ADR-0001：将 Oyster 定位为 Agent-Agnostic Knowledge Hub](../decisions/0001-agent-agnostic-knowledge-hub.md)
>
> 知识模型原则：[知识加工、Projection 与 Artifact](../architecture/knowledge-model-and-projection.md)
>
> AI 运行后端：[AI Backend MVP](ai-backends-mvp.md)
>
> 内置通用管理界面：[通用管理 Agent MVP](chat-agent-mvp.md)
>
> Artifact 当前载体：[Artifact 文件层 MVP](artifact-repository-mvp.md)
>
> 通用文件浏览界面：[通用文件夹浏览器 MVP](folder-browser-mvp.md)
>
> 外部 Skill 可观测切片：[外部 Agent Skill 发现与浏览 MVP](skill-discovery-mvp.md)
>
> Skill 绑定方向：[Skill Symlink 注入 MVP](skill-symlink-injection-mvp.md)

## 1. 一句话定位

Oyster 是一个独立于 Claude Code、Pi、Codex 等外部 Agent Harness 的、本地优先的跨 Agent、跨项目知识与协作产物中心：它接入异构 Agent 活动，保留可核查的出处身份，将其加工为可检查、可修订、可检索的知识，并维护围绕 Attention 形成的 Artifact；当前以一个通用管理 Agent 作为主要人机协作入口。

Knowledge Maintenance Agent 负责结构化知识加工链路；面向用户的通用管理 Agent 则是跨 Knowledge、Artifact 和普通对话的人机协作界面。两者复用通用 Agent Runtime 和同一个 Repository，但工作坐标由业务所有者决定：通用管理 Agent 从 Repository 根工作，结构化知识加工 Agent 从所属 Task 的独立文件工作空间工作。两者仍维护同一组正式 Knowledge/Artifact，不建立领域事实副本。

## 2. 用户问题

用户同时使用多个 Agent，并在多个项目间工作时，知识被切碎在不同 Harness 的会话、项目目录和私有格式中：

- 同一问题可能在 Claude Code、Pi 和 Codex 中被重复调查；
- 已尝试方案、失败原因、架构决策和用户偏好难以跨会话复用；
- Agent 原生记忆通常绑定特定产品、账户、项目或会话；
- 历史对话虽存在本地文件中，却缺少统一搜索、关系、出处和生命周期管理；
- 把聊天记录直接向量化会丢失分支、工具调用、时间、项目和来源语义；
- 自动总结容易把推断写成事实，且难以追溯和纠错；
- 用户难以统一看清不同 Agent、全局与项目目录中已经注册了哪些 Skill，以及它们的原始内容和位置；
- 用户缺少一个能够查看“接入了什么、如何得出、向谁提供过”的独立控制面。

## 3. 产品承诺

Oyster 向用户提供六个核心能力：

1. **发现与接入**：发现本机 Agent 的可执行程序、应用、配置和数据目录，明确展示每个来源支持历史访问、实时通知或上下文输出中的哪些能力。
2. **保真访问**：为聊天 transcript 与人类编写的 Agent 指令建立轻量 catalog，并在需要时由 Source Adapter 从原始位置读取确定版本；不同 Harness 的原始格式不因统一模型而丢失，Agent 自动生成的 memory 不作为历史来源。
3. **知识加工与管理**：由 Knowledge Maintenance Agent 在用户 Attention 下完整扫描 Canonical Activity 与附件、按 locator 回查由固定 Raw Evidence 行模型生成的 Evidence page、核查现有知识并形成可复用的理解；通用管理 Agent 也可以直接搜索、读取和维护正式 Knowledge。
4. **协作产物**：在统一 Repository 的 `artifacts/` 中保存围绕持久 Attention 组织的任意文件产物；当前通用管理 Agent 可以根据对话和文件系统自主发现相关 Artifact，并与用户共同维护当前状态，但不构成 Artifact 的唯一维护方式。
5. **Skill 发现与管理**：在专门的 Skills 页面中分开展示 Oyster 管理的 Skill Artifact 与其他 Agent 的外部注册事实；前者可以预览统一输出并通过显式 symlink Binding 注入已支持的用户级目标，后者保持只读发现。两者不因名称或路径相似而合并身份。
6. **安全供给**：通过本地 API 和 MCP 等开放边界向第三方 Agent 提供检索；未来可在用户授权、Scope 和 Token Budget 内生成并注入 Context Packet。

## 4. 产品身份与边界

Oyster 是：

- Agent-agnostic 的个人知识基础设施；
- 本地 Agent 活动的可检查数据层和控制面；
- 外部历史的出处 catalog，以及内部标准化事件和派生知识的长期所有者；
- 跨项目、跨仓库路径和跨 Harness 的关系维护者；
- 通过完整原始观察、可回查的确定性活动视图和受控 Agent 维护知识、但不把模型输出自动当作真相的系统；
- 以一个跨 Knowledge 与 Artifact 的通用管理 Agent 作为主要人机协作界面的平台。

Oyster 不是：

- 按 Project 或代码仓库切分对话、要求用户预先选择 Workspace 的传统 Coding Agent Harness；内置通用管理 Agent 的 Chat Conversation 不绑定 Artifact 或 Project；
- 只提供向量搜索的 Memory MCP Server；
- 将全部聊天无差别上传云端的遥测系统；
- 默认把所有历史自动塞入每次 Prompt 的上下文注入器；
- 以替代 Chrome 为目标的浏览器；
- 首个版本就承担多用户数据湖、企业治理或自主 Agent 编排的平台。

## 5. 核心领域分层

Oyster 必须区分领域事实与工作过程，避免把模型总结覆盖到原始事实之上，也避免因目录相邻而混淆身份和生命周期：

| 状态与权威域 | 内容 | 规则 |
| --- | --- | --- |
| 观察层 | 由 Source Conversation 和精确版本身份指向的 Raw Evidence，以及可重建的 Canonical Activity | 外部原文按需读取，确定性视图可重建；不得把模型解释伪装成来源事实 |
| 知识层 | 从观察或已有知识形成的 Knowledge Statement；Statement 正文可以通过 canonical title 显式引用其他 Statement 并表达任意多元关系 | Statement 是领域语义的 Source of Truth；名称引用在读取时动态指向当前知识视图中的同名 Statement；不预设独立 Relation、Decision、Problem 等全局类型 |
| Artifact Domain（协作产物域） | 用户与 Agent 围绕 Attention 持续维护的 Artifact；不限定为 Markdown 或单一文件，可以是文档、配置、模板、代码、脚本、资产或它们的组合 | Artifact 具有独立身份、当前状态和修订生命周期，并接纳用户编辑；其说明文档是维护目标、证据边界、质量义务和完成条件的表达载体；它不是知识真相源，不能自动回流知识；内容形式不改变它所属的权威域 |
| Knowledge Processing Task | 从一个 Source Snapshot 形成批准候选 revision 的一次业务尝试；当前使用 Maintainer / Reviewer Collaboration Round | 位于 `tasks/<taskId>/`；拥有过程文件，但不拥有或复制 Knowledge/Artifact，只通过正式路径和 commit OID 引用它们；Task 中的角色不自动成为 Artifact Domain 的角色 |

本文将 `Artifact` 作为第三个权威域中单个协作产物的正式英文名称；观察中的来源侧对象使用 Activity Artifact 等限定名称，Discovery catalog 中的外部来源记录称为 Source Record。

Artifact Domain 不定义全局 Maintainer、Reviewer 或 Critic，也不把当前通用管理 Agent 固化为唯一责任主体。Artifact 的说明文档描述维护后必须成立的局部契约，而具体维护可以由用户、一个或多个通用 Agent、临时 subagent、面向特定任务的流程或未来其他机制完成。需要多视角校验时，工作流可以按说明形成临时任务分工；角色名称、数量、编排和执行机制不是 Artifact 的领域语义。可强制的独立审批与 promotion 由采用它的具体工作流定义，不能仅由说明文档宣称完成。

Source Adapter 从完整 Raw Evidence 确定性生成可回查、对话优先的 Canonical Activity。它完整保留对话正文和上下文压缩的语义摘要；工具只保留操作身份以及调用和结果的 Raw locator，参数、结果、Codex 运行时 user-role 信封、模型内部 reasoning、压缩 replacement history、执行状态和重复上下文快照不进入默认语义正文，图片等附件独立提取。Core 为已接受 Source Snapshot 创建 `tasks/<taskId>/`：`BRIEF.md` 表达目标，`PROGRESS.md` 保存活动覆盖清单与角色 handoff，`inputs/` 保存有界 Activity、由固定 Raw Evidence 行模型生成的 Evidence 文本和真实附件文件，`manifest.json` 固定目标、初始工作定义、物化输入和创建时的 Knowledge/Artifact working-tree 指纹，`pi-sessions/` 保存 Knowledge Agent 的 Pi Session；Task 进入终态后由 `task.json` 保存结果或错误与精简 Agent Invocation envelope。Maintainer 使用普通 `read` 完整扫描这些文件并按 locator 回查 Evidence；不再安装按 Observation 格式命名的专用工具。Maintainer/Reviewer 也不安装通用 Todo，Chat Agent 继续使用通用 Todo。

三个域在状态和所有权上分离，但知识加工、Projection 和 Artifact 维护通过共享 Attention 耦合。Projection 是从知识、Attention 和必要的当前状态形成按需消费输出，或初始化、修订 Artifact 的活动，不是第三个持久状态域本身。同一个 Attention 可以指导 Knowledge Maintenance Agent 和通用管理 Agent；不同 Attention 产生的知识进入共享知识层并可以重叠、复用或相互修订，不按 Artifact 复制成独立真相。

Artifact 可以随用户 Attention 自然形成分组。是否把这种分组正式建模为 Project，以及它的身份和生命周期，仍是未决定事项；无论采用何种形式，Artifact 分组都不得把共享 Knowledge 分割成彼此隔离的真相。

目标载体是一个本地标准 Git Repository：`knowledge/` 保存 Statement 文件，`artifacts/<artifact>/` 保存 Artifact，`tasks/<taskId>/` 保存彼此隔离的 Task workspace 和历史；每个 Artifact 根 `AGENTS.md` 表达持久 Attention。Knowledge 与 Artifact 共享 revision 但不合并语义，Task 文件不进入候选内容 commit。详见[《知识加工验证 MVP》](knowledge-processing-mvp.md)和[《Artifact 文件层 MVP》](artifact-repository-mvp.md)。

外部 Agent 拥有原始记录的生命周期。记录变化、消失或权限被收回时，再次展开必须明确失败，不能静默改用相似来源。当前本地来源访问保留已使用的来源与版本身份；正式知识长期采用何种追溯结构留给治理设计。用户仍可删除 Oyster 持有的 catalog、索引、知识和其他派生数据。

域间与知识间关系的最小原则见[《知识加工、Projection 与 Artifact》](../architecture/knowledge-model-and-projection.md)。

## 6. MVP 用户流程

### 6.1 发现 Agent 和数据源

当前已落地的纵向切片见[《本地 Agent 发现与外部证据访问》](local-agent-discovery-mvp.md)、[《外部 Agent Skill 发现与浏览 MVP》](skill-discovery-mvp.md)、[《Skill Symlink 注入 MVP》](skill-symlink-injection-mvp.md)、[《AI Backend MVP》](ai-backends-mvp.md)、[《知识加工验证 MVP》](knowledge-processing-mvp.md)、[《通用管理 Agent MVP》](chat-agent-mvp.md)和[《Artifact 文件层 MVP》](artifact-repository-mvp.md)。Skills 页面从统一 Repository 的 Artifact 层派生 Oyster 管理视图。知识加工从一条 Source Conversation 接受精确 Source Snapshot 并创建 Task；通用管理 Agent 用同一个 Repository 根处理 Chat Conversation、Knowledge 与 Artifact。

Oyster 启动后执行本地发现，并分别报告：

- Harness 是否可启动：PATH、常见安装位置、应用包或包管理器记录；
- 数据是否存在：已知配置、会话和归档目录；
- 历史访问能力：格式识别版本、会话数、时间范围和预计大小；
- 实时能力：Hook、Extension、Plugin 或文件增量监听；
- 输出能力：MCP、配置文件导出或 Harness 专用插件；
- 权限状态：未授权、只读、已启用实时采集或已断开。

“安装存在”和“数据存在”是两个不同结论。Agent 可能通过 GUI 启动、不在当前 PATH 中，但仍有可访问的数据。

### 6.2 选择并读取历史

1. 用户选择 Claude Code、Pi 或 Codex 来源；
2. Oyster 预览将访问的 transcript/人类指令目录、记录数量、项目范围和敏感信息风险；
3. Source Adapter 扫描并登记稳定身份、内部 locator 和轻量版本指纹，不复制正文；
4. 用户按 Agent、项目、时间或 Source Conversation 选择需要查看或加工的记录；
5. 主进程从原始位置读取该记录并固定本次使用的确定版本；
6. 如果来源已经变化或失效，系统以结构化输入错误拒绝接受 Source Snapshot；用户可以直接在 Source Conversation 选择器刷新本机 catalog 并重新选择，系统不回退到 Oyster 内部副本。

### 6.3 实时增量采集

用户显式安装或启用第一方 Connector 插件。插件在稳定生命周期边界通知 Oyster，例如 Agent Turn Stop、Agent End、Compaction 或 Source Conversation End。通知只提供来源 ID、Source Conversation ID、游标或 transcript locator；若外部协议字段原名为 `session_id`，只在 Connector Adapter 边界保留。Oyster 仍通过受控来源读取边界获取必要内容，不在命令行参数中传递完整聊天正文。

MVP 的“实时”定义为 **turn 级近实时**，不是 token streaming。插件离线或 Oyster 未运行时，后续扫描可以重新发现已落盘的历史记录；实时路径不另建一套外部历史复制模型。

### 6.4 构建和维护知识

用户为项目、Topic 或任务选择 Attention，并启动知识加工：

开始加工前，用户在“AI 后端”中保存一个应用级 Default LLM。每个新 Task 在开始时固定 Maintainer / Reviewer 当时的 Connection、Model 和可选思考强度。数据来源与执行连接相互独立：从某个 Agent Harness 读取观察，不要求使用同一 Provider 进行知识加工。

1. Source Adapter 读取所选 Source Conversation 的精确版本，并按 Harness 的格式标记疑似 Skill 激活位置；
2. Source Adapter 将 Raw Evidence 确定性投影为带原文 locator 的 Canonical Activity；Core 接受 Source Snapshot 并创建独立 `tasks/<taskId>/`，把目标、Activity page、Evidence page、附件、格式说明和工作清单物化为固定或可变文件；
3. Maintainer Agent Invocation 从该 Task workspace 启动，只用普通文件与 Shell 工具覆盖完整活动与附件、按 locator 回查由固定 Raw Evidence 行模型生成的 Evidence page，再按 `BRIEF.md` 给出的正式路径修改 `knowledge/` 和必要的 `artifacts/`，完成清单后创建普通 Git commit；
4. Reviewer Agent Invocation 在独立上下文中审阅精确 HEAD：有问题时在相关文件加入通用 `REVIEW` 标记、追加未完成清单项并提交；通过时不创建 approval commit，Host 验证后在 `PROGRESS.md` 记录角色与精确 candidate OID；
5. 加工测试返回已批准但未合并的 revision。未来 promotion 与用户审查、纠正、删除和重新加工边界另行实现。

Knowledge Maintenance Agent 是一个普通、可替换的工具使用 Agent：业务目标、输入材料和工作状态通过独立 Task workspace 中的文件表达；角色差异来自 System Prompt、文件证据范围和 Host 对 revision/handoff 的解释，不来自 Observation 专用工具或另一套领域 CRUD。系统不预设 Model Call 次数、Tool Call 次数或总时长。

任何默认或自定义处理器产生的正式知识都没有不同的本体身份。系统应能解释其如何由观察或输入知识形成，但具体需要保存哪些运行元信息、如何持久化以及 MVP 覆盖到什么程度，留给后续验证。模型、Prompt、策略或 Agent 升级时可以重新加工知识，不重写 Raw Evidence。

### 6.5 Artifact 维护、Projection 与当前通用管理 Agent

Projection 可以根据共享 Knowledge、Attention 和必要的当前状态生成按需消费输出，也可以初始化 Artifact，或基于当前 Artifact 形成新修订。用户可以直接创建或编辑 Artifact；后续维护默认以当前状态为输入并延续已接纳的编辑，除非用户明确要求替换、重建、回退或删除。Artifact 内容不会仅因存在而自动成为 Knowledge；一次明确的现实修改可以同时更新 `knowledge/` 与 `artifacts/`。

统一 Repository 的 `artifacts/<artifact>/` 是 Artifact 文件层；带可读取根 `AGENTS.md` 的目录是一个 Artifact。`AGENTS.md` 表达持久 Attention，并作为适用于该 Artifact 的维护目标、证据边界、质量义务和完成条件的表达载体；四项内容是否充分属于内容质量，不成为 Artifact 有效性的固定 Schema，也不以固定 Agent 拓扑作为 Artifact 身份的一部分。`knowledge/**/*.md` 是 Knowledge 文件层。Repository 继续使用捆绑的标准 Git Runtime，系统 Git 不是前置条件。

Artifact 层不预设全局 Maintainer、Reviewer 或 Critic。某个 Artifact 需要相互校验时，采用它的维护方式可以依据说明形成临时任务分工并隔离必要证据；这些分工只服务本次工作，不进入 Artifact Domain，也不绑定某一种执行机制。当前已实现的通用管理 Agent 复用 `read`、`edit`、`write`、`bash`、`spawn_agent` 和通用 Todo，根据对话和文件系统识别相关 Knowledge 与 Artifact；其中 `spawn_agent` 是通用委派能力之一，不是 Artifact 专属协议。这是当前主要入口，不限制后续增加其他 Artifact 维护方式。

`bash` 的局部 `PATH` 提供 APP 捆绑的标准 Git CLI，不增加专用 Git Tool。当前结构化知识加工中由 Host 创建 Task 和 `knowledge-task/<taskId>` branch；Maintainer 创建内容 commit，Reviewer 只批准 candidate revision 且不 merge。Context Packet 仍是临时消费视图。

### 6.6 发现和浏览外部 Skill

用户在独立 Skills 页面触发发现。Oyster 检查 Claude Code、Pi 和 Codex 的已知用户、机器和项目注册位置；项目路径来自当前 Source Conversation catalog 已经知道的工作目录，不遍历整个 Home 猜测仓库。

发现结果按 Agent、scope 和原始路径分别展示。同名 Skill 不跨 Agent 合并；项目项明确显示项目标记和作用目录，admin、system 与其他来源也保留自身标记。用户可以查看入口 Markdown、原始 Skill 目录和入口文件绝对路径，并在系统文件管理器中打开原始目录。

这是外部文件系统的只读当前视图，不是 Artifact、历史 Source Record 或运行时 enabled 证明。正文按选择读取，脚本和附件不执行；发现不会迁移、绑定或注入 Skill。具体边界见[《外部 Agent Skill 发现与浏览 MVP》](skill-discovery-mvp.md)。

### 6.7 绑定 Oyster 管理的 Skill

一个由 Oyster 管理的 Skill 对应一个 Artifact；Artifact 根 `AGENTS.md` 继续表达持久 Attention，根部存在 `output` 时由 Skill 应用派生出 Skill Artifact 视图。外部 Agent 原生加载的 Skill 根固定为有效的 `output/` 子目录。当前实现允许在 Claude Code、Pi 和 Codex 的用户级规范注册根创建目录 symlink，链接目标是该 `output/`，不是 Artifact 根；项目级 Binding 留给后续切片。

当前实现不复制或同步 Skill，不做 Agent 专属内容转换，也不安装 Plugin、Hook 或 MCP。所有 Agent 暂时共用同一个 `output/`；不同 Agent 仍需要各自的注册根定位，但这只是路径适配，不改变 Skill 内容。symlink 本身就是绑定事实，不新增 Binding 数据库、Artifact 类型或 manifest。管理入口集中在 Skills 页面；Artifact 页面只显示 Skill 标记、输出摘要和导航入口。完整边界见[《Skill Symlink 注入 MVP》](skill-symlink-injection-mvp.md)。

这里的持久 Skill Binding 与下一节按请求形成的 Context Packet 或 Prompt-time 上下文注入是两种不同能力，不能共用 enabled、Scope、Token Budget 或审计语义。

### 6.8 检索和供给上下文

对外检索保持只读优先，并从以下最小能力逐步开放；具体工具名和协议形态可以替换：

- 按语义发现当前 Knowledge Statement；
- 读取一条 Statement，并按需探索正文名称引用形成的邻域；
- 在权限允许时回到必要的原始证据；
- 按当前目标构建有界的消费上下文。

默认采用 Agent 主动查询的 Pull 模式。自动 Push 注入属于后续能力：它需要可解释的选择理由、严格的项目/身份 Scope、敏感信息过滤和用户可见的注入记录。

## 7. MVP 范围

### 必须完成

- macOS 上发现 Claude Code、Pi、Codex 的数据源；
- 三个第一方 Source Adapter 的历史发现、版本校验和原地按需读取；
- 统一的 Connector Plugin API 与版本化 Capability Manifest；
- 三个 Harness 的 turn/session 级实时增量采集路径；
- 可重复的 catalog 扫描，以及来源变化、移动、删除和权限失效的确定行为；
- 项目/会话 catalog 浏览、基础筛选和出处可用性展示；
- 提供至少一个可替换的默认 Attention 和受控 Knowledge Maintenance Agent，优先维护细粒度、持久且可复用的对象与概念理解；任务事件只在形成这类理解或 Attention 明确要求时保留，且不将其固化为核心本体；
- 默认和自定义知识处理器遵循统一 Repository、commit 交接和 Reviewer 接受边界；
- 用户审查、纠正、删除和重新加工；
- 可替换的 AI Connection；首个实现支持 Codex Coding Plan 与 OpenAI-compatible API，并由唯一 Default LLM 为新 Knowledge Processing Task 和新建 Chat Conversation 提供 Connection、Model 和思考强度；
- Oyster 接收的 API Key 与主动完成 OAuth 后获得的 Coding Plan 凭据进入系统 Keychain；不扫描、读取或复制其他 Agent Runtime 的凭据；
- 本地 MCP Server 提供检索与有预算的 Context Packet；
- 当前验证所需的用户可见运行与结果信息；
- 外部 Agent Skill 的只读发现与浏览：覆盖 Claude Code、Pi 和 Codex 的已知用户、项目及机器注册位置，展示 Agent、scope、项目路径和原始位置，并按需预览入口 Markdown；
- 统一 Git Repository 的初始化、扫描、刷新和系统打开入口；`knowledge/` 保存 Knowledge Statement，`artifacts/<artifact>/` 保存带根 `AGENTS.md` 的 Artifact；
- 随 APP 捆绑私有标准 Git Runtime，APP 通过绝对路径调用它并在没有系统 Git 时仍能初始化标准 Repository；
- 一个跨普通对话、Knowledge 与 Artifact 的通用管理 Agent；它复用基础文件、Shell、Todo 和临时子 Agent 能力，不保留平行的 Knowledge 写入协议，Chat Conversation 不绑定 Artifact、Project 或 `cwd`；
- 结构化知识维护使用 `knowledge-task/<taskId>` 和完整的 `tasks/<taskId>/` 文件工作空间：Maintainer 创建内容 commit，Reviewer 在 Task 中记录批准且不 merge；
- Chat Coding Tools 从统一 Repository 根开始，结构化知识加工 Coding Tools 从本次 Task workspace 开始；两者都以当前 OS 用户权限运行。Host 不增加路径 Sandbox、Bash 审批、Artifact selector/router/lock、专用 Git Tool、Observation 读取 Tool 或审阅提交工具。

正式知识可追溯是一项产品原则，但其持久形式、校验方式和 MVP 验收范围尚未确定；在形成独立决策前，不把它展开为固定字段或流程要求。

Observation、Knowledge 与 Artifact 保持不同的语义与权威边界；Knowledge 和 Artifact 只共享物理 Repository 与 revision，不合并领域含义。按范围生成的临时消费输出、运行期工作材料和调试快照不会因此自动成为 Artifact。

### 明确不做

- 完整浏览器 Shell；
- 自动修改所有 Harness 的全局配置；
- token 级实时镜像；
- 在没有用户动作时读取所有本地聊天正文；
- 默认云同步或团队共享；
- Artifact Domain 级的全局 Maintainer/Reviewer/Critic、Artifact/Project Chat Conversation 绑定、selector/router/lock 和专用 Git Tool；当前不排除未来由具体 Artifact 说明驱动的任务级多 Agent 维护方式；
- 专用 Knowledge CRUD、Contribution Draft、`submit_review` 或另一套审阅状态协议；
- Harness 代替 Agent 修改内容、代理 commit 或复制 Reviewer 问题；并发治理、远端同步、自动 rebase 和复杂 merge conflict 处理；
- 把派生知识自动写回 `AGENTS.md`、`CLAUDE.md` 等项目文件；
- 当前 Skill Binding 只覆盖 Claude Code、Pi 和 Codex 的用户级规范注册根；仍不自动把外部 Skill 迁入 Artifact，不提供项目级绑定、Agent 专属内容适配、Skill 执行、附带脚本安装、调用统计或效果判断；
- 依赖某个向量数据库作为领域真相；
- 首版支持任意第三方 Connector 在主进程内执行。

## 8. Connector 契约

每个 Connector 通过 Manifest 声明能力，而不是假设所有 Harness 行为相同：

```text
id / version / supported_os
discover: executable | app | data_roots | config
history: enumerate | preview | read
live: hook | extension | file_watch | unsupported
output: mcp | context_hook | file_export | unsupported
source_formats: names and supported version ranges
permissions: requested paths and operations
```

Source Adapter / Connector 只拥有发现、定位、版本校验、读取、解析和来源游标。它以引用方式提供 Raw Evidence，并可以产生 Canonical Activity，但不能复制外部历史、修改统一 Repository、运行 Knowledge Maintenance Agent，也不能绕过上层运行边界将数据发给 LLM。Agent 调度、审阅、删除和供给由 Core 统一拥有。

MVP 只内置和签名第一方 Connector。未来第三方 Connector 必须在独立进程中运行，使用显式文件范围、本地网络范围和版本化协议；Harness 插件通常拥有与 Agent 相同的本机权限，安装前必须展示这一风险。

## 9. AI 执行能力在产品中的职责

Oyster 把认证和计费通道与 Agent 执行分开：

- **Coding Plan / API Backend** 决定凭据、Provider、传输和额度来源；
- **Connection** 是用户实际配置并授权的一条通道，可以暴露多个 Model；
- **Default LLM** 是应用级唯一的 Connection、Model 和可选思考强度组合；新 Knowledge Processing Task、Agent Preview 或 Chat Conversation 在各自边界捕获它；
- **Agent Runtime** 驱动 Agent Invocation 的模型—工具循环与上下文生命周期；当前唯一实现是 Pi Coding Agent SDK。一次不含 Agent loop 的直接模型生成只是 Backend 能力，不定义另一种 Runtime。

因此，Coding Plan 与 API 可以共享最小 `SelectedModelStream` 契约，同时仍保留各自不同的认证和计费语义。当前通用循环由 Pi Coding Agent SDK `AgentSession` 提供，Oyster 用 request-local Pi `ModelRuntime` bridge 接入已认证的 Connection stream，并继续拥有凭据与模型 binding。结构化知识加工中的 Maintainer 与 Reviewer 关闭 Pi 生态资源，只使用基础 `read`、`bash`、`edit`、`write`；面向用户的通用管理 Agent 只启用 Oyster 专属 `agentDir` 中配置的 Headless Extension 和普通 context file，并继续使用通用 Todo 与子 Agent 工具，不加载 Pi Skill、Prompt 或 Theme。它们共用 SDK 模型—工具循环、原生持久化 Session/compaction 和 Debug Recorder，但工作目录、文件证据范围与工作状态由 Task、Chat Conversation 或 Agent Preview 明确选择。Invocation 的业务记录保持精简；完整 Context、模型/工具活动与最终 Provider 请求/响应只进入本地 Debug Store。

LLM 适合承担：

- 驱动 Knowledge Maintenance Agent 覆盖完整 Canonical Activity 与附件、按 locator 回查由固定 Raw Evidence 行模型生成的 Evidence page，并调查名称、指代、背景和 Skill 激活线索；
- 驱动受控 Knowledge Maintenance Agent 多步搜索、核查、复用和维护共享知识；
- 驱动通用管理 Agent 在普通对话、Knowledge 与一个或多个 Artifact 之间自主选择必要工作；
- 由通用管理 Agent 将适合独立上下文处理的完整任务委派给临时子 Agent，并继续判断返回结果；
- 通过 Projection 活动，基于当前 Artifact 做局部修订；
- 通过 Projection 活动为一次查询构建带引用、可丢弃的 Context Packet。

LLM 和 Agent 都不拥有事实真相；它们对 Knowledge/Artifact 的持久修改必须落实为用户可检查的领域文件，而不能只存在于 Agent 的声明中。结构化知识加工由 Maintainer/Reviewer 对精确 candidate revision 完成交接和批准，且批准与 promotion 分离、测试 branch 不进入正式目标分支；其他 Artifact 维护不自动继承这些角色，其验证与接受边界由相应 Artifact 说明和具体工作流决定。正式知识应能够追溯到原始观察或输入知识；加工运行需要保存哪些长期治理元信息仍待后续决定。

基础发现、catalog 浏览、来源读取、删除和导出不得依赖在线 LLM 才能工作。

## 10. 安全与隐私底线

- 文件与 Shell 工具当前以 APP 的 OS 用户权限运行，不提供路径 Sandbox 或逐次命令审批；Repository 根或 Task workspace 都只是初始 `cwd`，不能表述为权限或安全边界。Reviewer 不读取 `inputs/` 是当前工作流的 System Prompt 与上下文边界，不是 OS 级强隔离；
- Agent 工具读取的本机内容可能进入当前所选模型 Provider 的上下文；产品界面应如实表达这一高信任执行后果。System Prompt 可以定义业务证据边界，但不得把这种行为约束表述成文件权限或安全隔离；
- 默认本地保存，任何远程模型处理都按 Provider 和 Scope 显式授权；
- 任何远程加工都必须明确显示所选 Connection、数据目的地和计费来源，不在连接之间静默切换；
- Coding Plan 的 Browser / Device Code 登录和 Token 刷新由 Oyster 通过受支持 Provider 的 OAuth 完成，凭据仅存系统 Keychain；Oyster 不读取或复制其他应用的凭据文件、Keychain 项或浏览器会话；
- API 密钥只由主进程从系统钥匙串读取，不返回 Renderer，不进入数据库、日志、Workspace 或模型输入；
- 首次读取正文前预览目录、范围和风险，不后台读取全部聊天正文后再征求同意；
- 原始聊天可能包含源码、凭证、个人信息和工具输出，按高敏数据处理；
- 日志只保留必要的非正文诊断，不记录正文、Prompt 或凭证；
- 远程加工前执行 Secret/PII 检测与可见的 Redaction；
- 持久化数据、缓存和派生索引遵守最小文件权限；静态加密方案必须在实现前通过验证；
- 搜索、MCP 和 Context Packet 都执行相同的 Scope 与敏感级别策略；
- Connector 读取权限和 Context Consumer 读取权限分开管理；
- 用户可查看某条知识何时被哪个 Agent 查询或注入；
- 用户解除来源后，Oyster 删除适用删除策略覆盖的内部状态，不修改外部 Agent 的原始文件；追溯信息与知识的保留或删除由同一治理策略明确处理。

## 11. 产品指标

### MVP 成功指标

- 发现准确率：测试机上的目标 Agent 数据源无漏报，误报可解释；
- 来源读取正确性：Fixture 中选中的记录按确定版本读取，且 Oyster 不建立正文副本；
- 变化处理：文件追加、截断、移动、删除和权限失效都有确定行为，不静默切换版本；
- 实时延迟：完成 turn 后正常路径数秒内可检索，离线后可补采；
- 知识质量：用户接受/轻微编辑率和错误 Claim 率可量化；追溯指标在治理方案确定后定义；
- 知识维护：Agent 能复用相关已有知识，重叠知识和不必要重写可量化；
- 检索质量：在真实跨 Agent 问题集上测 Recall@k、引用正确率和 Token 成本；
- 用户价值：减少重新解释背景的次数和耗时，减少重复失败尝试；
- 隐私：Fixture 中的测试凭证不进入日志、远程请求或未授权 Context Packet。

## 12. 后续方向

Skill 管理已确定为 Artifact Domain 的一个应用方向：每个由 Oyster 管理的 Skill 对应一个完整 Artifact，内部可以包含任意文件；知识型 Markdown 只是早期默认期望。专门的 Skills 页面把 Oyster 管理视图与外部发现视图分开：前者从根 `output` 约定识别 Skill Artifact 并管理用户级 symlink Binding，后者展示已知注册位置的只读当前事实。目标 Agent 只读取 Artifact 的固定 `output/` 子目录，不链接 Artifact 根，不复制或同步内容，当前不做 Agent 专属格式适配。具体规则见[《Skill Symlink 注入 MVP》](skill-symlink-injection-mvp.md)；生态调研见[《主流 Coding Agent 的 Skill 发现与格式调研》](../research/agent-skill-discovery-and-format.md)。

后续能力按实际价值验证逐步展开：

1. 对接 Agent 的运行时枚举能力，区分文件系统候选与当前 runtime enabled 的有效集合；
2. 建立可解释的 Skill 使用观测，并明确区分发现、启用、调用和实际效果；
3. 在不改变 Skill Artifact 包容性边界的前提下，基于 Knowledge、Artifact 与观测结果辅助维护和优化 Skill；
4. 在当前用户级 Binding 的基础上验证项目级目标选择，再根据真实兼容性问题判断是否需要 Agent 专属输出；
5. 更多 Harness、IDE、Issue Tracker、文档和浏览器来源；
6. SessionStart/UserPrompt 等生命周期的可审查 Context Push；
7. 项目规则文件的用户审查式导出，而非自动覆写；
8. 本地或远程同步、多设备和团队 Scope；
9. 用真实案例验证当前目录式 Artifact、路径身份、自然分组和跨 Artifact 协作需求；
10. 验证通用管理 Agent 能否在不绑定 Project 或 Artifact 的情况下，根据对话、目录和 `AGENTS.md` 正确维护零个、一个或多个 Artifact；
11. 更深入的跨项目冲突清理、过期检查和关系建议；
12. 受控任务执行与 Agent Browser；
13. 基于历史失败的提醒或策略 Gate。

任何新增能力都必须继续服从两个判断：它是否提高知识与 Artifact 的实际可用性；它是否基于已经观察到的问题，而不是在 Harness 中提前固化模型可以自行完成的判断。
