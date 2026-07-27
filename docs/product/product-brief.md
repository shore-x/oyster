# Oyster Product Brief

> 状态：当前产品定位（source of truth）
>
> 日期：2026-07-26
>
> 决策记录：[ADR-0001：将 Oyster 定位为 Agent-Agnostic Knowledge Hub](../decisions/0001-agent-agnostic-knowledge-hub.md)
>
> 知识模型原则：[知识加工与协作式投影](../architecture/knowledge-model-and-projection.md)
>
> AI 运行后端：[AI Backend MVP](ai-backends-mvp.md)

## 1. 一句话定位

Oyster 是一个独立于 Claude Code、Pi、Codex 等 Agent Harness 的、本地优先的跨 Agent、跨项目知识库维护中心：它接入异构 Agent 活动，保留可核查的出处身份，将其加工为可检查、可修订、可检索的知识，并按授权向第三方 Agent 提供搜索与上下文。

受控的 Knowledge Maintenance Agent 是 Oyster 的知识加工能力。浏览器、通用任务 Agent 和执行能力可以成为数据源或消费者，但不定义产品身份。

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

Oyster 向用户提供四个核心能力：

1. **发现与接入**：发现本机 Agent 的可执行程序、应用、配置和数据目录，明确展示每个来源支持历史访问、实时通知或上下文输出中的哪些能力。
2. **保真访问**：为聊天 transcript 与人类编写的 Agent 指令建立轻量 catalog，并在需要时由 Source Adapter 从原始位置读取确定版本；不同 Harness 的原始格式不因统一模型而丢失，Agent 自动生成的 memory 不作为历史来源。
3. **知识加工**：用 Observation Preprocessing 降低原始活动噪声，再由受控 Knowledge Maintenance Agent 在用户 Attention 下探索现有知识、形成带出处且可修订的理解；默认和自定义处理器使用同一 Knowledge Contribution 契约。
4. **安全供给**：通过本地 API 和 MCP 等开放边界向第三方 Agent 提供检索；未来可在用户授权、Scope 和 Token Budget 内生成并注入 Context Packet。

## 4. 产品身份与边界

Oyster 是：

- Agent-agnostic 的个人知识基础设施；
- 本地 Agent 活动的可检查数据层和控制面；
- 外部历史的出处 catalog，以及内部标准化事件和派生知识的长期所有者；
- 跨项目、跨仓库路径和跨 Harness 的关系维护者；
- 通过 Observation Preprocessor 和受控 Agent 共同维护知识、但不把模型输出自动当作真相的系统；
- 未来可承载通用任务 Agent、浏览器和执行能力的平台。

Oyster 不是：

- 某个 Agent 的聊天客户端或历史记录查看器；
- 只提供向量搜索的 Memory MCP Server；
- 将全部聊天无差别上传云端的遥测系统；
- 默认把所有历史自动塞入每次 Prompt 的上下文注入器；
- 以替代 Chrome 为目标的浏览器；
- 首个版本就承担多用户数据湖、企业治理或自主 Agent 编排的平台。

## 5. 核心领域分层

Oyster 必须把三个认识论层次分开，避免把模型总结覆盖到原始事实之上。现有 Raw Evidence 与 Canonical Activity 是观察层的两个子层，不是额外的认识论层：

| 层次 | 内容 | 规则 |
| --- | --- | --- |
| 观察层 | 由来源与版本身份指向的 Raw Evidence，以及可重建的 Session、Message、Tool Call/Result 等 Canonical Activity | 外部原文按需读取，确定性视图可重建；不得把模型解释伪装成来源事实 |
| 知识层 | 从观察或已有知识形成的 Knowledge Statement，以及它们之间可修订的关系 | 允许多个解释和多级抽象；不预设 Decision、Problem 等为全局类型 |
| 投影层 | 持久 Markdown 协作文档，以及按需生成的临时 Context Packet | 持久文档由知识和 Attention 初始化，再由用户与 Agent 共同维护；更新必须基于当前文档，不得全量重建并覆盖人工编辑。临时消费视图不要求持久化 |

Observation Preprocessing 产生的 Evidence Map 不构成第四个认识论层次。它是一种只供后续运行、可随时重算且不直接对外提供的 Working Artifact；如果某个处理器要把其中内容变为可持久检索、引用或进一步推理的知识，必须通过 Knowledge Contribution 提交为 Knowledge Statement，并保留出处、接受统一治理。

三层在状态和所有权上分离，但知识加工与投影通过共享 Attention 耦合。同一个 Attention 可以指导 Observation Preprocessor、Knowledge Maintenance Agent 和 Projection Agent；不同 Attention 产生的知识进入共享知识层并可以重叠、复用或相互修订，不按投影复制成独立真相。

外部 Agent 拥有原始记录的生命周期。记录变化、消失或权限被收回时，Oyster 保留已使用来源与版本的身份；再次展开失败必须明确暴露，已有知识不能因此假装仍可核查，也不能静默改用相似来源。这个语义不要求额外持久化记录级可用性字段。用户仍可删除 Oyster 持有的 catalog、索引、知识和其他派生数据。

层间与知识间关系的最小原则见[《知识加工与协作式投影》](../architecture/knowledge-model-and-projection.md)。

## 6. MVP 用户流程

### 6.1 发现 Agent 和数据源

当前已落地的纵向切片见[《本地 Agent 发现与外部证据访问》](local-agent-discovery-mvp.md)、[《AI Backend MVP》](ai-backends-mvp.md)和[《知识加工验证 MVP》](knowledge-processing-mvp.md)。发现分为未读取聊天正文的被动候选检查，以及用户触发的有界扫描与 catalog 建立；知识加工可以直接选择一条可用 Session 运行完整测试链路。

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

1. 默认或自定义 Observation Preprocessor 对观察进行分段、裁剪、Redaction、索引和有界摘要，生成保留原始定位、可丢弃、可重算且可回源的 Evidence Map；
2. 默认或自定义 Knowledge Maintenance Agent 以 Evidence Map 和相关已有 Knowledge Statement 为起点，多次搜索和比较，必要时从地图给出的位置渐进读取最小原始证据；默认策略优先维护细粒度、持久且可复用的对象与概念理解，而不是生成 Session 总结或工作日志；
3. Agent 通过 Knowledge Contribution 提出对一条或多条 Knowledge Statement 的创建、补充、限定、修订或并列保留；
4. Oyster Core 统一执行 Scope、出处、审计、持久化和删除规则；
5. 用户可以检查来源，接受、修改、拒绝、固定、删除或重新加工派生知识。

Knowledge Maintenance Agent 是一个普通、可替换的工具使用 Agent：角色差异来自 System Prompt、Workspace、授权工具和最终 Knowledge Contribution 协议，而不是专用状态机或固定运行步骤。系统不预设模型轮次、工具次数或总时长；通用 Agent Runtime 在上下文增长时负责压缩临时 transcript。模型的实际上下文、单次请求、分页读取和持久化完整性仍有各自的边界，最终结果仍由 Oyster Core 校验和提交；这些边界不变成整次 Agent 的行为配额。

任何默认或自定义处理器一旦产生 Knowledge Contribution，就没有不同的本体身份，但必须保留处理器、Attention、输入依赖和版本。模型、Prompt、策略或 Agent 升级时可以重新加工派生的 Knowledge Statement，不重写 Raw Evidence。

持久投影文档允许用户直接编辑，也允许 Projection Agent 基于当前文档、共享知识和 Attention 形成新修订。Projection Agent 发现知识不足时可以提出 Knowledge Need，交由 Knowledge Maintenance Agent 继续探索；它不能把当前 Markdown 自动回流为世界事实。临时 Context Packet 不需要持久文档的协作生命周期。

### 6.5 检索和供给上下文

对外检索保持只读优先，并从以下最小能力逐步开放：

- `search_knowledge`：按 query 分页发现当前 Knowledge Statement；
- `get_knowledge`：按稳定身份读取一条不可变 Statement、出处和直接关系；
- `get_evidence`：在权限允许时读取最小必要的原始证据；
- `build_context`：按目标、Scope 和 Token Budget 生成带引用的 Context Packet。

默认采用 Agent 主动查询的 Pull 模式。自动 Push 注入属于后续能力：它需要可解释的选择理由、严格的项目/身份 Scope、敏感信息过滤和用户可见的注入记录。

## 7. MVP 范围

### 必须完成

- macOS 上发现 Claude Code、Pi、Codex 的数据源；
- 三个第一方 Source Adapter 的历史发现、版本校验和原地按需读取；
- 统一的 Connector Plugin API 与版本化 Capability Manifest；
- 三个 Harness 的 turn/session 级实时增量采集路径；
- 观察、知识、投影三层职责分离；观察层继续保留 Raw Evidence 与 Canonical Activity 两个子层；
- 可重复的 catalog 扫描，以及来源变化、移动、删除和权限失效的确定行为；
- 项目/会话 catalog 浏览、基础筛选和出处可用性展示；
- 提供至少一个可替换的默认 Attention、Observation Preprocessor 和受控 Knowledge Maintenance Agent，优先维护细粒度、持久且可复用的对象与概念理解；任务事件只在形成这类理解或 Attention 明确要求时保留，且不将其固化为核心本体；
- 默认和自定义知识处理器遵循统一的 Knowledge Contribution、出处、Scope 和审计契约；
- 用户审查、纠正、删除和重新加工；
- 可替换的 AI Connection；首个实现支持 Codex Coding Plan 与 OpenAI-compatible API，并允许每个加工阶段独立选择 Connection、Model 和思考强度；
- Oyster 接收的 API Key 与主动完成 OAuth 后获得的 Coding Plan 凭据进入系统 Keychain；不扫描、读取或复制其他 Agent Runtime 的凭据；
- 本地 MCP Server 提供检索与有预算的 Context Packet；
- 发现、读取、加工、检索、供给和删除的审计记录。

### 明确不做

- 完整浏览器 Shell；
- 自主完成复杂任务的通用内置 Agent；
- 自动修改所有 Harness 的全局配置；
- token 级实时镜像；
- 在没有用户动作时读取所有本地聊天正文；
- 默认云同步或团队共享；
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

因此，Coding Plan 与 API 可以共享最小模型调用契约，同时仍保留各自不同的认证和计费语义。Knowledge Maintenance Agent 与 Projection Agent 的角色和工具权限由 Oyster 当前运行授予，不由 Backend 类型隐式扩大；它们可以共用负责模型—工具循环和上下文压缩的通用 Runtime。Oyster 可以发现官方 Agent Runtime 中可公开读取的账号与套餐信息，但不会把该 Runtime 的内部 Agent loop 或凭据当作业务执行接口。

LLM 适合承担：

- 在 Observation Preprocessor 中承担语义分段、局部摘要、实体和关系候选；
- 驱动受控 Knowledge Maintenance Agent 多步搜索、核查、复用和维护共享知识；
- 驱动 Projection Agent 基于当前文档做局部修订；
- 为一次查询构建带引用的 Context Packet。

LLM 和 Agent 都不拥有事实真相。每个加工 Job 必须保存输入 Evidence/Knowledge ID、Attention、处理器与算法版本、Prompt 版本、所使用的 Backend/Connection、时间和输出，并在可获得时记录实际 Provider、Runtime 与模型信息；模型输出默认为候选或推断，只有用户明确内容或用户审查后的内容才可提高状态。

基础发现、catalog 浏览、来源读取、删除和导出不得依赖在线 LLM 才能工作。

## 10. 安全与隐私底线

- 默认本地保存，任何远程模型处理都按 Provider 和 Scope 显式授权；
- 任何远程加工都必须明确显示所选 Connection、数据目的地和计费来源，不在连接之间静默切换；
- Coding Plan 的 Browser / Device Code 登录和 Token 刷新由 Oyster 通过受支持 Provider 的 OAuth 完成，凭据仅存系统 Keychain；Oyster 不读取或复制其他应用的凭据文件、Keychain 项或浏览器会话；
- API 密钥只由主进程从系统钥匙串读取，不返回 Renderer，不进入数据库、日志、Workspace 或模型输入；
- 首次读取正文前预览目录、范围和风险，不后台读取全部聊天正文后再征求同意；
- 原始聊天可能包含源码、凭证、个人信息和工具输出，按高敏数据处理；
- 日志仅记录 ID、状态和脱敏诊断，不记录正文、Prompt 或凭证；
- 远程加工前执行 Secret/PII 检测与可见的 Redaction；
- 数据库、对象和索引遵守最小文件权限；静态加密方案必须在实现前通过 Spike 确认；
- 搜索、MCP 和 Context Packet 都执行相同的 Scope 与敏感级别策略；
- Connector 读取权限和 Context Consumer 读取权限分开管理；
- 用户可查看某条知识何时被哪个 Agent 查询或注入；
- 用户解除来源后，Oyster 删除自身持有的 locator、索引、缓存和待执行 Job，不修改外部 Agent 的原始文件；知识出处保留当时的来源身份并在无法展开时明确失败，或随用户明确删除知识而移除。

## 11. 产品指标

### MVP 成功指标

- 发现准确率：测试机上的目标 Agent 数据源无漏报，误报可解释；
- 来源读取正确性：Fixture 中选中的记录按确定版本读取，且 Oyster 不建立正文副本；
- 变化处理：文件追加、截断、移动、删除和权限失效都有确定行为，不静默切换版本；
- 实时延迟：完成 turn 后正常路径数秒内可检索，离线后可补采；
- 知识质量：用户接受/轻微编辑率、错误 Claim 率和出处完整率可量化；
- 知识维护：Agent 能复用相关已有知识，重叠知识、无来源自我引用和不必要重写可量化；
- 检索质量：在真实跨 Agent 问题集上测 Recall@k、引用正确率和 Token 成本；
- 用户价值：减少重新解释背景的次数和耗时，减少重复失败尝试；
- 隐私：Fixture 中的测试凭证不进入日志、远程请求或未授权 Context Packet。

## 12. 后续方向

在 MVP 证明来源访问可靠性、知识质量和检索价值后，再依次考虑：

1. 更多 Harness、IDE、Issue Tracker、文档和浏览器来源；
2. SessionStart/UserPrompt 等生命周期的可审查 Context Push；
3. 项目规则文件的用户审查式导出，而非自动覆写；
4. 本地或远程同步、多设备和团队 Scope；
5. 安装和授权自定义 Observation Preprocessor、Knowledge Maintenance Agent 与 Projection Agent；
6. 更深入的跨项目冲突清理、过期检查和关系建议；
7. 受控任务执行与 Agent Browser；
8. 基于历史失败的提醒或策略 Gate。

任何新增能力都必须继续服从两个判断：它是否提高知识的可复用性；它是否保持出处、权限和用户控制。
