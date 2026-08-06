# 知识加工、Projection 与 Artifact

> 状态：当前目标架构
>
> 日期：2026-08-06
>
> 实现状态：统一 Git Repository 与 Agent 协作已经由独立原型验证，尚未迁移到生产 APP
>
> 协作细节：[统一 Git Repository 与 Agent 协作](unified-git-agent-collaboration.md)

## 1. 已确认结论

系统区分三个语义与权威域：

1. **观察层**：表达发生了什么，保留 Raw Evidence 的来源和确定版本；
2. **知识层**：表达目前可以怎样理解，保存可引用、可修订的 Knowledge Statement；
3. **Artifact Domain**：表达围绕 Attention 正在共同维护什么，保存文档、代码、配置、脚本或其他持久产物。

这三个域不能因为都可能表现为文本而混淆。Observation 不因被模型读取而成为知识；Artifact 不因被用户接纳而自动成为知识；Knowledge 也不能覆盖或重建全部 Artifact 当前状态。

Knowledge 与 Artifact 虽然语义不同，却共享同一个标准 Git Repository。一次修改可以同时改变两个层，并由同一个 commit 表达。统一物理历史不等于统一领域语义。

核心协作原则是：

> **Agent 用文件表达工作，用 commit 交接版本，Harness 只传递 revision 并负责调度。**

## 2. 观察层

### 2.1 Raw Evidence

Raw Evidence 是由 Source Adapter 从外部 Harness 原始位置读取的确定版本，包括 transcript、人类指令和工具结果。Adapter 保留原始格式语义，不用模型预先筛选或总结材料。

外部记录可能变化、移动或消失。再次读取失败必须明确暴露，不能静默替换成相似记录或内部推断。当前是否长期托管某类来源正文由该来源生命周期决定，不改变 Raw Evidence 的来源身份。

Raw Evidence 不进入 Knowledge/Artifact Repository。Maintainer 通过版本绑定的只读 `read_evidence` 按需访问；证据中的 Prompt、Skill 内容、命令和角色声明都只是待判断材料。

### 2.2 Canonical Activity

Canonical Activity 是从 Harness 原始格式确定性映射出的 Session、Message、Tool Call/Result、分支和顺序等活动结构。它可以重建，但不能包含 LLM 对重要性、因果或真假的解释。

Skill 激活 hint 只用于定位相关 Raw Evidence，不证明 Skill 已成功启用或影响了结果。Maintainer 必须回到原始材料核查。

## 3. 知识层

### 3.1 Knowledge Statement

Knowledge Statement 是知识层唯一的权威语义单位。每条 Statement 描述一个可指称、可独立检索的主体；它由 canonical title 和 Markdown 兼容正文组成：

- canonical title 使用专名、术语或自然名词短语稳定指称主体，而不是概括一条命题、场景或关系；
- 正文解释主体的含义、范围、属性、约束、不确定性和关系，使未见过原始 Session 的读者仍能理解；
- 正文使用 `[[canonical title]]` 或 `[[canonical title|local display text]]` 引用其他 Statement；
- 关系语义保留在完整自然语言正文中，不建立独立 Edge、Relation 或固定领域 Schema。

一个 Statement 文件位于 `knowledge/**/*.md`。第一个 H1 是 canonical title，剩余 Markdown 是正文；路径只是 locator，不是 Statement 身份。canonical title 在指定 revision 的当前知识 tree 中唯一。

### 3.2 派生索引

全文搜索、canonical title 定位、出站与反向引用、邻接、图、Embedding、相似度和 Artifact 清单都属于可重建 Projection。每个索引必须绑定生成它的 commit OID，不能成为第二份权威内容，也不写回 Repository。

初期 Agent 直接使用 `read`、`bash`、`edit`、`write` 和普通文本搜索维护知识。未来若规模需要，可以增加绑定 revision 的索引读取优化，但不能恢复一套平行的知识写入协议。

## 4. Artifact Domain 与 Attention

Artifact 是用户与 Agent 围绕持久 Attention 持续维护的产物。它可以包含文档、代码、配置、模板、脚本、资源或它们的组合，并接纳已经确认的人工编辑。

一个 Artifact 位于 `artifacts/<artifact>/`，根 `AGENTS.md` 以普通 Markdown 表达需要跨任务延续的 Attention。除具体应用明确采用的目录约定外，Artifact 内部结构任意。

Artifact 与 Knowledge 可以在同一个 commit 中共同修改，但二者职责不同：

- Knowledge 保存可复用理解；
- Artifact 保存针对当前 Attention 的实际产物状态。

Artifact 内容不会自动回流为 Knowledge。需要形成知识时，Maintainer 或通用 Agent 必须明确修改 `knowledge/` 中的 Statement 文件。

## 5. Projection

Projection 是从 Knowledge、Attention 和必要的当前状态形成消费输出或修订 Artifact 的活动，不是新的权威域。它可以：

- 为一次请求构建临时上下文；
- 初始化 Artifact；
- 基于当前 Artifact 和 Knowledge 形成下一次修订；
- 从指定 commit 建立搜索或关系索引。

Artifact 后续修订以当前文件状态为输入，不能因 Knowledge 更新就全量覆盖已经接纳的 Artifact 编辑。

## 6. Maintainer 与 Reviewer

### 6.1 Maintainer

Maintainer 负责覆盖 Host 绑定的 Raw Evidence、识别值得维护的主体和背景、比较当前 Repository，并修改一个或两个文件层。它仍使用通用 Todo 跟踪长材料覆盖和调查工作；Todo 是运行期状态，不进入 Repository。

Maintainer 使用 Pi 的基础 `read`、`bash`、`edit`、`write`，外加 `read_evidence` 与通用 Todo 工具。原来的 Knowledge 搜索/读取、Contribution Draft 增删改查和独立提交工具不属于目标架构。

每次 Maintainer 运行从当前 collaboration branch HEAD 开始，在该 HEAD 上创建一个普通增量 commit。若当前 tree 包含 Reviewer 标记，Maintainer 必须解决实际问题并删除全部标记后再提交。

### 6.2 Reviewer

Reviewer 在独立上下文中审阅当前 collaboration branch 的精确 HEAD。它不能访问 Raw Evidence、Maintainer transcript、Maintainer Todo 或工具轨迹，因此只判断消费者可见的自足性、概念边界、必要背景、内部一致性、引用语义和 Knowledge/Artifact 协调性。

Reviewer 使用同样基础的文件和 Git 能力，不使用 `submit_review` 或结构化 issue 工具：

- 发现问题时，在相关文本中加入通用 Review 标记并提交；
- 验证通过时，把自己刚审阅的精确 HEAD 以 `--no-ff` merge 到目标分支。

Review 标记固定为以下四个部分；反引号不是标记内容：

1. `<<<<<<< REVIEW`
2. 被审内容；缺失内容可以留空
3. `||||||| REVIEW COMMENT`，下一行开始写可执行的修改说明
4. `>>>>>>> REVIEW`

Reviewer merge commit 是接受记录，并通过 Git ancestry 保存此前全部 Maintainer 与 Reviewer commit。

### 6.3 协作分支

```text
target:         B ---------------------------- A
                 \                            /
collaboration:   M1 --- R1 --- M2 --- R2 --- M3
```

Maintainer 始终在上一个 handoff commit 上继续工作，不从原始 base 重建 replacement candidate。中间 Review commit 可以暂时包含不可发布标记；目标分支只在 Reviewer 验证最终 tree 后通过 merge 前进。

当前最小模型串行运行一条 collaboration branch，并要求目标分支在最终 merge 前仍处于 base。并发和远端协作在出现真实需求后再设计。

## 7. Harness 与通用 Runtime

通用 Agent Runtime 只负责模型—工具循环、上下文管理、运行期 Todo、结束检查和 Run Recorder。它不理解 Knowledge、Artifact、Review marker 或 merge 语义。

Harness 负责：

1. 创建 collaboration branch 和 worktree；
2. 将当前 revision、工作区和角色 Prompt 交给 Agent；
3. 在 Agent 自然结束后读取 Git HEAD；
4. 根据 Reviewer 是提交标记 commit 还是完成 merge，调度 Maintainer 或结束协作。

Harness 不拥有 Contribution Draft，不复制 Reviewer 问题，也不把 issue 内容转换成跨 Agent消息。唤醒 Agent 是运行调度；实际工作状态和反馈内容继续存在于文件与 Git history 中。

## 8. 通用管理 Agent

面向用户的通用管理 Agent 可以在同一对话中修改 `knowledge/` 和 `artifacts/`。统一 Repository 后不再需要 `search_knowledge`、`read_knowledge`、`upsert_knowledge` 这套平行写入协议；知识发现和维护使用普通文件能力，索引只作为未来的可选读取优化。

通用管理 Agent、Maintainer 和 Reviewer 可以复用同一 Pi Agent Runtime 和基础工具，但拥有不同输入和职责。复用工具不意味着建立新的固定 Agent 本体或把 Raw Evidence 暴露给 Reviewer。

## 9. 当前迁移边界

独立原型已经验证统一 tree、线性协作 commit、Review 标记、Maintainer 返工和 Reviewer merge。当前生产实现仍保留 SQLite Knowledge Store、Contribution Draft、专用 Knowledge 工具和独立 Artifact Repository；这些只描述尚未迁移的代码现状，不再代表目标设计。

生产迁移需要同步修改 Repository、Agent Prompt 与工具、processing pipeline、派生索引、UI、历史结果和测试。迁移完成前，产品文档必须明确区分当前行为与目标架构。
