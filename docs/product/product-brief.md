# Oyster Product Brief

## 产品定位

Oyster 是一个本地优先、Agent 无关的 Knowledge 与 Artifact 策展和持续维护系统。它从 Claude Code、Pi、Codex 等不同 Harness 的活动与用户提供的材料中提炼可复用理解，生产或修订真实产物，并把二者作为同一 Repository 中可继续演进的正式内容。

这里的“持续演进”指 Repository 中的 Knowledge 和 Artifact 能跨 Conversation 被补充、纠正、合并和维护；来源 Agent、负责加工的 Agent 与未来消费结果的 Agent 可以彼此不同。它不是让某个被观察 Agent 通过在线重试、多个 rollout 或 test-time scaling 改进当前任务表现。Skill 只是 Artifact 的一种消费形态，不是 Artifact 的默认目标。

对话是主要协作入口；知识库用于浏览形成的理解；工作台用于浏览和维护协作产物。三者共享同一个 Repository，但不因此成为同一种信息。

## 用户问题

Agent 的活动和结论通常散落在不同工具、会话和外部工作目录中。用户会重复解释背景、重复调查已经解决的问题，也很难判断一个结论来自哪里、是否仍然成立。聊天记录本身又不等于知识：直接复制或向量化全部历史会保留大量运行噪声，却不能自然形成可修订的长期理解。

用户还会与 Agent 共同产出文档、配置、代码、模板或 Skill。它们既不是聊天，也不是关于世界的 Knowledge，需要一个能够保留实际文件、用户编辑和 Git 历史的工作面。

## 产品承诺

Oyster 追求以下体验：

1. **发现而不吞并来源**：识别本机 Agent 活动，并将人类指令纳入可选 Observation 输入形态；系统保留来源身份，只在消费具体来源时读取必要正文；
2. **把活动加工成理解**：让 Agent 从 Observation 中维护精炼、可关联、可修订的 Knowledge，而不是把摘要自动当作事实；
3. **保留可核查出处**：Knowledge 最终应能解释依据了哪些 Observation 或输入知识。Knowledge Processing Task 把固定 Evidence、与变更共同版本化的自然语言关系记录和 Git history 作为当前机制；它是可读、可核查的线索，不声称是机器校验的 Statement 级 Schema；
4. **持续维护真实产物**：Artifact 保留任意文件形式和用户已经接纳的修改，可以由 Observation 中的经验、现有 Knowledge 或用户的新目标驱动创建和维护；
5. **让结果可被再次使用**：知识浏览、Skill 绑定以及未来的检索接口都应使用同一正式内容，而不是创建难以同步的副本。

## 设计边界

- Observation、Knowledge 和 Artifact 是三种信息形态，不是三套彼此隔离的数据库；
- Task 是一次加工或协作过程，不是第四种信息形态，也不拥有 Knowledge 或 Artifact 的副本；
- Agent 轨迹是可能的 Observation 来源，不是产品要复现、训练或优化的 Agent 本身；轨迹中的任务成败、奖励和重试次数不构成 Oyster 的 Knowledge 模型；
- Oyster 不引入 Project 或 Workspace 领域实体。外部 Harness 提供的 `projectPath` 只是来源定位和展示元数据；
- Artifact 由当前名字和目录表达身份。需要稳定重命名、引用迁移或跨设备同步时再增加治理能力；
- Agent 以当前 OS 用户权限使用普通文件、Shell 和 Git。MVP 优先信任 Agent 维护 Repository 的能力，不提前增加 selector、router、锁、路径沙箱或大量固定流程；
- AI Connection 决定认证和计费来源，Agent Runtime 决定模型—工具循环，两者不定义知识模型；
- 调试记录可以包含完整上下文和工具结果，因此不是普通日志。当前倾向保留这些本地记录；未来目标是用统一设置管理所有调试数据的保留与清理。

## 当前阶段

**当前**产品正在验证本地来源发现、对话协作、统一 Git Repository、Knowledge 加工、Artifact 工作台、外部 Skill 发现与绑定能否组成一条有价值的个人闭环。Discovery 已能识别人类指令，但 Knowledge Processing 的结构化选择入口仍只支持 Conversation；人类指令的加工入口属于已确认但尚未实现的目标。实现细节和当前可操作入口以各功能文档及代码为准。

**目标**体验包括：应用启动后自动探测本机 Agent 状态及其他可发现信息，并由一个统一的启动探测机制管理这些任务；在不增加平行映射存储的前提下，改善对 Knowledge 自然语言出处记录的阅读和核查体验。

**候选**方向包括：

- Chat Agent 也在独立 Git worktree/branch 中工作，并由 Agent 负责 merge 或 rebase；这尚未成为确定架构；
- 仅当 Artifact 根存在 `index.html` 时，工作台提供隔离的静态交互视图，并继续保留文件浏览；
- 为常见 Artifact 提供对话模板，帮助用户表达目标，但不增加绕过 Agent 的空 Artifact 创建表单；
- 通过 MCP 或其他开放接口按需提供有界上下文，而不是默认把全部知识推入每次对话。

## 非目标

当前阶段不以替代浏览器或外部 Agent Harness 为目标，也不建设多用户数据平台、企业治理系统、云同步、固定的自主 Agent 编排、全局 Artifact 类型体系或 Project 模型。它不以多 rollout、任务重试、episode reward 或测试时扩展作为知识加工闭环。安全与恢复能力会随真实风险演进，但不以未经验证的治理规则牺牲架构简洁性。
