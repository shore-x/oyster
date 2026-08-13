# Oyster 领域概念与执行词汇

本页只定义理解产品所需的名词。精确数据结构、路径和兼容字段由代码拥有；相关设计理由见[信息模型](knowledge-model-and-projection.md)。

## 三种信息形态

### Observation

Observation 是对外部活动或人类输入的保真记录。它可以来自 Agent Conversation，也可以来自人类编写的指令。人类指令已经确定为可选输入形态；当前结构化 Knowledge Processing 入口仍只支持 Conversation，不能据此把指令加工描述成已经实现。Observation 回答“发生了什么、输入是什么”，不把模型解释伪装成来源事实。这里的保真要求是内容不被静默改写或丢弃并且任何派生视图可以回到证据位置，不等于每种 Task 表示都必须逐字节复制外部文件。

外部来源仍拥有原始正文。Oyster 的发现 catalog 保存身份和定位信息；接受某份输入时，原始外部字节由内容引用标识，Knowledge Processing Task 会在 `inputs/activity.md`、`inputs/evidence.txt` 和可选 `inputs/attachments/` 中物化本次使用的 Canonical Activity、归一化 Raw Evidence 和附件。后两种文本是同一 Observation 的确定性表示，不是新的领域实体，也不能被描述成外部原始字节的副本。

### Knowledge

Knowledge 是 Oyster 当前接纳、可复用且可修订的理解。一个 Knowledge Statement 使用 Markdown 保存自然语言正文：第一个 H1 是它的 canonical title，正文可使用 `[[canonical title]]` 或 `[[canonical title|显示文本]]` 引用其他 Statement。

正文以自然语言为主；除普通 Markdown 和 wikilink 扩展外，不为知识表达增加新的结构化语法。当前名称表达内容身份，文件路径只是 locator。标题重命名、大小写与 Unicode 规范化以及引用迁移是未来治理能力，目前不预设方案。

正式 Knowledge 能够追溯到 Observation 或输入 Knowledge 是产品的核心目标。Task 中的固定 Evidence 提供留存基础；Maintainer 在 `TASK.md` 中用自然语言把重要 Knowledge 变更连接到具体 Raw Evidence locator 或作为直接依据的既有 Knowledge revision，Reviewer 负责保持记录自足且清楚。关系与变更一起被 Git 跟踪；当前不增加专用 provenance 实体、Knowledge version 到 Evidence 的映射存储或专用查询工具。

### Artifact

Artifact 是用户与 Agent 持续维护的实际产物，可以包含文档、配置、模板、代码、脚本、资产或完整目录。它接纳用户已经认可的编辑，不是可以随时从 Knowledge 覆盖重建的缓存。

当前一个 Artifact 是 `artifacts/` 下带有根 `AGENTS.md` 的一级目录，名字和目录表达当前身份。`AGENTS.md` 复用 Coding Agent 生态约定，说明如何维护该 Artifact；其他结构由内容需要决定。Artifact 内容不会因存在而自动成为 Knowledge，二者也可以在同一次修改中一起演进。

## 过程与界面

### Knowledge Processing Task

Task 是一次持续的知识加工和协作过程。它承载本次接受的输入、记录进度，并在自己的 Git branch/worktree 中修改同一 Repository 中的 Knowledge、Artifact 和 Task 文件。Task 目录的最小结构是不可变的机器定义 `task.json`、可变的协作记录 `TASK.md`，以及不可变的 `inputs/`；它不复制完整 Knowledge 或 Artifact 树。Host 在 Agent 开始前把它们创建为 Task-start commit。

`TASK.md` 承载 checklist、`## Knowledge–Evidence` 关系和必要 handoff；`inputs/` 只含 `activity.md`、`evidence.txt` 和可选 `attachments/`。这些文件边界表达生命周期与读取方式，不是额外的领域实体或输入类型分类。

Task 与某次模型调用不是一回事；一次 Task 可以包含多次 Agent Invocation。Task 只有在预期变化进入目标分支后才完成；具体 Git 协作见[统一 Git 协作设计](unified-git-agent-collaboration.md)。

### Chat Conversation

Chat Conversation 是用户可持续追加消息的产品对话。每条用户消息可以触发新的 Agent Invocation；对话身份不等于某个 Pi Session、Artifact 或外部来源 Conversation。

### 工作台

工作台是用户浏览并在未来维护 Artifact 的界面。它不是 Repository、Artifact 类型、Project 或 Workspace，也不拥有一份 Artifact 副本。

## 执行词汇

- **Agent Runtime**：驱动模型—工具循环、上下文和原生执行历史的执行层。它不决定 Knowledge、Task 或 Git 工作流的业务语义；
- **Agent Invocation**：对一个 Agent 定义发起的一次独立执行请求；
- **Pi Session**：当前 Runtime 对其原生执行历史的实现名称，不是 Oyster 业务实体；
- **Agent Debug Record**：用于本地检查 Invocation 的完整执行记录。它是敏感调试数据，不是新的业务历史或遥测 Trace；
- **Collaboration Round**：知识加工中 Maintainer 候选与 Reviewer 检查组成的一轮协作。它是 Task 内过程，不是通用工作流抽象。

`Turn`、`Model Call` 和 `Tool Call` 只描述 Invocation 内部活动。`Trace`、`Span` 留给未来真正的遥测系统。Oyster 不使用含义模糊的 `Run` 或 `Step` 作为领域实体。

跨进程、持久化或公共 API 中的业务身份使用含义明确的前缀字段，例如 `taskId`、`conversationId`、`invocationId` 和 `agentId`。局部 UI 列表键可以使用普通 `id`，但不能借此改变业务身份含义。

## 不作为核心名词的表达

- **attention / 关注内容**是自然语言中的普通描述。Artifact 的相关说明由根 `AGENTS.md` 承载；它没有独立 ID 或生命周期，不需要作为领域实体；
- **projection / 派生视图**是普通架构表达，指能够由正式内容重建的搜索、图或 UI 视图，不是一种信息形态；
- 外部来源的 `projectPath` 只是该 Harness 提供的位置语境。Oyster 当前不定义 Project、Collection 或 Workspace 实体。
