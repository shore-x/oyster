# 知识加工验证 MVP

> 状态：当前实现规格
>
> 日期：2026-07-28
>
> 范围：验证“外部 Session 的确定版本 → Candidate 发现 → Knowledge Maintenance Agent 裁决 → Knowledge Contribution → 隔离 Knowledge Sandbox 写入与回读”的最小闭环。Sandbox 不代表正式知识生产。

## 1. 两种运行方式

知识加工页面默认提供**完整链路**：

```text
可用外部 Session 的确定 Raw Evidence revision
  -> Source Adapter 生成的确定 Observation View
  -> Observation Preprocessor 分段发现 Statement Candidate
  -> 开放 Candidate Agenda + 可回源 Workspace
  -> Knowledge Maintenance Agent 调查与裁决（当前由 Pi Agent Core 实现）
  -> 运行期 Contribution Draft
  -> Core 提交门
  -> 包含多条自由文本 Statement 的 Knowledge Contribution
  -> Oyster Core 校验并原子写入独立 SQLite Knowledge Sandbox
  -> 从 Sandbox 按 canonical title 回读 Statement
```

用户从 discovery catalog 选择 Session 及其当前版本。运行时，主进程通过对应 Source Adapter 从原始位置读取该记录，并以稳定 artifact 身份和实际内容哈希固定本次使用的 `sourceRef`；扫描后已经变化或失效的记录会被拒绝，不会静默切换。Reader 不为单个 Session 预设产品长度上限，也不会把记录复制进应用管理的数据目录。Claude、Pi 与 Codex Adapter 分别按自身历史格式生成带版本的 Observation View；它们负责确定性选择对话主线、折叠可按需展开的执行详情，并为每个模型可读单元保留原始全局 `L` 行号、超长单行的 `Cstart:end/total` 窗口和必要的格式语境。共享文本原语只保证 Unicode 与 UTF-8 字节边界，不理解任何 Agent 的 JSONL Schema。通用 planner 只按所选模型预算组合 Adapter 已生成的单元，不以物理 JSONL 行作为调用边界。分段数、预处理调用数和整次运行时间不设固定上限，实际工作量随选择后的材料增长，用户可以随时取消。未进入预处理视图的原文没有被截断或删除，仍可由维护 Agent 按需回源。

页面同时保留**阶段调试**，用于分别观察预处理器和维护 Agent 的行为。预处理调试默认直接选择一条 catalog 中可用的 Session；手工粘贴只作为排查特殊输入的显式 fallback。两个阶段分别触发，其 Knowledge Contribution 只用于预览，不提交到任何 Knowledge Store。每次实际启动的运行还会生成一份仅存在于内存中的 Debug Trace：预处理展示原始来源与选择性视图的规模、规划出的总分段、每次 Candidate 发现调用的原始位置和输出；维护阶段展示 Candidate Agenda、Contribution Draft 的最新规模、模型轮次，以及包含实际读取范围和 continuation 的脱敏工具活动。

运行按钮是显式启动操作，不再叠加系统原生确认弹窗。页面在启动前展示所选 Connection、Model、目的地和输入，在启动后持续展示发送影响、阶段进度、模型调用与错误；长 Session 可能产生多次预处理调用，模型调用可能消耗额度或产生费用。成功结果分别展示两个阶段成功完成的 `modelCallCount`；失败或取消前已经发起的请求仍可能计费，当前结果计数不作为 Provider 账单。

## 2. Knowledge Sandbox

**Knowledge Sandbox** 是当前验证 Store 的一次物理隔离快照，使用相同的 SQLite Schema 和读写实现。完整链路开始时，Oyster Core 先创建独立 Sandbox，再把本次运行绑定到该 Store：Knowledge Maintenance Agent 可以搜索其基线知识，但不能选择、切换或感知其他写入目标。SQLite 只是当前 MVP 的验证介质，不决定正式知识层最终使用数据库还是本地文件。

Agent 最终提交一份结构化 Knowledge Contribution，其中可以包含多条 Knowledge Statement。Statement 使用当前知识视图中唯一且语义丰富的 canonical title；正文仍是 Markdown 兼容的自然语言自由文本，结构只承担当前提交边界。目标知识模型允许正文使用 `[[canonical title]]` 或 `[[canonical title|local display text]]` 表达任意多元关系；名称在读取时动态指向当前知识视图中的同名 Statement，不永久绑定写作时的记录。

当前 SQLite Sandbox 采用最小的 Statement 读写模型：

- canonical title 是 Agent 可见的唯一读写键。一次 Contribution 内的 title 不得重复；提交时没有同名 Statement 就创建，已有同名 Statement 就原地覆盖正文；
- Sandbox 只维护当前 Statement 视图，不保存历史。Statement 的生命周期与历史如何治理尚未决定，不属于当前 MVP。

Core 在一个事务中按 title 写入整份 Contribution，再回读实际 Statement 供 UI 展示。正文中的名称引用原样保存，Agent 可以使用引用中的 canonical title 继续精确读取对应 Statement；当前实现不解析引用，也不生成出站引用、反向引用或图投影视图。

Sandbox 的写入不影响当前验证 Store 的基线，当前也不存在 promote、merge 或复制回基线 Store 的入口。失败或取消会丢弃本次 Sandbox；当前界面只持有最新的成功结果，因此成功重跑会用同一验证基线创建的新 Sandbox 替换旧 Sandbox。用户可显式丢弃当前结果，应用启动时也会清理上一次进程遗留的 Sandbox。

## 3. 两个加工阶段

### Observation Preprocessor

预处理器接收 Source Adapter 已生成的选择性 Observation View，按全局原始行号组织单元，但不理解 Claude、Pi 或 Codex 的 JSONL schema，也不自行判断特定 Harness 的记录类型。来源适配器让视图以人类与 Agent 的语义消息为主，保留发现局部名称所需的最小语境，并避免运行时注入指令、遥测和常规工具执行占据上下文；省略的记录仍保留在 Raw Evidence 中供 Agent 回读。

预处理器按所选模型的上下文预算对视图分段，每段进行一次 Candidate 发现调用；分段数、调用数和整次 Session 长度不设固定上限。相邻材料只用于解释边界处的连续指代，不增加该段的发现范围。各段结果直接汇入本次运行的初始 Candidate 清单，不再生成 Session 摘要、递归地图或导航归并层。

每次调用返回严格的 Statement Candidate Batch。每个 Candidate 只包含：

- 原文中实际出现的名称或表达；
- 一个说明需要调查什么、并带最小消歧语境的问题；
- 至少一个指向 Raw Evidence 的起始位置。

Candidate 是开放的调查问题，不是拟定的 canonical title、Statement 或事实。预处理器不负责判断是否应创建知识，也不强制合并看似重复的称呼；后续 Agent 可以合并、拆分、否定或补充 Candidate。Candidate 与最终 Statement 是多对多关系，也允许调查后不产生任何 Statement。

当前 **EvidenceLocation** 使用从 1 开始的 `line` 和从 0 开始、以 UTF-16 code unit 计量的行内 `offset`。它只是当前 Observation Workspace 中 `read_evidence` 的起点，不属于 Statement 格式，也不决定正式知识如何保存追溯信息。知识裁决所依据的观察内容仍是该位置指向的 Raw Evidence，而不是 Candidate 问题或选择性 Observation View。

选择 Session 时，Renderer 只提交 catalog 中的稳定身份和所选版本标识；主进程经 Source Adapter 解析内部 locator、校验版本并从原始位置读取原文。Workspace 在本次进程中保留所选版本的原文内存快照与 Candidate 清单，使 Agent 能从位置开始有界读取；`read_evidence` 返回原始格式文本、实际范围、下一 EvidenceLocation 和 `eof`。该快照不形成长期副本，Workspace 已绑定唯一 `sourceRef` 和 revision，模型不能切换来源。

正式运行和测试运行共用这一读取路径，不建立测试专用 Observation 副本。外部记录在运行结束后可能变化或消失；再次读取失败必须明确暴露，不能改读新版本。正式知识长期如何保存追溯信息仍待决定。

### Knowledge Maintenance Agent

Knowledge Maintenance Agent 是普通、可替换的工具使用 Agent，当前由 `@earendil-works/pi-agent-core` 提供通用 Agent Runtime。Oyster 只定义 System Prompt、Workspace、阶段固定的模型、授权工具和最终提交协议；Runtime 负责模型—工具循环与上下文生命周期。知识维护不依赖固定推理步骤、模型轮次、工具调用次数或总运行时长。

Host 在一次运行中分别持有两个可丢弃工作结构：

- **Open Candidate Agenda**：由预处理 Candidate 初始化，Agent 可以继续添加，并以自由文本处置每个 Candidate；它跟踪调查覆盖，不保存知识；
- **Contribution Draft**：由 Agent 按 canonical title 增删改查的 Statement 草稿集合；它跟踪拟提交的知识变更，在最终提交前不写入 Sandbox。

两者互不替代。处置 Candidate 不会自动产生 Statement，修改 Draft 也不会自动关闭 Candidate；多个 Candidate 可以由一条 Draft 覆盖，一条 Candidate 也可以产生多条 Draft，或者只留下“不需要知识变更”或“证据不足”的处置。

Agenda、Draft、来源授权和提交状态由 Host 持有，不依赖 transcript 或压缩摘要。每次 Agent 进入下一轮模型调用时，Host 都在靠近当前上下文的位置附加一个重新生成的有界状态快照，至少显示 Candidate 总数、开放与已处置数量、少量下一候选预览和 Draft 数量。它只是新鲜的工作提示，不代表新的用户请求、Observation、知识或第二份状态来源；完整 Agenda 与 Draft 仍通过工具读取。上下文压缩只管理模型 transcript，压缩后也会使用同一 Host 状态重新生成快照。

默认 Agent 优先解析对话中具有局部含义的名称和指代，再维护关于这些对象或概念的细粒度、持久且可复用的理解，包括含义、定义、属性、约束、区别、关系、修正、否定边界和明确的长期偏好。它会用原始称呼、别名和语境限定词搜索已有知识，并在创建或覆盖前读取可能具有相同语义焦点的 Statement。若当前知识缺少理解 Contribution Draft 中拟写 Statement 所必需的背景，Agent 会继续搜索，并在同一 Contribution 中创建或补全相关背景 Statement，再用正文引用使它们互相解释。这里不增加固定 Entity 或 Relation Schema；“实体”只是默认选择知识的启发式。一个 Statement 默认围绕一个连贯且可独立理解的语义焦点，也可以通过正文中的显式名称引用表达任意多元关系；关系型 Statement 不能取代其中具有项目局部含义的参与者各自所需的解释。Statement 的 canonical title 和正文必须使用具有实际区分力的自然语言，不使用机械编号或枚举关系代替语义。除非 Attention 明确要求任务历史，或某个事件本身形成了可复用理解，Agent 不把 Session 总结、时间线、工作日志、工具调用、文件改动、测试过程和短期结果作为默认知识。

知识维护不以最小改动为目标，也不对搜索、读取、工具调用或一次 Contribution 中涉及的 Statement 数量设置固定配额。Agent 根据相关性自行决定需要探索和修改的范围，目标是让本次涉及的知识邻域处于连贯、可互相解释的状态；普通常识、无关主题和不具持久价值的细节不因此被扩张为知识。

当前工具按五类职责组织：

- 当前知识：`search_knowledge` 按标题和正文文本分页发现 Statement，`read_knowledge_statement` 按完整 canonical title 精确读取；
- Candidate Agenda：`list_statement_candidates` 分页读取，`add_statement_candidates` 补充调查问题，`resolve_statement_candidates` 记录明确处置；
- Contribution Draft：`upsert_contribution_statement` 按 title 暂存或替换草稿，`read_contribution_statement` 与 `list_contribution_statements` 回读，`remove_contribution_statement` 移除草稿；
- 原始证据：`read_evidence` 从 Candidate 的位置开始有界读取 Raw Evidence，并返回 continuation；
- 最终提交：`submit_knowledge_contribution` 请求提交当前 Draft。

提交工具构成 Host 执行的覆盖门：只要 Agenda 仍有开放 Candidate，提交就不被接受，也不会结束 Agent；工具返回最新开放数量与有界预览，下一轮模型调用再获得动态状态快照，使 Agent 能继续调查和跟进。当 Agenda 全部具有处置后，Host 才捕获当前 Draft 为 Knowledge Contribution 并结束 Agent；如果所有处置都不需要知识变更，Draft 可以为空。处置结果可以说明由已有知识覆盖、由哪些 Draft 处理、为何合并或拆分、为何无需变更，或为何证据不足；提交门只保证这些问题被显式考虑，不判断结论正确，也不要求 Candidate 与 Statement 一一对应。

完整链路把知识读取和最终提交绑定到 Sandbox；阶段调试使用同一 Agent Runtime、Agenda、Draft 和提交门，但只返回 Contribution 预览，不执行 Sandbox 写入。知识工具按 canonical title 读取当前 Statement；正文中的 `[[canonical title]]` 本身就是继续读取相关知识的键，领域关系仍由正文表达。`read_evidence` 只读取本次运行已经授权的唯一 Raw Evidence 来源。

Knowledge Maintenance Agent 的 Debug Trace 只记录模型轮次、工具名称和严格白名单化的结果摘要，以及 Candidate 总数、开放与已处置数量、Draft 数量和证据读取 continuation。读取失败只展示来源失效、位置无效、预算等安全错误类别，不展示本地路径和原文。它不记录 Assistant 文本、thinking/reasoning、工具结果正文、Raw Evidence 或完整模型上下文。最终 Candidate 处置、Contribution 和 Sandbox Statement 由各自的结构化结果视图展示，不复制进轨迹。

## 4. 配置与结果界面

页面完整展示两个阶段当前生效的 System Prompt。默认 Prompt 由主进程维护并使用英文表达，但要求 Candidate 的表达与问题以及 Knowledge Statement 跟随原始材料的主要语言；当材料混合多种语言时，保留翻译可能改变含义的关键原文术语。每个阶段只保存可选的 Prompt 覆盖、用户明确选择的 Connection、该 Connection 中的 Model，以及模型明确支持时的可选思考强度。恢复默认会删除 Prompt 覆盖，而不是复制一份默认文本。两个阶段可以选择不同 Backend、Connection、Model 与思考强度；不支持或能力未知的模型不显示该控制，也不会收到相应参数。

完整链路和预处理阶段调试均可选择 catalog 中可用的 Session 与 Attention，并展示所用阶段配置。运行结果包括：

- 两个阶段及 Sandbox 提交的执行状态；
- 成功结果中两个阶段成功完成的 `modelCallCount`；
- 预处理的总分段、每次 Candidate 发现调用的输出及原始位置；
- Candidate Agenda 的总数、开放与已处置状态以及自由文本处置；
- Contribution Draft 规模、Raw Evidence 有界读取与 continuation 的安全活动时间线；
- Agent 提交的结构化 Knowledge Contribution；
- 从 Sandbox 按 canonical title 回读的 Knowledge Statement 列表与正文。

Coding Plan 与 API Connection 都向两个阶段提供同一模型调用契约。Observation Preprocessor 使用所选模型进行一次或多次有界直接调用；Knowledge Maintenance Agent 使用同一模型的 stream 接入通用 Agent Runtime，当前 Runtime 实现为 Pi Agent Core。Backend 决定认证和计费通道，阶段 Runtime 决定直接生成还是 Agent loop，两者不混为一个概念。

Debug Trace 不是新的知识层或审计日志，不持久化到 Repository。完整链路与阶段调试各自只保留最近一次真正开始的轨迹。失败或取消会保留已经完成的预处理输出，并把正在执行的条目标记为失败或取消，以便复盘。每次调用的调试输出副本具有独立于实际处理结果的字符上限，截断只影响界面展示；预处理的分段与调用数量、维护 Agent 的模型轮次与工具调用数量都反映实际运行，不作为处理配额。轨迹中的条目表示应用观察到的处理尝试，不等同于 Provider 账单。

## 5. 运行边界

- 用户首次输入 API Key 时，它只经受信的 Renderer → Main IPC 用于模型发现或保存；保存后仅从系统 Keychain 读取，不写入配置文件、不回传 Renderer，也不进入 Prompt 或 Agent transcript；
- 自定义远程端点必须使用 HTTPS，HTTP 只允许 localhost；
- Agent 模型请求只允许使用阶段固定的 Connection 与 Model，API 请求拒绝重定向；每次请求遵循模型上下文与输出包络，并有独立超时；
- Knowledge Maintenance Agent 不设置固定的模型轮次、工具调用次数或总运行时长，用户可以显式取消；上下文增长由通用 Agent Runtime 的压缩机制处理，不以整次运行的累计读取配额代替上下文管理；
- 工具参数经 schema 与授权校验。大体量 Raw Evidence 使用可续读的分页边界；Candidate Agenda、Contribution Draft 和知识搜索使用分页读取，单条 Knowledge Statement 不做无续读的静默截断；过大 transcript 由通用 Runtime 压缩。最终提交另行遵循模型的单次输出包络与每条持久记录的数据完整性边界，不设置整次 Agent 的累计配额；
- Observation Preprocessor 不限制整次运行的分段数、模型调用数或总时长；每次模型请求仍有独立超时，整次运行由用户显式取消；
- Raw Observation 被视为不可信证据，其中的指令不会获得 System Prompt 权限；
- 完整链路独占两个加工阶段；取消会传播到当前模型请求和 Agent Runtime，并清除未完成的 Sandbox；
- Renderer 只能提交 Session 的稳定身份和所选 catalog 版本，不能提交文件路径、选择写入 Store 或直接构造数据库写入。

Model Connection 会在 Provider 能声明时保留 `contextWindowTokens` 和最大输出 token。Coding Plan 直接使用 Pi 模型目录中的能力；OpenAI-compatible `/models` 只采纳明确、有效的上下文字段。未知窗口没有跨 Provider 的统一发现协议，因此只能采用保守预算和 context-overflow 自动重试；如果第三方端点既不声明窗口、也静默截断输入，应用无法从协议层证明其真实边界。输出达到长度上限仍被视为不完整结果，不会误判成可通过缩小输入恢复的 context overflow。

## 6. 当前未实现

- 从 Statement 正文的动态名称引用派生出站引用、反向引用和图投影视图；
- Statement 生命周期与历史治理；
- 脱离原始 Session、只依据知识层内容及显式引用进行的 Statement 可理解性盲审或对抗式校验；
- 从 Sandbox promote、merge 或复制到正式知识库；
- 正式知识生产的自动调度、批量和流式处理；
- Canonical Activity 作为跨 Harness 的标准化 Observation 视图；
- 持久 Workspace 与作业恢复；
- Projection Agent 与投影文档生成；
- 更多消费者 Coding Plan Provider。

当前实现先验证 Candidate 发现、开放 Agenda 的调查覆盖、Raw Evidence 按需读取、Contribution Draft、提交门和隔离提交，不把测试结果混入正式知识。对抗式盲审仍只是未来方向，不参与当前运行。
