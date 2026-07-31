# Oyster Product Brief

> 状态：当前产品定位（source of truth）
>
> 日期：2026-07-31
>
> 决策记录：[ADR-0001：将 Oyster 定位为 Agent-Agnostic Knowledge Hub](../decisions/0001-agent-agnostic-knowledge-hub.md)
>
> 知识模型原则：[知识加工、Projection 与 Artifact](../architecture/knowledge-model-and-projection.md)
>
> AI 运行后端：[AI Backend MVP](ai-backends-mvp.md)
>
> 内置通用管理界面：[通用管理 Agent MVP](chat-agent-mvp.md)
>
> Artifact 当前载体：[Artifact Repository MVP](artifact-repository-mvp.md)

## 1. 一句话定位

Oyster 是一个独立于 Claude Code、Pi、Codex 等外部 Agent Harness 的、本地优先的跨 Agent、跨项目知识与协作产物中心：它接入异构 Agent 活动，保留可核查的出处身份，将其加工为可检查、可修订、可检索的知识，并通过一个通用管理 Agent 维护 Knowledge 与围绕 Attention 形成的 Artifact。

Knowledge Maintenance Agent 负责结构化知识加工链路；面向用户的通用管理 Agent 则是跨 Knowledge、Artifact 和普通对话的人机协作界面。两者可以复用通用 Agent Runtime，但前者受一次加工 Workspace 与提交协议约束，后者不按 Project、Artifact 或职责拆成不同 Agent。

## 2. 用户问题

用户同时使用多个 Agent，并在多个项目间工作时，知识被切碎在不同 Harness 的会话、项目目录和私有格式中：

- 同一问题可能在 Claude Code、Pi 和 Codex 中被重复调查；
- 已尝试方案、失败原因、架构决策和用户偏好难以跨会话复用；
- Agent 原生记忆通常绑定特定产品、账户、项目或会话；
- 历史对话虽存在本地文件中，却缺少统一搜索、关系、出处和生命周期管理；
- 把聊天记录直接向量化会丢失分支、工具调用、时间、项目和来源语义；
- 自动总结容易把推断写成事实，且难以追溯和纠错；
- 用户缺少一个能够查看“接入了什么、如何得出、向谁提供过”的独立控制面。

## 3. 产品承诺

Oyster 向用户提供五个核心能力：

1. **发现与接入**：发现本机 Agent 的可执行程序、应用、配置和数据目录，明确展示每个来源支持历史访问、实时通知或上下文输出中的哪些能力。
2. **保真访问**：为聊天 transcript 与人类编写的 Agent 指令建立轻量 catalog，并在需要时由 Source Adapter 从原始位置读取确定版本；不同 Harness 的原始格式不因统一模型而丢失，Agent 自动生成的 memory 不作为历史来源。
3. **知识加工与管理**：用 Observation Preprocessing 从原始活动中发现值得调查的问题，再由 Knowledge Maintenance Agent 在用户 Attention 下核查现有知识与 Raw Evidence、形成可复用的理解；通用管理 Agent 也可以直接搜索、读取和维护正式 Knowledge。
4. **协作产物**：在 APP 管理的本地 Artifact Repository 中保存围绕持久 Attention 组织的任意文件产物；通用管理 Agent 根据对话和文件系统自主发现相关 Artifact，并与用户共同维护当前状态。
5. **安全供给**：通过本地 API 和 MCP 等开放边界向第三方 Agent 提供检索；未来可在用户授权、Scope 和 Token Budget 内生成并注入 Context Packet。

## 4. 产品身份与边界

Oyster 是：

- Agent-agnostic 的个人知识基础设施；
- 本地 Agent 活动的可检查数据层和控制面；
- 外部历史的出处 catalog，以及内部标准化事件和派生知识的长期所有者；
- 跨项目、跨仓库路径和跨 Harness 的关系维护者；
- 通过 Observation Preprocessor 和受控 Agent 共同维护知识、但不把模型输出自动当作真相的系统；
- 以一个跨 Knowledge 与 Artifact 的通用管理 Agent 作为主要人机协作界面的平台。

Oyster 不是：

- 按 Project 或代码仓库切分会话、要求用户预先选择 Workspace 的传统 Coding Agent Harness；内置通用管理 Agent 的 Session 不绑定 Artifact 或 Project；
- 只提供向量搜索的 Memory MCP Server；
- 将全部聊天无差别上传云端的遥测系统；
- 默认把所有历史自动塞入每次 Prompt 的上下文注入器；
- 以替代 Chrome 为目标的浏览器；
- 首个版本就承担多用户数据湖、企业治理或自主 Agent 编排的平台。

## 5. 核心领域分层

Oyster 必须把三个相互区分的状态与权威域分开，避免把模型总结覆盖到原始事实之上，也避免因表示格式相似而混淆不同状态的身份、权限和生命周期。现有 Raw Evidence 与 Canonical Activity 是观察层的两个子层，不是额外的权威域：

| 状态与权威域 | 内容 | 规则 |
| --- | --- | --- |
| 观察层 | 由来源与版本身份指向的 Raw Evidence，以及可重建的 Session、Message、Tool Call/Result 等 Canonical Activity | 外部原文按需读取，确定性视图可重建；不得把模型解释伪装成来源事实 |
| 知识层 | 从观察或已有知识形成的 Knowledge Statement；Statement 正文可以通过 canonical title 显式引用其他 Statement 并表达任意多元关系 | Statement 是领域语义的 Source of Truth；名称引用在读取时动态指向当前知识视图中的同名 Statement；不预设独立 Relation、Decision、Problem 等全局类型 |
| Artifact Domain（协作产物域） | 用户与 Agent 围绕 Attention 持续维护的 Artifact；不限定为 Markdown 或单一文件，可以是文档、配置、模板、代码、脚本、资产或它们的组合 | Artifact 具有独立身份、当前状态和修订生命周期，并接纳用户编辑；它不是知识真相源，不能自动回流知识；内容形式不改变它所属的权威域 |

本文将 `Artifact` 作为第三个权威域中单个协作产物的正式英文名称；观察中的来源侧对象使用 Activity Artifact 等限定名称，Discovery catalog 中的外部来源记录称为 Source Record。

Observation Preprocessing 发现的 Candidate 是带回源线索的待调查问题，不是事实、Statement 或知识变更决定。它们进入一次运行的开放调查清单，由 Knowledge Maintenance Agent 依据当前知识和 Raw Evidence 补充、合并、拆分或判定无需变更；Candidate 与 Statement 不要求一一对应。开放清单与 Contribution Draft 都是可丢弃的运行期工作材料（Run-local Working Material），不构成第四个状态与权威域。只有经过统一知识提交边界成为 Knowledge Statement 的内容才进入知识层。正式知识应能够追溯到原始观察或输入知识，但追溯结构及其 MVP 实现范围尚未确定。

三个域在状态和所有权上分离，但知识加工、Projection 和 Artifact 维护通过共享 Attention 耦合。Projection 是从知识、Attention 和必要的当前状态形成按需消费输出，或初始化、修订 Artifact 的活动，不是第三个持久状态域本身。同一个 Attention 可以指导 Observation Preprocessor、Knowledge Maintenance Agent 和通用管理 Agent；不同 Attention 产生的知识进入共享知识层并可以重叠、复用或相互修订，不按 Artifact 复制成独立真相。

Artifact 可以随用户 Attention 自然形成分组。是否把这种分组正式建模为 Project，以及它的身份和生命周期，仍是未决定事项；无论采用何种形式，Artifact 分组都不得把共享 Knowledge 分割成彼此隔离的真相。

当前 Artifact Repository MVP 已把最小载体确定为一个固定的本地标准 Git Repository：其中每个有效的一级目录就是一个 Artifact，根 `AGENTS.md` 表达该 Artifact 的持久 Attention，其他内部结构任意。APP 直接读取文件系统，当前以 Repository 相对路径作为身份，不增加 manifest、Artifact 类型或数据库镜像。Repository 由随 APP 捆绑的私有标准 Git Runtime 创建；APP 自身发起 Git 操作时使用绝对路径调用该 Runtime，不依赖系统 Git 或用户 `PATH`。这个实现不把目录或 Git 提升为长期领域本体；稳定 ID、正式分组类型、Artifact 间引用和依赖、版本同步、反馈协议及执行治理仍是可探讨方向。完整契约见[《Artifact Repository MVP》](artifact-repository-mvp.md)，长期问题见架构文档的“可探讨方向与未决定事项”。

外部 Agent 拥有原始记录的生命周期。记录变化、消失或权限被收回时，再次展开必须明确失败，不能静默改用相似来源。当前本地来源访问保留已使用的来源与版本身份；正式知识长期采用何种追溯结构留给治理设计。用户仍可删除 Oyster 持有的 catalog、索引、知识和其他派生数据。

域间与知识间关系的最小原则见[《知识加工、Projection 与 Artifact》](../architecture/knowledge-model-and-projection.md)。

## 6. MVP 用户流程

### 6.1 发现 Agent 和数据源

当前已落地的纵向切片见[《本地 Agent 发现与外部证据访问》](local-agent-discovery-mvp.md)、[《AI Backend MVP》](ai-backends-mvp.md)、[《知识加工验证 MVP》](knowledge-processing-mvp.md)、[《通用管理 Agent MVP》](chat-agent-mvp.md)和[《Artifact Repository MVP》](artifact-repository-mvp.md)。发现分为未读取聊天正文的被动候选检查，以及用户触发的有界扫描与 catalog 建立；知识加工可以直接选择一条可用 Session 运行完整测试链路；通用管理 Agent 用一套 Session 和常驻工具处理普通对话、Knowledge 与 Artifact；Artifact Repository 提供第三个权威域的最小持久载体。

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
4. 用户按 Agent、项目、时间或 Session 选择需要查看或加工的记录；
5. 主进程从原始位置读取该记录并固定本次使用的确定版本；
6. 如果来源已经变化或失效，系统拒绝本次读取并要求重新扫描 catalog，不回退到 Oyster 内部副本。

### 6.3 实时增量采集

用户显式安装或启用第一方 Connector 插件。插件在稳定生命周期边界通知 Oyster，例如 Turn Stop、Agent End、Compaction 或 Session End。通知只提供来源 ID、Session ID、游标或 transcript locator；Oyster 仍通过受控来源读取边界获取必要内容，不在命令行参数中传递完整聊天正文。

MVP 的“实时”定义为 **turn 级近实时**，不是 token streaming。插件离线或 Oyster 未运行时，后续扫描可以重新发现已落盘的历史记录；实时路径不另建一套外部历史复制模型。

### 6.4 构建和维护知识

用户为项目、Topic 或任务选择 Attention，并启动知识加工：

开始加工前，用户选择一个已配置且能力匹配的 AI Connection。数据来源与执行连接相互独立：从某个 Agent Harness 读取观察，不要求使用同一 Provider 进行知识加工。

1. 默认或自定义 Observation Preprocessor 从观察中发现带回源线索的 Candidate 问题，作为开放调查清单的初始内容，而不是生成 Session 摘要或拟定 Statement；
2. 默认或自定义 Knowledge Maintenance Agent 以开放清单和相关已有 Knowledge Statement 为起点，按需读取 Raw Evidence，补充并裁决问题；默认策略优先维护细粒度、持久且可复用的对象、概念及其关系理解，而不是生成 Session 总结或工作日志；
3. Agent 独立维护 Contribution Draft，并通过统一提交边界提出一条或多条 Knowledge Statement；Statement 使用当前知识视图中唯一、能够指称一个知识主体的 canonical title，以自由文本正文解释该主体的语境、含义、属性和关系，并通过 `[[canonical title]]` 或 `[[canonical title|local display text]]` 动态引用当前同名 Statement；
4. Oyster Core 统一执行权限、提交和生命周期边界；
5. 用户可以审查、纠正、删除或重新加工派生知识；如何向用户呈现其追溯关系随治理设计确定。

Knowledge Maintenance Agent 是一个普通、可替换的工具使用 Agent：角色差异来自 System Prompt、Workspace、授权工具和最终 Knowledge Contribution 协议，而不是专用状态机或固定运行步骤。系统不预设模型轮次、工具次数或总时长；通用 Agent Runtime 在上下文增长时负责压缩临时 transcript。模型的实际上下文、单次请求、分页读取和持久化完整性仍有各自的边界，最终结果仍由 Oyster Core 校验和提交；这些边界不变成整次 Agent 的行为配额。

任何默认或自定义处理器产生的正式知识都没有不同的本体身份。系统应能解释其如何由观察或输入知识形成，但具体需要保存哪些运行元信息、如何持久化以及 MVP 覆盖到什么程度，留给后续验证。模型、Prompt、策略或 Agent 升级时可以重新加工知识，不重写 Raw Evidence。

### 6.5 通用管理 Agent、Projection 与 Artifact

Projection 可以根据共享 Knowledge、Attention 和必要的当前状态生成按需消费输出，也可以初始化 Artifact，或基于当前 Artifact 形成新修订。用户可以直接创建或编辑 Artifact；Agent 后续修订以当前状态为输入并延续已接纳的编辑。Artifact 内容不会仅因存在而自动成为 Knowledge；通用管理 Agent 可以在同一对话中分别调用 Artifact 工具和 Knowledge 工具，对两个权威域作出明确修改。

Oyster 固定使用 `app.getPath('userData')/artifacts/` 标准 Git Repository；一个带可读取的普通根 `AGENTS.md` 的一级目录是一个 Artifact，`AGENTS.md` 表达持久 Attention，其余结构任意。UI 直接扫描和刷新文件系统、创建 Artifact、显示 Attention，并可在系统文件管理器中打开 Repository 或 Artifact；缺少或无法读取根 `AGENTS.md` 的可见一级目录会被明确显示为无效目录。Repository 通过捆绑 Git Runtime 的绝对路径初始化，系统 Git 不是前置条件。

所有通用管理 Agent Session 常驻 `read`、`edit`、`write`、`bash`、`search_knowledge`、`read_knowledge` 和 `upsert_knowledge`。四个 Coding 工具以 Artifact Repository 根作为初始 `cwd`，但这只是坐标起点：Session 不绑定 Artifact、Project 或目录，Harness 不建立 selector、router、Artifact 锁、路径权限边界、Shell 命令限制或 Bash 逐次审批。Agent 根据对话和文件系统识别相关的零个、一个或多个 Artifact，并读取各自根 `AGENTS.md`。文件与 Shell 工具以当前 OS 用户权限运行，因此这一 MVP 是高信任执行模型，不是安全隔离。

`bash` 的局部 `PATH` 提供 APP 捆绑的标准 Git CLI，Agent 使用普通 `git` 命令，不增加专用 Git Tool。Harness 不自动 commit、branch、worktree、rollback、merge 或处理冲突，但也不通过命令限制阻止 Agent 根据当前任务使用 Git。当前计划中的 Context Packet 仍按临时消费视图处理，不与 Artifact 共用持久身份和修订生命周期；未来能否将其提升为 Artifact 仍待验证。具体范围见[《Artifact Repository MVP》](artifact-repository-mvp.md)与[《通用管理 Agent MVP》](chat-agent-mvp.md)。

### 6.6 检索和供给上下文

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
- 提供至少一个可替换的默认 Attention、Observation Preprocessor 和受控 Knowledge Maintenance Agent，优先维护细粒度、持久且可复用的对象与概念理解；任务事件只在形成这类理解或 Attention 明确要求时保留，且不将其固化为核心本体；
- 默认和自定义知识处理器遵循统一的知识提交与权限边界；
- 用户审查、纠正、删除和重新加工；
- 可替换的 AI Connection；首个实现支持 Codex Coding Plan 与 OpenAI-compatible API，并允许每个加工阶段独立选择 Connection、Model 和思考强度；
- Oyster 接收的 API Key 与主动完成 OAuth 后获得的 Coding Plan 凭据进入系统 Keychain；不扫描、读取或复制其他 Agent Runtime 的凭据；
- 本地 MCP Server 提供检索与有预算的 Context Packet；
- 当前验证所需的用户可见运行与结果信息；
- 固定 `userData/artifacts/` Artifact Repository 的初始化、扫描、刷新、创建和系统打开入口；以带根 `AGENTS.md` 的一级目录作为当前 Artifact 最小单元，并明确展示无效目录；
- 随 APP 捆绑私有标准 Git Runtime，APP 通过绝对路径调用它并在没有系统 Git 时仍能初始化标准 Repository；
- 一个跨普通对话、Knowledge 与 Artifact 的通用管理 Agent；所有 Session 常驻七项工具，Session 不绑定 Artifact、Project 或 `cwd`；
- Coding 工具从固定 Artifact Repository 根开始，以当前 OS 用户权限运行；Harness 不增加路径 Sandbox、Bash 审批、Artifact selector/router/lock 或专用 Git Tool。

正式知识可追溯是一项产品原则，但其持久形式、校验方式和 MVP 验收范围尚未确定；在形成独立决策前，不把它展开为固定字段或流程要求。

Observation、Knowledge 与 Artifact 保持不同的权威边界。由同一个通用管理 Agent 同时拥有 Knowledge 与文件工具，不会把它们合并成同一种状态。按范围生成的临时消费输出、运行期工作材料和调试快照不会因此自动成为 Artifact。

### 明确不做

- 完整浏览器 Shell；
- 自动修改所有 Harness 的全局配置；
- token 级实时镜像；
- 在没有用户动作时读取所有本地聊天正文；
- 默认云同步或团队共享；
- Artifact 专用 Agent、Artifact/Project Session 绑定、selector/router/lock 和专用 Git Tool；
- Harness 自动执行的 Git commit、branch、worktree、diff 审核、merge、rollback 和冲突处理；
- 把派生知识自动写回 `AGENTS.md`、`CLAUDE.md` 等项目文件；
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

Source Adapter / Connector 只拥有发现、定位、版本校验、读取、解析和来源游标。它以引用方式提供 Raw Evidence，并可以产生 Canonical Activity，但不能复制外部历史、创建 Knowledge Contribution、运行 Knowledge Maintenance Agent，也不能绕过权限将数据发给 LLM。Observation Preprocessing、Agent 运行、Scope、审查、删除和供给由 Oyster Core 统一拥有。

MVP 只内置和签名第一方 Connector。未来第三方 Connector 必须在独立进程中运行，使用显式文件范围、本地网络范围和版本化协议；Harness 插件通常拥有与 Agent 相同的本机权限，安装前必须展示这一风险。

## 9. AI 执行能力在产品中的职责

Oyster 把认证和计费通道与处理 Runtime 分开：

- **Coding Plan / API Backend** 决定凭据、Provider、传输和额度来源；
- **Connection** 是用户实际配置并授权的一条通道，可以暴露多个 Model；
- **Stage Configuration** 固定某个阶段使用的 Connection、Model 和可选思考强度；
- **Runtime** 决定该阶段做一次直接生成，还是用同一模型驱动通用 Agent loop，并负责 Agent 的上下文生命周期。

因此，Coding Plan 与 API 可以共享最小模型调用契约，同时仍保留各自不同的认证和计费语义。结构化知识加工链路中的 Knowledge Maintenance Agent 使用该次 Workspace 和 Contribution 协议；面向用户的通用管理 Agent 则在每个 Session 中常驻同一组 Knowledge、文件与 Shell 工具。二者可以共用负责模型—工具循环和上下文压缩的 Runtime，但通用管理 Agent 不再按当前职责动态切换工具或身份。Oyster 可以发现官方 Agent Runtime 中可公开读取的账号与套餐信息，但不会把该 Runtime 的内部 Agent loop 或凭据当作业务执行接口。

LLM 适合承担：

- 在 Observation Preprocessor 中有界发现需要回到 Raw Evidence 调查的名称和指代问题；
- 驱动受控 Knowledge Maintenance Agent 多步搜索、核查、复用和维护共享知识；
- 驱动通用管理 Agent 在普通对话、Knowledge 与一个或多个 Artifact 之间自主选择必要工作；
- 通过 Projection 活动，基于当前 Artifact 做局部修订；
- 通过 Projection 活动为一次查询构建带引用、可丢弃的 Context Packet。

LLM 和 Agent 都不拥有事实真相，其输出在进入知识层前必须经过统一提交边界。正式知识应能够追溯到原始观察或输入知识；加工运行需要保存哪些元信息、采用何种状态模型，以及当前 MVP 覆盖到什么程度，尚未决定。

基础发现、catalog 浏览、来源读取、删除和导出不得依赖在线 LLM 才能工作。

## 10. 安全与隐私底线

- 通用管理 Agent 的文件与 Shell 工具当前以 APP 的 OS 用户权限运行，不提供路径 Sandbox 或逐次命令审批；Artifact Repository 根只是初始 `cwd`，不能表述为权限或安全边界；
- Agent 工具读取的本机内容可能进入当前所选模型 Provider 的上下文；产品界面应如实表达这一高信任执行后果，但不把允许/禁止清单塞入 Agent System Prompt；
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

在 MVP 证明来源访问可靠性、知识质量和检索价值后，再依次考虑：

1. 更多 Harness、IDE、Issue Tracker、文档和浏览器来源；
2. SessionStart/UserPrompt 等生命周期的可审查 Context Push；
3. 项目规则文件的用户审查式导出，而非自动覆写；
4. 本地或远程同步、多设备和团队 Scope；
5. 用真实案例验证当前目录式 Artifact、路径身份、自然分组和跨 Artifact 协作需求；
6. 验证通用管理 Agent 能否在不绑定 Project 或 Artifact 的情况下，根据对话、目录和 `AGENTS.md` 正确维护零个、一个或多个 Artifact；
7. 更深入的跨项目冲突清理、过期检查和关系建议；
8. 受控任务执行与 Agent Browser；
9. 基于历史失败的提醒或策略 Gate。

任何新增能力都必须继续服从两个判断：它是否提高知识与 Artifact 的实际可用性；它是否基于已经观察到的问题，而不是在 Harness 中提前固化模型可以自行完成的判断。
