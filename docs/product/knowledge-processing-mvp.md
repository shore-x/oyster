# 知识加工验证 MVP

> 状态：当前实现规格
>
> 日期：2026-07-30
>
> 范围：验证“外部 Session 的确定版本 → Candidate 发现 → 通用 Todo 驱动的 Knowledge Maintenance Agent → Host 冻结 Knowledge Contribution → 隔离 Knowledge Sandbox 写入与回读”的最小闭环，以及测试结果的本地复盘与显式导入。Sandbox 不代表正式知识生产。

## 1. 两种运行方式

“加工测试”页面默认提供 **Sandbox 链路测试**：

```text
可用外部 Session 的确定 Raw Evidence revision
  -> Source Adapter 生成的确定 Observation View
  -> Observation Preprocessor 分段发现 Statement Candidate
  -> Host 将 Candidate 格式化为 initial Todo + 可回源 Workspace
  -> Knowledge Maintenance Agent 完成 Todo 并维护 Draft（当前由 Pi Agent Core 实现）
  -> 运行期 Contribution Draft
  -> Todo 全部完成且 Agent 自然结束
  -> Host 冻结为包含多条自由文本 Statement 的 Knowledge Contribution
  -> Oyster Core 校验并原子写入独立 SQLite Knowledge Sandbox
  -> 从 Sandbox 按 canonical title 回读 Statement
```

用户从 discovery catalog 选择 Session 及其当前版本。运行时，主进程通过对应 Source Adapter 从原始位置读取该 Source Record，并以稳定的 Source Record 身份和实际内容哈希固定本次使用的 `sourceRef`；扫描后已经变化或失效的记录会被拒绝，不会静默切换。Reader 不为单个 Session 预设产品长度上限，也不会把记录复制进应用管理的数据目录。Claude、Pi 与 Codex Adapter 分别按自身历史格式生成带版本的 Observation View；它们负责确定性选择对话主线、折叠可按需展开的执行详情，并为每个模型可读单元保留原始全局 `L` 行号、超长单行的 `Cstart:end/total` 窗口和必要的格式语境。共享文本原语只保证 Unicode 与 UTF-8 字节边界，不理解任何 Agent 的 JSONL Schema。通用 planner 只按所选模型预算组合 Adapter 已生成的单元，不以物理 JSONL 行作为调用边界。分段数、预处理调用数和整次运行时间不设固定上限，实际工作量随选择后的材料增长，用户可以随时取消。未进入预处理视图的原文没有被截断或删除，仍可由维护 Agent 按需回源。

页面同时保留独立的**高级调试**工作面，用于分别观察预处理器和维护 Agent 的行为。它以阶段为主要切换层级，并在同一工作面直接呈现配置、输入、运行过程和输出，不再为这些内容继续嵌套页签。预处理调试默认直接选择一条 catalog 中可用的 Session；手工粘贴只作为排查特殊输入的显式 fallback。两个阶段分别触发，其 Knowledge Contribution 只用于预览，不提交到任何 Knowledge Store。每次实际启动的运行都会生成 Debug Trace：预处理展示输入规模、总分段、每次 Candidate 发现调用的状态和输出；维护阶段展示 Todo 的完成状态、Contribution Draft 的最新规模、模型轮次和工具活动。独立阶段调试只在内存中保留最近一次轨迹；成功的完整链路会把有界轨迹连同结果保存为本地测试快照。原始行号、内部运行 ID、版本指纹与本地路径不作为常规用户界面信息展示。

运行按钮是显式启动操作，不再叠加系统原生确认弹窗。页面在启动前展示所选 Connection、Model、目的地和输入，在启动后持续展示发送影响、阶段进度、模型调用与错误；长 Session 可能产生多次预处理调用，模型调用可能消耗额度或产生费用。成功结果分别展示两个阶段成功完成的 `modelCallCount`；失败或取消前已经发起的请求仍可能计费，当前结果计数不作为 Provider 账单。

## 2. Knowledge Sandbox

**Knowledge Sandbox** 是当前验证 Store 的一次物理隔离快照，使用相同的 SQLite Schema 和读写实现。完整链路开始时，Oyster Core 先创建独立 Sandbox，再把本次运行绑定到该 Store：Knowledge Maintenance Agent 可以搜索其基线知识，但不能选择、切换或感知其他写入目标。SQLite 只是当前 MVP 的验证介质，不决定正式知识层最终使用数据库还是本地文件。

这里的 Sandbox 只表示知识加工测试使用隔离的目标 Store，不是文件系统或 Shell Sandbox，也不适用于通用管理 Agent 的 Coding 工具。

Agent 在运行内维护 Contribution Draft；当它正常自然结束时，Host 冻结整份 Draft 为一份结构化 Knowledge Contribution，其中可以包含多条 Knowledge Statement。Statement 使用当前知识视图中唯一、能够以专名、术语或自然名词短语指称一个知识主体的 canonical title；标题不概括场景或结论，主体的语境、含义、属性和关系由 Markdown 兼容的自由文本正文表达。目标知识模型允许正文使用 `[[canonical title]]` 或 `[[canonical title|local display text]]` 表达任意多元关系；名称在读取时动态指向当前知识视图中的同名 Statement，不永久绑定写作时的记录。

当前 SQLite Sandbox 采用最小的 Statement 读写模型：

- canonical title 是 Agent 可见的唯一读写键。一次 Contribution 内的 title 不得重复；提交时没有同名 Statement 就创建，已有同名 Statement 就原地覆盖正文；
- Sandbox 只维护当前 Statement 视图，不保存历史。Statement 的生命周期与历史如何治理尚未决定，不属于当前 MVP。

Core 在一个事务中按 title 写入整份 Contribution，再回读实际 Statement 供 UI 展示。正文中的名称引用原样保存，Agent 可以使用引用中的 canonical title 继续精确读取对应 Statement。持久 Store 不保存边；知识浏览 Projection 在读取时解析当前知识视图中的名称引用，并派生局部多跳节点、原始方向边与未解析引用。派生结果只服务浏览，不回写 Store，也不成为第二份权威关系。

Sandbox 的写入不会自动影响正式知识库。失败或取消会丢弃本次 Sandbox；成功重跑会用同一正式知识基线创建新的 Sandbox，并替换当前运行持有的旧 Sandbox。应用启动时会清理上一次进程遗留的 Sandbox。

每次成功的完整链路另存为自包含、不可变的本地测试快照。快照保存所选 Session 的识别信息、两个阶段当时生效的配置、预处理 Candidate、Maintainer Todo、最终 Statement 和有界 Debug Trace，不依赖临时 Sandbox 或外部 Session 继续存在。历史列表只读取轻量摘要，结果与调用轨迹在打开二级页时按需加载。快照是调试材料，不构成新的状态与权威域。

用户可以从当前结果或任意历史快照显式导入正式知识库。当前 MVP 直接取快照中的最终 Statement，以 canonical title 为键在一个事务中写入：不存在的名称创建，已有的名称覆盖正文，不执行冲突判断、自动合并或隐式同步。重复导入同一次结果也是合法操作。这个入口只用于早期验证，不等同于已经设计了正式知识加工调度链路。

“知识库”是当前持久知识的独立浏览入口，提供标题与正文搜索、Statement 列表、完整正文回读和局部引用图。局部图的当前 MVP 见[《Statement 局部引用图 MVP》](knowledge-local-graph-mvp.md)；它是可替换的浏览界面，不属于知识模型原则。它与仅展示单次 Sandbox 输出的“加工测试”保持明确边界。“清空知识”也只位于知识库页面：经应用内确认弹窗授权后，原子删除基线 Store 中全部 Statement 及 Contribution 记录，并清理当前进程持有的 Sandbox；该操作与任何知识加工运行互斥，且不可撤销。

## 3. 两个加工阶段

### Observation Preprocessor

预处理器接收 Source Adapter 已生成的选择性 Observation View，按全局原始行号组织单元，但不理解 Claude、Pi 或 Codex 的 JSONL schema，也不自行判断特定 Harness 的记录类型。来源适配器让视图以人类与 Agent 的语义消息为主，保留发现局部名称所需的最小语境，并避免运行时注入指令、遥测和常规工具执行占据上下文；它可以按各 Harness 的实际记录形式保留少量疑似 Skill 激活线索，供默认预处理模型定位相关 Raw Evidence。该线索不是激活成功、效果或知识价值的事实，不形成独立统计、持久索引或跨 Harness 的正式事件模型；省略的记录仍保留在 Raw Evidence 中供 Agent 回读。

预处理器按所选模型的上下文预算对视图分段，每段进行一次 Candidate 发现调用；分段数、调用数和整次 Session 长度不设固定上限。相邻材料只用于解释边界处的连续指代，不增加该段的发现范围。各段结果直接汇入本次运行的初始 Candidate 清单，不再生成 Session 摘要、递归地图或导航归并层。

每次调用返回严格的 Statement Candidate Batch。每个 Candidate 只包含：

- 原文中实际出现的名称或表达；
- 一个说明需要调查什么、并带最小消歧语境的问题；
- 至少一个指向 Raw Evidence 的起始位置。

Candidate 是开放的调查问题，不是拟定的 canonical title、Statement 或事实。预处理器不负责判断是否应创建知识，也不强制合并看似重复的称呼。Host 把每个 Candidate 的表达、问题和证据起点格式化为一条普通 initial Todo；后续 Agent 通过增加或完成 Todo 扩展调查工作，不维护另一份 Candidate 状态。Candidate 与最终 Statement 仍是多对多关系，也允许调查后不产生任何 Statement。

当前 **EvidenceLocation** 使用从 1 开始的 `line` 和从 0 开始、以 UTF-16 code unit 计量的行内 `offset`。它只是当前 Observation Workspace 中 `read_evidence` 的起点，不属于 Statement 格式，也不决定正式知识如何保存追溯信息。知识判断所依据的观察内容仍是该位置指向的 Raw Evidence，而不是 Candidate 问题或选择性 Observation View。

选择 Session 时，Renderer 只提交 catalog 中的稳定身份和所选版本标识；主进程经 Source Adapter 解析内部 locator、校验版本并从原始位置读取原文。Workspace 在本次进程中保留所选版本的原文内存快照与 Candidate 清单，使 Agent 能从位置开始有界读取；`read_evidence` 返回原始格式文本、实际范围、下一 EvidenceLocation 和 `eof`。该快照不形成长期副本，Workspace 已绑定唯一 `sourceRef` 和 revision，模型不能切换来源。

正式运行和测试运行共用这一读取路径，不建立测试专用 Observation 副本。外部记录在运行结束后可能变化或消失；再次读取失败必须明确暴露，不能改读新版本。正式知识长期如何保存追溯信息仍待决定。

### Knowledge Maintenance Agent

Knowledge Maintenance Agent 是普通、可替换的工具使用 Agent，当前由 `@earendil-works/pi-agent-core` 提供通用 Agent Runtime。Oyster 只定义 System Prompt、Workspace、阶段固定的模型、授权工具和 Host 对正常运行结束的解释；Runtime 负责模型—工具循环与上下文生命周期。知识维护不依赖固定推理步骤、模型轮次、工具调用次数或总运行时长。

Host 在一次运行中持有两份可丢弃的运行期状态：通用 Agent Todo Store 跟踪尚未完成的工作，Contribution Draft 则按 canonical title 保存拟写入的 Statement 草稿。完成 Todo 不会自动产生 Statement，修改 Draft 也不会自动完成 Todo；多个 Todo 可以支持一条 Draft，一条 Todo 也可以导致多条 Draft，或者在调查后不产生知识变更。

Todo Store、Draft 和来源授权由 Host 持有，不依赖 transcript 或压缩摘要。Host 不在每次 LLM 调用前自动附加 Todo 或 Draft 快照；Agent 使用通用 Todo 工具和 Draft 读取工具按需取得完整状态。上下文压缩只管理模型 transcript，不负责复制或重建这些 Host 状态。

默认 Agent 优先解析对话中具有局部含义的名称和指代，再维护关于这些对象或概念的细粒度、持久且可复用的理解，包括含义、定义、属性、约束、区别、关系、修正、否定边界和明确的长期偏好。它会用原始称呼、别名和语境限定词搜索已有知识，并在创建或覆盖前读取可能具有相同语义焦点的 Statement。若当前知识缺少理解 Contribution Draft 中拟写 Statement 所必需的背景，Agent 会继续搜索，并在同一 Contribution 中创建或补全相关背景 Statement，再用正文引用使它们互相解释。这里不增加固定 Entity 或 Relation Schema；“实体”只是默认选择知识的启发式。一个 Statement 默认围绕一个连贯且可独立理解的语义焦点，也可以通过正文中的显式名称引用表达任意多元关系；关系型 Statement 不能取代其中具有项目局部含义的参与者各自所需的解释。Statement 的 canonical title 和正文必须使用具有实际区分力的自然语言，不使用机械编号或枚举关系代替语义。除非 Attention 明确要求任务历史，或某个事件本身形成了可复用理解，Agent 不把 Session 总结、时间线、工作日志、工具调用、文件改动、测试过程和短期结果作为默认知识。

知识维护不以最小改动为目标，也不对搜索、读取、工具调用或一次 Contribution 中涉及的 Statement 数量设置固定配额。Agent 根据相关性自行决定需要探索和修改的范围，目标是让本次涉及的知识邻域处于连贯、可互相解释的状态；普通常识、无关主题和不具持久价值的细节不因此被扩张为知识。

当前工具按四类职责组织：

- 当前知识：`search_knowledge` 按标题和正文文本分页发现 Statement，`read_knowledge` 按完整 canonical title 精确读取；
- Contribution Draft：`upsert_contribution_statement` 按 title 暂存或替换草稿，`read_contribution_statement` 与 `list_contribution_statements` 回读，`remove_contribution_statement` 移除草稿；
- 原始证据：`read_evidence` 从 Todo 中的位置开始有界读取 Raw Evidence，并返回 continuation；
- 通用工作清单：`list_todos`、`add_todos` 和 `complete_todos` 由所有内置工具使用 Agent 共享。

预处理 Candidate 和其他 Host 指定的工作都可以在启动时独立绑定为 Todo，但不会作为消息或每轮上下文注入。具体语义见[《通用 Agent Runtime》](../architecture/agent-runtime.md)。

只要仍有 pending Todo，Agent 的正常自然结束就会被 Runtime 拒绝，内部 Follow-up 说明当前不能结束的原因并再次唤起同一 Agent。当 Todo 全部完成且 Agent 自然结束后，Host 把整份当前 Draft 冻结为本次 Knowledge Contribution；如果调查后不需要知识变更，Draft 可以为空。没有专用 submit 工具，也没有 Candidate resolution 记录。Provider error、用户取消和 aborted turn 不会被强制续跑。

完整链路把知识读取和 Host 冻结后的 Contribution 绑定到 Sandbox；阶段调试使用同一 Agent Runtime、Todo Store 和 Draft，但只返回 Contribution 预览，不执行 Sandbox 写入。知识工具按 canonical title 读取当前 Statement；正文中的 `[[canonical title]]` 本身就是继续读取相关知识的键，领域关系仍由正文表达。`read_evidence` 只读取本次运行已经授权的唯一 Raw Evidence 来源。

Knowledge Maintenance Agent 的 Debug Trace 按模型轮次记录有界的模型输出、工具名称、工具输入与工具结果，并附带 Todo 总数、pending 与 completed 数量、Draft 数量和证据读取 continuation，便于逐次调试 Agent 行为。证据读取结果可能包含原始材料，因此轨迹只保存在本机并在界面中明确提示；thinking/reasoning、完整模型上下文、凭据和本地来源路径不进入轨迹。读取失败只展示来源失效、位置无效、预算等安全错误类别。Todo、Contribution 和 Sandbox Statement 由各自的结构化结果视图展示，不依赖轨迹作为权威结果。

## 4. 配置与结果界面

“Agent 配置”页面只列出代码中实际使用通用 Agent Runtime 的 Agent，当前包括 Knowledge Maintenance Agent 和通用管理 Agent，并展示各自的 Runtime、System Prompt 和工具。Observation Preprocessor 是直接模型调用阶段，不属于 Agent，只在知识加工的配置和调试工作面展示。Agent 的工具名称、描述和可展开参数 JSON Schema 与运行时 AgentTool 由同一工具目录生成，向 Renderer 只投影可序列化的只读信息，不在 UI 中另行启停或编辑。尚未接入运行时的概念角色不作为占位配置出现。

System Prompt 有三个清晰层次：代码内置 Prompt 是始终存在的 fallback；实际 Agent 可以在 Agent 配置页保存用户默认 Prompt；知识加工阶段还可以在知识加工页保存调试覆盖。Observation Preprocessor 不出现在 Agent 配置页，知识加工页继续展示其实际生效的处理指令并管理阶段覆盖。实际运行依次选择“阶段覆盖、用户默认、代码内置”中第一个存在的值，并在运行开始时固化到本次配置和成功历史中。在 Agent 配置页恢复代码默认会删除 Agent 的用户默认覆盖；在知识加工页恢复当前默认会删除阶段覆盖，二者都不复制内置文本。Host 提供的初始任务材料和结束被拒绝时的 Runtime Feedback 不属于 System Prompt，也不由该页面配置；Host 不在每轮模型调用前自动注入工作清单。

代码内置 Prompt 默认使用英文表达，但要求 Candidate 的表达与问题以及 Knowledge Statement 跟随原始材料的主要语言；当材料混合多种语言时，保留翻译可能改变含义的关键原文术语。每个阶段还保存用户明确选择的 Connection、该 Connection 中的 Model，以及模型明确支持时的可选思考强度。两个阶段可以选择不同 Backend、Connection、Model 与思考强度；不支持或能力未知的模型不显示该控制，也不会收到相应参数。

Sandbox 链路测试和预处理高级调试均可选择 catalog 中可用的 Session 与 Attention，并展示所用阶段配置。运行结果包括：

- 两个阶段及 Sandbox 提交的执行状态；
- 成功结果中两个阶段成功完成的 `modelCallCount`；
- 预处理的总分段、每次 Candidate 发现调用的输出及原始位置；
- Maintainer Todo 的总数、pending 与 completed 状态；
- Contribution Draft 规模，以及逐次模型输出、工具调用、Raw Evidence 有界读取与 continuation；
- Agent 自然结束时由 Host 冻结的 Knowledge Contribution；
- 从 Sandbox 按 canonical title 回读的 Knowledge Statement 列表与正文。

“历史记录”按完成时间浏览成功的完整链路测试，并提供两个按需打开的二级视图：结果快照复用正式知识浏览器的 Statement 阅读与名称引用跳转体验；运行详情展示该次保存的逐次模型输出和工具结果。当前结果与历史结果都可以由用户显式导入正式知识库，导入完成后在页面内报告新增和覆盖数量。

Coding Plan 与 API Connection 都向两个阶段提供同一模型调用契约。Observation Preprocessor 使用所选模型进行一次或多次有界直接调用；Knowledge Maintenance Agent 使用同一模型的 stream 接入通用 Agent Runtime，当前 Runtime 实现为 Pi Agent Core。Backend 决定认证和计费通道，阶段 Runtime 决定直接生成还是 Agent loop，两者不混为一个概念。

Debug Trace 不是新的知识层或正式审计日志。阶段调试只在内存中保留最近一次真正开始的轨迹；成功的完整链路轨迹随不可变测试快照持久化，失败或取消的运行当前不进入历史。轨迹可能包含模型输出和工具结果，因此历史详情明确按本地调试材料展示，历史列表不会预读或展开这些内容。每次调用的调试输出副本具有独立于实际处理结果的字符上限，截断只影响界面展示；预处理的分段与调用数量、维护 Agent 的模型轮次与工具调用数量都反映实际运行，不作为处理配额。轨迹中的条目表示应用观察到的处理尝试，不等同于 Provider 账单。

界面只展示用户做出选择、理解运行影响和判断结果所需的信息。Session 标题、来源、项目、时间范围和原始记录大小用于识别输入；阶段、模型配置、进度、模型输出、预处理 Candidate、Maintainer Todo 和 Statement 正文用于调试链路。EvidenceLocation、`sourceRef`、revision、Sandbox ID、Run ID 与格式版本仍可在内部协议中存在，但不因实现方便而暴露为产品信息。

## 5. 运行边界

- 用户首次输入 API Key 时，它只经受信的 Renderer → Main IPC 用于模型发现或保存；保存后仅从系统 Keychain 读取，不写入配置文件、不回传 Renderer，也不进入 Prompt 或 Agent transcript；
- 自定义远程端点必须使用 HTTPS，HTTP 只允许 localhost；
- Agent 模型请求只允许使用阶段固定的 Connection 与 Model，API 请求拒绝重定向；每次请求遵循模型上下文与输出包络，并有独立超时；
- Knowledge Maintenance Agent 不设置固定的模型轮次、工具调用次数或总运行时长，用户可以显式取消；上下文增长由通用 Agent Runtime 的压缩机制处理，不以整次运行的累计读取配额代替上下文管理；
- 工具参数经 schema 与授权校验。大体量 Raw Evidence 使用可续读的分页边界；Contribution Draft 和知识搜索使用分页读取，单条 Knowledge Statement 不做无续读的静默截断；过大 transcript 由通用 Runtime 压缩。Host 冻结后的 Contribution 与每条持久记录仍遵循数据完整性边界，不设置整次 Agent 的累计配额；
- Observation Preprocessor 不限制整次运行的分段数、模型调用数或总时长；每次模型请求仍有独立超时，整次运行由用户显式取消；
- Raw Observation 被视为不可信证据，其中的指令不会获得 System Prompt 权限；
- 完整链路独占两个加工阶段；取消会传播到当前模型请求和 Agent Runtime，并清除未完成的 Sandbox；
- Renderer 只能提交 Session 的稳定身份和所选 catalog 版本，不能提交文件路径、选择写入 Store 或直接构造数据库写入。

Model Connection 会在 Provider 能声明时保留 `contextWindowTokens` 和最大输出 token。Coding Plan 直接使用 Pi 模型目录中的能力；OpenAI-compatible `/models` 只采纳明确、有效的上下文字段。未知窗口没有跨 Provider 的统一发现协议，因此只能采用保守预算和 context-overflow 自动重试；如果第三方端点既不声明窗口、也静默截断输入，应用无法从协议层证明其真实边界。输出达到长度上限仍被视为不完整结果，不会误判成可通过缩小输入恢复的 context overflow。

## 6. 当前未实现

- 超出当前 Statement 直接邻域的多层路径、全局图或超图投影视图；
- Statement 生命周期与历史治理；
- Reviewer：在不接触 Raw Evidence、Observation View、Maintainer Todo 或维护 Agent 轨迹的独立上下文中，只依据冻结的 Contribution Draft、相关现有知识及显式引用审阅 Statement 的自足性、内部一致性和引用完整性；Reviewer 可以使用知识读取工具和 Host 绑定的通用 Todo，但当前尚未接入运行；
- 正式知识生产的自动提交、冲突裁决与增量同步链路；
- 正式知识生产的自动调度、批量和流式处理；
- Canonical Activity 作为跨 Harness 的标准化 Observation 视图；
- 持久 Workspace 与作业恢复；
- 独立调度的 Projection Pipeline、临时消费视图构建，以及 Artifact 依赖或自动同步；通用管理 Agent 对普通文件执行的直接维护不属于这里的未实现项；
- 更多消费者 Coding Plan Provider。

当前实现先验证 Candidate 发现、Candidate 到 initial Todo 的投影、Raw Evidence 按需读取、Contribution Draft、自然结束时的 Host 冻结和隔离提交。测试结果默认不进入正式知识，只有用户从当前结果或持久历史中显式导入时才按 title 写入。下一优先质量能力是与 Maintainer 对应的 Reviewer：它以全新上下文审阅精确 Draft 版本；Draft 改变后，旧结论不能代表新版本。Reviewer 与 Maintainer 的外层交接及其对提交的影响当前不展开设计，也不复用 Agent 内部 Todo 充当跨运行工作协议。当前方向不实现独立证据 Reviewer；Raw Evidence 的支持、限定与遗漏判断仍由 Knowledge Maintenance Agent 负责，不能为了复用 Reviewer 而把原始 Session 加入其上下文。
