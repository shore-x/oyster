# 知识加工验证 MVP

> 状态：当前实现规格
>
> 日期：2026-07-26
>
> 范围：验证“外部 Session 的确定版本 → Evidence Map → Knowledge Maintenance Agent → 结构化 Knowledge Contribution → 隔离 Knowledge Sandbox 写入与回读”的最小闭环。Sandbox 不代表正式知识生产。

## 1. 两种运行方式

知识加工页面默认提供**完整链路**：

```text
可用外部 Session 的确定 Raw Evidence revision
  -> 有界 Raw JSONL Observation
  -> Observation Preprocessor（一次 Model 调用）
  -> 临时 Evidence Map 与可回源 Workspace
  -> Knowledge Maintenance Agent（Pi Agent Core）
  -> 包含多条自由文本 Statement 的结构化 Knowledge Contribution
  -> Oyster Core 校验并原子写入独立 SQLite Knowledge Sandbox
  -> 从 Sandbox 回读 Statement、来源和关系
```

用户从 discovery catalog 选择 Session 及其当前版本。运行时，主进程通过对应 Source Adapter 从原始位置读取该记录，并以稳定 artifact 身份和实际内容哈希固定本次使用的 `sourceRef`；扫描后已经变化或失效的记录会被拒绝，不会静默切换。当前直接把读取到的 Raw JSONL 作为 Observation，单个 Session 上限为 120,000 bytes；超限会拒绝运行，不会截断或隐式分批。

页面同时保留**阶段调试**，用于分别观察预处理器和维护 Agent 的行为。预处理调试默认直接选择一条 catalog 中可用的 Session；手工粘贴只作为排查特殊输入的显式 fallback。两个阶段分别触发，其 Knowledge Contribution 只用于预览，不提交到任何 Knowledge Store。

完整链路运行前，应用会一次说明发送的数据、两个阶段的目的地和计费或额度来源，并要求用户确认；阶段调试则在每个阶段运行前分别确认。

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

预处理器把 Observation 按行编号，将完整默认或用户覆盖的指令作为真正的 System Prompt 发送给该阶段所选的 Connection 与 Model。输出是 Markdown 自由文本 Evidence Map；它用于导航、可以丢弃，不是 Knowledge Statement。

选择 Session 时，Renderer 只提交 catalog 中的稳定身份和所选版本标识；主进程经 Source Adapter 解析内部 locator、校验版本并从原始位置读取有界原文，再调用同一个预处理器。成功运行后，主进程在内存中暂存本次 Observation、Evidence Map、确定的来源引用和 Attention。Workspace 数量有界，应用退出后不保留。Renderer 只获得 Evidence Map、Run ID 和不含本地文件路径的来源身份，不获得原始正文或模型凭据。

正式运行和测试运行共用这一读取路径，不建立测试专用 Observation 副本。外部记录在运行结束后可能变化或消失；Knowledge Statement 仍保存当时使用的确定 `sourceRef`，但后续读取必须明确返回来源不可用，不能改读新版本。

### Knowledge Maintenance Agent

知识维护阶段使用 `@earendil-works/pi-agent-core` 的 `Agent` 运行循环。Pi 负责多轮模型与工具循环；Oyster 负责 Connection、凭据、网络传输、工具权限和最终提交。Agent 初始上下文只包含 Evidence Map、Attention 和可读取范围，不包含完整原始 Observation。

当前开放四个工具：

- `search_knowledge`：在本次绑定的 Knowledge Store 中搜索 Statement；
- `read_knowledge_statement`：按 ID 读取一条 Statement；
- `read_evidence`：只读取本次授权的确定 `sourceRef` 与有限行范围；
- `submit_knowledge_contribution`：提交本次唯一的结构化 Contribution 并结束 Agent 运行。

完整链路将前两个读取工具绑定到 Sandbox，并由 Core 在 Agent 结束后原子提交 Contribution。阶段调试使用同一 Agent Runtime，但只捕获 Contribution 预览，不执行提交。

## 4. 配置与结果界面

页面完整展示两个阶段当前生效的 System Prompt。默认 Prompt 由主进程维护并使用英文表达，但要求 Evidence Map 和 Knowledge Statement 跟随原始材料的主要语言；当材料混合多种语言时，保留翻译可能改变含义的关键原文术语。每个阶段只保存可选的 Prompt 覆盖、用户明确选择的 Connection、该 Connection 中的 Model，以及模型明确支持时的可选思考强度。恢复默认会删除 Prompt 覆盖，而不是复制一份默认文本。两个阶段可以选择不同 Backend、Connection、Model 与思考强度；不支持或能力未知的模型不显示该控制，也不会收到相应参数。

完整链路和预处理阶段调试均可选择 catalog 中可用的 Session 与 Attention，并展示所用阶段配置。运行结果包括：

- 两个阶段及 Sandbox 提交的执行状态；
- 可丢弃的 Evidence Map；
- Agent 提交的结构化 Knowledge Contribution；
- 从 Sandbox 回读的 Knowledge Statement 列表与正文；
- 每条 Statement 的 Observation 来源、`derived_from` 和 `revises` 关系。

Coding Plan 与 API Connection 都向两个阶段提供同一模型调用契约。Observation Preprocessor 使用所选模型做一次直接调用；Knowledge Maintenance Agent 使用同一模型的 stream 接入 Pi Agent Core。Backend 决定认证和计费通道，阶段 Runtime 决定直接生成还是 Agent loop，两者不混为一个概念。

## 5. 运行边界

- 用户首次输入 API Key 时，它只经受信的 Renderer → Main IPC 用于模型发现或保存；保存后仅从系统 Keychain 读取，不写入配置文件、不回传 Renderer，也不进入 Prompt 或 Agent transcript；
- 自定义远程端点必须使用 HTTPS，HTTP 只允许 localhost；
- Agent 模型请求只允许使用阶段固定的 Connection 与 Model，API 请求拒绝重定向并限制响应大小和运行时间；
- Agent 最多进行 4 次模型调用、12 次工具调用；单次证据读取最多 200 行，单轮累计最多 400 行、98,304 个工具输出字符，并拒绝重复或重叠读取；
- Raw Observation 被视为不可信证据，其中的指令不会获得 System Prompt 权限；
- 完整链路独占两个加工阶段；取消会传播到当前模型请求和 Pi Agent，并清除未完成的 Sandbox；
- Renderer 只能提交 Session 的稳定身份和所选 catalog 版本，不能提交文件路径、选择写入 Store 或直接构造数据库写入。

当前 Model Connection 尚未保存模型上下文窗口元数据。Pi 运行时以 `contextWindow: 0` 表示未知，因此 MVP 只能通过输入大小、工具输出和调用次数限制约束本地工作量，不能在调用前保证材料适配任意模型的上下文窗口。端点明确报告 `length` 或 `incomplete` 时会拒绝不完整结果；端点静默截断则无法可靠识别。

## 6. 当前未实现

- 从 Sandbox promote、merge 或复制到正式知识库；
- 正式知识生产的自动调度、批量和流式处理；
- Canonical Activity 作为跨 Harness 的标准化 Observation 视图；
- 持久 Workspace 与作业恢复；
- Projection Agent 与投影文档生成；
- 更多消费者 Coding Plan Provider。

当前实现先验证预处理质量、渐进式披露、Agent 探索行为、Contribution 契约和隔离提交，不把测试结果混入正式知识。
