# 对话 Agent MVP

> 状态：当前实现规格
>
> 日期：2026-07-29

## 1. 目的

对话 Agent 是一个用于直接验证正式知识库读写体验的极简 Agent。它接受普通对话输入，可以搜索和读取当前 Knowledge Statement，并在用户明确要求保存或修改知识时写入正式知识库。它不复用知识加工链路的 Candidate Agenda、Raw Evidence 或 Sandbox，也不承担 Observation 预处理职责。

当前实现采用 `@earendil-works/pi-agent-core` 的普通 Agent loop。Oyster 只提供 System Prompt、创建会话时固定的模型绑定和三项知识库工具，不规定固定推理步骤，也不限制模型轮次或工具调用次数。上下文增长沿用共享的 Pi 上下文压缩能力。

## 2. 工具边界

Agent 只拥有以下工具：

- `search_knowledge`：按标题和正文分页搜索正式知识库；
- `read_knowledge_statement`：按 canonical title 精确读取一条 Statement；
- `upsert_knowledge_statements`：在一次事务中按 canonical title 创建或完整替换一组 Statement。

搜索和精确读取复用 Knowledge Maintenance Agent 的实际参数定义，写入工具使用同一 Statement 标题与正文约束。Agent 配置页展示的名称、描述和可展开 JSON Schema 由这些运行时定义直接投影，不维护第二份仅供 UI 使用的工具说明。

当前写入直接作用于正式知识库，采用 MVP 已有的“同名覆盖”语义，不增加 revision、冲突裁决或关系 Schema。是否搜索、读取或写入由 Agent 根据用户请求判断；System Prompt 要求它在替换已有 Statement 前先读取，并且只有工具确认后才能声称写入成功。

## 3. 会话与配置

每个新会话在创建时固定以下执行配置：

- AI Connection；
- Model；
- 可选的 reasoning effort；
- 当时生效的对话 Agent 默认 System Prompt。

因此，修改默认 Prompt 只影响之后创建的会话，不会静默改变已有会话的语义。会话记录使用 Pi Agent Core 的 JSONL Session Repository，独立保存在 Oyster 的用户数据目录中；完整的 user、assistant 和 tool-result 消息由 Pi 格式持久化，Renderer 只接收稳定、可序列化的显示视图。

Agent 配置页把对话 Agent 与两个知识加工角色一起列出。默认 System Prompt 可以编辑或恢复为代码内置值；工具由代码拥有，在页面中只读展示。模型不是 Agent 的全局默认属性，而是在新建对话时从已有 AI Connection 及其模型目录中选择。

## 4. 界面

“对话”页面使用固定高度的双栏工作区：左侧浏览持久会话，右侧展示当前会话的模型绑定、独立滚动的消息历史和固定输入区。新会话在首次发送时才创建；仅点击“新对话”不会保存记录。若请求在进入 Pi transcript 前失败，输入会回到编辑区；已经持久化 user message 的失败或取消不会提示用户重复发送。

模型输出按事件流更新；每次工具调用显示状态，并可展开查看 Input 与 Result。Statement 正文形式的 `[[canonical title]]` 引用可以跳转到正式知识库浏览页。错误与运行状态在页面内呈现，不使用系统原生弹窗。

## 5. 当前边界

- 同一个会话同一时间只运行一个正常 Agent turn，用户可以显式停止；
- 当前没有针对知识写入的 Sandbox 或二次确认，Agent 的写入权限在页面文案和 System Prompt 中明确；
- 当前不实现 Statement revision、冲突合并、对抗式校验或多 Agent 协作；
- 当前不把对话记录重新作为 Observation 自动送入知识加工链路。

这些边界只描述 MVP 的当前行为，不定义知识层未来的治理方式。
