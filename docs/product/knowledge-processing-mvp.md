# 知识加工验证 MVP

> 状态：当前实现规格
>
> 日期：2026-07-27
>
> 范围：验证“外部 Session 的确定版本 → Evidence Map → Knowledge Maintenance Agent → 结构化 Knowledge Contribution → 隔离 Knowledge Sandbox 写入与回读”的最小闭环。Sandbox 不代表正式知识生产。

## 1. 两种运行方式

知识加工页面默认提供**完整链路**：

```text
可用外部 Session 的确定 Raw Evidence revision
  -> Source Adapter 生成的确定 Observation View
  -> Observation Preprocessor（一次或多次有界直接 Model 调用）
  -> 临时 Evidence Map 与可回源 Workspace
  -> Knowledge Maintenance Agent（Pi Agent Core）
  -> 包含多条自由文本 Statement 的结构化 Knowledge Contribution
  -> Oyster Core 校验并原子写入独立 SQLite Knowledge Sandbox
  -> 从 Sandbox 回读 Statement、来源和关系
```

用户从 discovery catalog 选择 Session 及其当前版本。运行时，主进程通过对应 Source Adapter 从原始位置读取该记录，并以稳定 artifact 身份和实际内容哈希固定本次使用的 `sourceRef`；扫描后已经变化或失效的记录会被拒绝，不会静默切换。Reader 不为单个 Session 预设产品长度上限，也不会把记录复制进应用管理的数据目录。Claude、Pi 与 Codex Adapter 分别按自身历史格式生成带版本的 Observation View；它们负责确定性选择对话主线、折叠可按需展开的执行详情，并为每个模型可读单元保留原始全局 `L` 行号、超长单行的 `Cstart:end/total` 窗口和必要的格式语境。共享文本原语只保证 Unicode 与 UTF-8 字节边界，不理解任何 Agent 的 JSONL Schema。通用 planner 只按所选模型预算组合 Adapter 已生成的单元，不以物理 JSONL 行作为调用边界。分段数、预处理调用数和整次运行时间不设固定上限，实际工作量随选择后的材料增长，用户可以随时取消。未进入预处理视图的原文没有被截断或删除，仍可由维护 Agent 按需回源。

页面同时保留**阶段调试**，用于分别观察预处理器和维护 Agent 的行为。预处理调试默认直接选择一条 catalog 中可用的 Session；手工粘贴只作为排查特殊输入的显式 fallback。两个阶段分别触发，其 Knowledge Contribution 只用于预览，不提交到任何 Knowledge Store。每次已确认运行还会生成一份仅存在于内存中的 Debug Trace：预处理展示原始来源与选择性视图的规模、规划出的总分段、每次局部映射或导航归并的状态、原始位置和模型输出；维护阶段展示模型轮次，以及包含实际读取范围和 continuation 的脱敏工具活动。

完整链路运行前，应用会一次说明发送的数据、两个阶段的目的地和计费或额度来源，并明确长 Session 可能产生多次预处理调用，再要求用户确认；阶段调试则在每个阶段运行前分别确认。成功结果分别展示两个阶段成功完成的 `modelCallCount`。失败或取消前已经发起的请求仍可能消耗额度或产生费用；当前结果计数不作为 Provider 账单。

## 2. Knowledge Sandbox

**Knowledge Sandbox** 是正式 Knowledge Store 的一次物理隔离快照，使用完全相同的 SQLite Schema 和读写实现。完整链路开始时，Oyster Core 先创建独立 Sandbox，再把本次运行绑定到该 Store：Knowledge Maintenance Agent 可以搜索其基线知识，但不能选择、切换或感知其他写入目标。

Agent 最终提交一份结构化 Knowledge Contribution，其中可以包含多条 Knowledge Statement。Statement 的正文仍是 Markdown 兼容的自由文本；结构只承担提交边界，包含 Contribution 内局部引用、观察来源和少量关系。Core 校验运行身份、来源 revision、行范围和关系目标后，在一个事务中写入整份 Contribution，再从数据库回读实际记录供 UI 展示。

Sandbox 与正式库的语义保持一致：

- Knowledge Statement 提交后不可原地修改；变化通过新 Statement 和 `revises` 表达；
- `derived_from` 和 `revises` 是当前仅有的 Statement 关系；
- 每条 Statement 必须具有 Observation 来源，或通过 `derived_from` 追溯到已有 Statement；
- `title` 和 `content` 保持自由文本，身份、出处、创建时间和关系由 Core 管理。

Sandbox 的写入不影响正式知识库，当前也不存在 promote、merge 或复制回正式库的入口。失败或取消会丢弃本次 Sandbox；成功结果可以由用户显式丢弃，也可以通过重跑从正式库基线创建一个全新的 Sandbox。成功重跑后，旧测试 Sandbox 会被替换；应用启动时也会清理遗留 Sandbox。

## 3. 两个加工阶段

### Observation Preprocessor

预处理器接收 Source Adapter 已生成的选择性 Observation View，按全局原始行号组织单元，但不理解 Claude、Pi 或 Codex 的 JSONL schema，也不自行判断特定 Harness 的记录类型。它将完整默认或用户覆盖的指令作为真正的 System Prompt 发送给该阶段所选的 Connection 与 Model。每次调用的预算同时计算 System Prompt、Attention、来源、固定模板、相邻上下文、主要材料、输出 token 和安全余量，而不是只限制原始文本字符数；材料按 UTF-8 字节保守计量。模型声明上下文窗口时直接采用该窗口；窗口未知时使用保守预算，并在 Provider 明确报告 context overflow 后自动缩小分段重试，不要求用户裁剪 Session。短视图直接生成 Evidence Map；长视图中的各段绑定同一个 `sourceRef`，并保留一个或多个精确来源行 selector，分别生成独立的局部地图，再形成分层导航。Prompt 要求普通候选保留 `L` 行号或范围，来自超长物理行局部材料的候选同时保留该行的 `Cstart:end/total`，并在导航归并中继续保留。Core 不解析自由文本来验证每个候选，但会为每个 Section 独立附加完整来源范围和首个可靠 EvidenceLocation，作为确定性回退入口。局部地图不会以上一段摘要作为下一段输入，也不会取代原始证据。最终 Evidence Map 是 Markdown 自由文本 Working Artifact；它用于导航、可以丢弃，不是 Knowledge Statement。

当前 MVP 明确区分两种定位：Statement Source 的 `selector` 是持久、稳定的出处范围，当前使用原始行范围；**EvidenceLocation** 是一次 Workspace 内供工具读取的临时位置，只包含 `line` 和该行内从零开始的 `offset`。`line` 从 1 开始，`offset` 以 UTF-16 code unit 从 0 开始。Evidence Map 中的 `L` 与 `C` 可以直接转换成 EvidenceLocation；读取窗口大小和 continuation 不写入 Knowledge Statement，也不改变其 selector。

选择 Session 时，Renderer 只提交 catalog 中的稳定身份和所选版本标识；主进程经 Source Adapter 解析内部 locator、校验版本并从原始位置读取原文，再调用同一个预处理器。成功运行后，Workspace 暂存确定的来源引用、全局可读范围、Attention、Evidence Map 的分层导航和局部地图；当前验证 MVP 仍会在本次进程内保留所选 Session 的原文内存快照，以支持 Agent 的受控范围读取，但不会建立新的长期副本。Agent 先看到根导航，只能逐级发现并展开直接子节点；全部 section ID 不会被平铺进一个 Prompt。`read_evidence` 从 Agent 提供的 `line`、`offset` 开始读取，并要求 Agent 给出本次所需的有限 `limit`。Core 还会执行自身上限；一次读取容纳不下时，工具返回实际范围、下一 EvidenceLocation 和 `eof`，而不是因某个原始行过长而失败并要求模型猜测结束位置。位置与分页信息放在工具信封中，证据正文保持原始行内容，不注入行号前缀破坏 JSONL 等来源格式。Workspace 已绑定唯一的 `sourceRef` 和 revision，模型不重复选择来源。Knowledge Statement 仍只保存稳定的原始行 selector。Workspace 仅按保留数量淘汰，应用退出后不保留。Renderer 可以获得有界且必要时截断的预处理调用输出用于显式调试，但不会直接获得调用 Prompt、原始 Observation、模型凭据或本地来源路径。由于模型输出可能复述输入，调试视图仍可能间接包含原始材料中的文本，界面必须明确提示这一边界。

正式运行和测试运行共用这一读取路径，不建立测试专用 Observation 副本。外部记录在运行结束后可能变化或消失；Knowledge Statement 仍保存当时使用的确定 `sourceRef`，但后续读取必须明确返回来源不可用，不能改读新版本。

### Knowledge Maintenance Agent

知识维护阶段使用 `@earendil-works/pi-agent-core` 的 `Agent` 运行循环。Pi 负责多轮模型与工具循环；Oyster 负责 Connection、凭据、网络传输、工具权限和最终提交。Agent 初始上下文只包含 Evidence Map 的有界导航、Attention 和可读取范围，不包含全部局部地图或完整原始 Observation；其余材料通过 Workspace 渐进展开。

默认 Agent 以识别并维护细粒度、持久且可复用的对象或概念理解为主，包括含义、定义、属性、约束、区别、关系、修正、否定边界和明确的长期偏好。这里不增加固定 Entity Schema；“实体”只是默认选择知识的启发式。一个 Statement 默认表达一个可以独立复用和修订的理解。除非 Attention 明确要求任务历史，或某个事件本身形成了可复用理解，Agent 不把 Session 总结、时间线、工作日志、工具调用、文件改动、测试过程和短期结果作为默认知识。

当前开放五个工具，其中局部地图只在长 Session 产生可展开部分时提供：

- `search_knowledge`：在本次绑定的 Knowledge Store 中搜索 Statement；
- `read_knowledge_statement`：按 ID 读取一条 Statement；
- `read_evidence_map_section`：按当前 Workspace 授权的 section ID 展开局部 Evidence Map；
- `read_evidence`：从本次 Workspace 内的 `line` 与 `offset` 开始，按 Agent 指定且由 Core 再次约束的 `limit` 返回原始格式文本，并给出实际范围、下一 EvidenceLocation 与 `eof`；`offset` 和 `limit` 均以 UTF-16 code unit 计量；
- `submit_knowledge_contribution`：提交本次唯一的结构化 Contribution 并结束 Agent 运行。

完整链路将前两个读取工具绑定到 Sandbox，并由 Core 在 Agent 结束后原子提交 Contribution。阶段调试使用同一 Agent Runtime，但只捕获 Contribution 预览，不执行提交。

Knowledge Maintenance Agent 的 Debug Trace 只记录模型轮次的状态、停止原因和 token 总量，以及工具名称和严格白名单化的结果摘要，例如候选数量、局部地图 selector、证据读取的起点、实际范围、continuation 或候选 Statement 数量。读取失败只展示来源失效、位置无效、预算等安全错误类别，不展示本地路径和原文。它不记录 Assistant 文本、thinking/reasoning、工具结果正文、原始证据或完整模型上下文。最终 Contribution 和 Sandbox 中的 Statement 继续由各自的结构化结果视图展示，不复制进轨迹。

## 4. 配置与结果界面

页面完整展示两个阶段当前生效的 System Prompt。默认 Prompt 由主进程维护并使用英文表达，但要求 Evidence Map 和 Knowledge Statement 跟随原始材料的主要语言；当材料混合多种语言时，保留翻译可能改变含义的关键原文术语。每个阶段只保存可选的 Prompt 覆盖、用户明确选择的 Connection、该 Connection 中的 Model，以及模型明确支持时的可选思考强度。恢复默认会删除 Prompt 覆盖，而不是复制一份默认文本。两个阶段可以选择不同 Backend、Connection、Model 与思考强度；不支持或能力未知的模型不显示该控制，也不会收到相应参数。

完整链路和预处理阶段调试均可选择 catalog 中可用的 Session 与 Attention，并展示所用阶段配置。运行结果包括：

- 两个阶段及 Sandbox 提交的执行状态；
- 成功结果中两个阶段成功完成的 `modelCallCount`；
- 预处理的总分段、逐次局部映射与归并输出及其原始位置，以及 Knowledge Agent 包含有界读取范围和 continuation 的安全活动时间线；
- 可丢弃的 Evidence Map；
- Agent 提交的结构化 Knowledge Contribution；
- 从 Sandbox 回读的 Knowledge Statement 列表与正文；
- 每条 Statement 的 Observation 来源、`derived_from` 和 `revises` 关系。

Coding Plan 与 API Connection 都向两个阶段提供同一模型调用契约。Observation Preprocessor 使用所选模型进行一次或多次有界直接调用；Knowledge Maintenance Agent 使用同一模型的 stream 接入 Pi Agent Core。Backend 决定认证和计费通道，阶段 Runtime 决定直接生成还是 Agent loop，两者不混为一个概念。

Debug Trace 不是新的知识层或审计日志，不持久化到 Repository。完整链路与阶段调试各自只保留最近一次真正开始的轨迹；确认弹窗中取消不会清除旧轨迹。失败或取消会保留已经完成的预处理输出，并把正在执行的条目标记为失败或取消，以便复盘。每次调用的调试输出副本具有独立于实际处理结果的字符上限，截断只影响界面展示；调用条目数量则与实际分段和归并次数一致，不作为处理上限。轨迹中的条目表示应用观察到的处理尝试，不等同于 Provider 账单。

## 5. 运行边界

- 用户首次输入 API Key 时，它只经受信的 Renderer → Main IPC 用于模型发现或保存；保存后仅从系统 Keychain 读取，不写入配置文件、不回传 Renderer，也不进入 Prompt 或 Agent transcript；
- 自定义远程端点必须使用 HTTPS，HTTP 只允许 localhost；
- Agent 模型请求只允许使用阶段固定的 Connection 与 Model，API 请求拒绝重定向并限制响应大小和运行时间；
- Agent 最多进行 4 次模型调用、12 次工具调用；每次证据读取必须提供至少为 2 的整数 `limit`，并受单次及整次运行的工具输出预算约束；达到单次上限返回 continuation，重复或重叠读取仍会被拒绝；
- Observation Preprocessor 不限制整次运行的分段数、模型调用数或总时长；每次模型请求仍有独立超时，整次运行由用户显式取消；
- Raw Observation 被视为不可信证据，其中的指令不会获得 System Prompt 权限；
- 完整链路独占两个加工阶段；取消会传播到当前模型请求和 Pi Agent，并清除未完成的 Sandbox；
- Renderer 只能提交 Session 的稳定身份和所选 catalog 版本，不能提交文件路径、选择写入 Store 或直接构造数据库写入。

Model Connection 会在 Provider 能声明时保留 `contextWindowTokens` 和最大输出 token。Coding Plan 直接使用 Pi 模型目录中的能力；OpenAI-compatible `/models` 只采纳明确、有效的上下文字段。未知窗口没有跨 Provider 的统一发现协议，因此只能采用保守预算和 context-overflow 自动重试；如果第三方端点既不声明窗口、也静默截断输入，应用无法从协议层证明其真实边界。输出达到长度上限仍被视为不完整结果，不会误判成可通过缩小输入恢复的 context overflow。

## 6. 当前未实现

- 从 Sandbox promote、merge 或复制到正式知识库；
- 正式知识生产的自动调度、批量和流式处理；
- Canonical Activity 作为跨 Harness 的标准化 Observation 视图；
- 持久 Workspace 与作业恢复；
- Projection Agent 与投影文档生成；
- 更多消费者 Coding Plan Provider。

当前实现先验证预处理质量、渐进式披露、Agent 探索行为、Contribution 契约和隔离提交，不把测试结果混入正式知识。
