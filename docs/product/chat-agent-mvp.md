# 通用管理 Agent MVP

> 状态：当前生产实现记录；Knowledge 工具与独立 Artifact Repository 等待统一 Git 迁移
>
> 日期：2026-08-06
>
> 迁移说明：本文以下十一项工具和分离 Store 如实描述当前生产代码。目标架构中通用 Agent 直接从统一 Repository 使用文件与 Git 能力维护 `knowledge/` 和 `artifacts/`，`search_knowledge`、`read_knowledge`、`upsert_knowledge` 不再承担权威写入协议；见[《统一 Git Repository 与 Agent 协作》](../architecture/unified-git-agent-collaboration.md)。

## 1. 目的

Oyster 只提供一个面向用户的通用管理 Agent。它既可以进行普通对话，也可以搜索、读取和维护正式 Knowledge，或直接操作文件系统中的 Artifact。Knowledge 与 Artifact 仍是不同的权威域，但不再为它们建立不同的对话 Agent、模式或 Session 类型；Agent 根据对话和当前状态判断一次任务实际涉及哪些能力。

当前实现沿用 `@earendil-works/pi-agent-core` 的普通 Agent loop，并复用 Pi Coding Agent 的基础文件与 Shell 工具。Oyster 提供模型绑定、System Prompt、工具和上下文持久化，不规定固定推理步骤，也不按 Artifact 或 Project 编排 Agent。

## 2. 常驻工具

每个 Session 始终拥有同一组十一项工具：

- `read`：读取文本文件；
- `edit`：对文件执行精确局部修改；
- `write`：创建或完整写入文件；
- `bash`：运行普通 Shell 命令；
- `search_knowledge`：按标题和正文分页搜索正式知识库；
- `read_knowledge`：按 canonical title 精确读取一条 Knowledge Statement；
- `upsert_knowledge`：在一次事务中按 canonical title 创建或完整替换一组 Knowledge Statement；
- `spawn_agent`：把一项完整任务委派给新的独立上下文通用 Agent，并将其最终回答返回当前 Agent；
- `add_todos`：向当前 Agent 运行绑定的通用 Todo 列表增加工作项；
- `complete_todos`：按 Host 分配的 ID 批量标记 Todo 完成；
- `list_todos`：读取当前运行的 pending 与 completed Todo。

工具名称、描述和参数 Schema 由运行时定义直接投影到 Agent 配置页，不维护第二份仅供 UI 使用的说明。知识写入继续采用当前 MVP 的“同名覆盖”语义，不增加 revision、冲突裁决或关系 Schema。

`spawn_agent` 创建的是一次临时 Agent 运行，而不是新的用户 Session、Agent 类型或固定角色。子运行使用空 transcript，不继承父对话历史；它复用当前模型、System Prompt、Artifact Repository 起点和同一组十一项工具，因此仍可根据委派任务使用 Knowledge、文件、Shell、Todo 或继续委派。父调用等待子运行完成，最终文本进入普通 Tool Result，子 transcript 保存在该结果的 details 中；取消父运行会沿当前委派链传播。

Agent 根据对话自行决定是否以及何时调用这些工具。Harness 不根据当前话题、Artifact 或预先识别的职责增删工具，也不引入 Artifact selector、router、专用 Git Tool、固定子 Agent 角色或预设编排模式。

### 通用 Todo 与结束检查

Todo 是当前 Agent 运行的 Host 状态，不是用户消息、业务状态机或长期知识。启动 Agent 时可以独立绑定初始 Todo，但不会把它们加入 Prompt 或 transcript，也不会在每次模型调用前注入 Todo 列表；Agent 通过 `list_todos` 按需读取。Todo 的完整 Runtime 定义见[《通用 Agent Runtime》](../architecture/agent-runtime.md)。

当 Agent 正常自然结束时，通用 Runtime 聚合所有“当前不能结束”的原因。pending Todo 是其中一种原因；如果存在原因，Runtime 通过内部 Follow-up Feedback 再次唤起 Agent。该 Feedback 在模型边界可读，但不会在 Chat UI 中伪装成用户消息。错误、取消和 aborted turn 不因此重试，也不设置固定续跑次数或总运行时长。

## 3. 文件系统、Shell 与 Git

四个 Coding 工具都以固定 Artifact Repository 根目录 `app.getPath('userData')/artifacts/` 作为初始 `cwd`。这个目录只是稳定的起点，不是 Session 绑定或访问边界；工具按 APP 当前 OS 用户的权限运行，可以使用相对路径、绝对路径或切换到 Repository 之外的目录。

MVP 不在 Harness 层增加路径限制、命令白名单、Sandbox 或 Bash 逐次审批，也不解析 Shell 命令来推断权限。文件和命令产生的修改直接作用于本机状态；取消运行不会自动撤销已经完成的操作。这个高信任执行模型不构成安全隔离，也不承诺 Agent 无法读取或修改 Oyster 管理目录之外的数据。

`bash` 的局部环境把 APP 捆绑的标准 Git CLI 放入 `PATH`，因此 Agent 可以直接使用普通 `git` 命令，不要求系统安装 Git，也不需要 Oyster 专用 Git 协议。Harness 不自动建立 branch、worktree、commit、rollback、merge 或冲突处理流程；是否使用 Git 及执行哪些 Git 操作由 Agent 根据当前任务和 Repository 状态判断。

## 4. Session 与 Artifact 发现

Session 只持有对话历史、创建时从应用 Default LLM 捕获的 Connection、Model、可选 reasoning effort，以及当时生效的用户默认 System Prompt。对话页不提供独立的模型选择；修改 Default LLM 只影响之后创建的 Session，已有 Session 继续使用其冻结 binding。Session 不绑定 Artifact、Project、Workspace 或 `cwd`，也不因为话题转向另一个 Artifact 而切分。一次对话可以不涉及 Artifact，也可以先后或同时涉及多个 Artifact。

Harness 不保存“当前 Artifact”，不注入 Artifact 清单，不自动加载某个 `AGENTS.md`，也不按目录切换工具。Agent 在需要时从 Repository 当前文件系统状态中发现相关 Artifact，并读取每个相关一级目录根部的 `AGENTS.md` 以理解其持久 Attention。Artifact 仍遵循 Repository MVP 的最小契约：带可读取的普通根 `AGENTS.md` 的可见一级目录是一个 Artifact，其他内部结构任意。

同一个 Session 的 turn 仍按顺序执行，以保持 transcript 一致；除此之外，MVP 不建立 Artifact 级锁或跨 Session 调度。多个 Session 若同时操作同一文件，结果就是普通共享文件系统与共享 Git working tree 的并发结果。

## 5. System Prompt

System Prompt 只提供 Agent 无法从工具本身得知的必要环境事实，不加入允许/禁止清单、权限说明、工作流、角色切换规则或工具使用原则。代码内置指令只定义通用身份和 Knowledge Statement 的最小语义：

```text
You are Oyster's general Agent.

Oyster's Knowledge Store contains Knowledge Statements. Each Statement has a
canonical title naming an independently searchable subject and a self-explaining
free-text body. Statement bodies may reference related Statements as
[[canonical title]].
```

每轮再追加当前的环境事实：

```text
Oyster's Artifact Repository is located at:
<absolute repository path>

Filesystem and shell relative paths start from this directory. It is a standard
Git Repository. Each visible first-level directory containing a root AGENTS.md
file is an Artifact, and that file contains the Artifact's persistent Attention.
Other internal structure is arbitrary. No Artifact is preselected.
```

绝对 Repository 路径由 Core 在运行时提供。Oyster 不使用 Pi 默认的祖先目录或全局 `AGENTS.md` / `CLAUDE.md` 自动发现逻辑，也不把所有 Artifact 的 Attention 预先塞入上下文；相关性判断和读取行为由通用 Agent 完成。工具的具体能力通过工具定义提供，不在 System Prompt 中重复。

## 6. 界面与持久化

“对话”页面继续使用一套持久 Session 和消息界面。新 Session 在首次发送时创建；若 AI 后端页面尚未配置 Default LLM，创建会被明确阻止。完整的 user、assistant 和 tool-result 消息使用 Pi JSONL Session Repository 保存在 Oyster 用户数据目录中。

每次发送同时形成一个通用 Agent Run。Run 通过不参与模型 Context 的 Pi Custom Entry 绑定到 Session，实时更新和历史回读使用与加工测试相同的 Timeline：普通消息、折叠 Thinking、工具状态及可展开的 Input/Result 均来自 Pi 事件。点击 Assistant 消息可定位具体 Model Call，并查看该次调用转换后的完整 Pi Context 与输出；Context Compaction 作为独立调用显示。该检查只到 Pi 层，不包含 Provider Payload、凭据或请求 Header。

Agent 配置页展示实际使用通用 Agent Runtime 的 Agent，包括面向用户对话的通用管理 Agent 和 Knowledge Maintenance Agent，并投影各自实际工具。用户可以编辑或恢复 Agent 的默认 System Prompt；工具由代码拥有，在页面中只读展示。Artifact 页面可以通过普通对话入口帮助用户描述目标，但不创建隐藏绑定或不同类型的 Session。子 Agent 运行不进入 Session 列表，其内部 transcript 只随父 Session 的 `spawn_agent` Tool Result 保存。

## 7. 当前边界与验证重点

当前 MVP 明确采用：

- 一个通用管理 Agent，而不是知识对话 Agent 与 Artifact 维护 Agent 两套身份；
- 所有 Session 常驻同一组 Knowledge、文件、Shell、Todo 和通用子 Agent 工具；
- 固定 Artifact Repository 根作为工具初始坐标，但不作为权限边界；
- 由 Agent 自主发现零个、一个或多个相关 Artifact；
- 最小环境事实 Prompt，不在 Harness 中编码语义路由和权限策略。

首要验证场景包括：纯知识对话不需要接触 Artifact；对话从知识讨论自然进入一个 Artifact；同一 Session 转向或比较多个 Artifact；只给出关注点时 Agent 能从目录与 `AGENTS.md` 找到目标；同一轮同时维护 Artifact 与 Knowledge；任务需要时可以使用普通 Git 和 Repository 外文件；Agent 可以把适合独立上下文处理的任务委派给临时子 Agent，并继续使用其返回结果。

当前仍不实现 Statement revision、正式 Artifact 依赖图、稳定 Artifact ID、自动 Projection 调度、自动 Git 工作流或对抗性盲审 Skill。通用 `spawn_agent` 只提供委派机制，不预设盲审或其他专用流程。这些缺失不通过 Session 绑定、隐藏 router 或权限规则提前补偿，而由真实使用结果决定后续是否需要新的机制。
