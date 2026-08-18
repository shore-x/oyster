# 知识加工

本文说明 Oyster 为什么把知识加工设计为 Maintainer 与 Reviewer 在 Git Task 中协作。跨功能的 Git 约束见[统一 Repository 与 Agent Git 协作](../architecture/unified-git-agent-collaboration.md)。

## 验证目标

聊天记录不能因为被摘要就自动成为 Knowledge。知识加工需要验证一条更严格的链路：用户选择的外部活动在接受时形成可核查的证据视图，Agent 能在已有 Knowledge 与 Artifact 基础上形成必要修改，独立 Reviewer 能判断结果是否自足，最终变化和当次证据能进入正式 Repository 并被回溯。

MVP 采用两个角色，不是为了建立通用多 Agent 编排框架，而是为了隔离两种必要判断：

- Maintainer 可以查看来源，负责证据忠实性、长期价值判断以及 Knowledge 与 Artifact 的整合；
- Reviewer 的职责不包含查看来源，负责检查结果本身是否清楚、一致并且可以复用。

## Source Snapshot 与 Task

当前结构化入口让用户按稳定 `sourceConversationId` 选择一份 Source Conversation，而不是选择 catalog 元数据所表示的“精确版本”。接受时，Source Adapter 读取来源当时的当前内容，并检查读取期间没有发生变化；陈旧 catalog 可以刷新后重试，只有来源在读取期间持续变化时才拒绝本次接受。成功读取的字节通过 SHA-256 形成不可变 `sourceRef`。

Adapter 随后把完整 Canonical Activity、归一化 Raw Evidence 和附件物化到一个简单 Task 目录：

```text
tasks/<taskId>/
├── task.json
├── TASK.md
└── inputs/
    ├── activity.md
    ├── evidence.txt
    └── attachments/       # 仅有附件时存在
```

Repository 协作服务由 Host 创建 Task-start revision，把这个工作面一次纳入 Git，再把 clean worktree 交给 Maintainer。`task.json` 是轻量机器定义，`inputs/` 是固定证据；后续 commit 不能改写两者。`TASK.md` 是 Maintainer 和 Reviewer 共同维护的自然语言记录，可以持续修改；它只承载待办 checklist、`## Knowledge–Evidence` 和必要交接。Maintainer 在该段记录每项实质 Knowledge 变更与 Evidence 的关系。Task 定义的其他事实从 `task.json` 和 Git 读取，通用工作规则由 Agent Prompt 提供，不在 Markdown 间重复。

这些材料在完成 Task 进入 `main` 后长期保留，使后续审计或证据核查能回答“本次加工当时可以看到什么”，同时不把 Oyster 的表示伪装成仍由外部来源拥有的最新事实。

Task 没有保存逐字节的外部 source blob；`sourceRef` 标识的是接受时读取的原始字节。人类指令已经确定为可选输入形态，但其结构化选择与加工入口尚未实现，属于后续目标。

Task 是持续的 Git 工作过程。它可以包含多轮 Maintainer → Reviewer 协作和多次 Agent Invocation；一次模型失败、重试或取消不应产生新的领域实体。Task 与 Knowledge、Artifact 共享 Git 历史，但 Task 只记录输入、进度和必要摘要，不拥有一份结果快照。

## Observation 预处理原则

Canonical Activity 的职责是为 Knowledge 与 Artifact 策展提供跨 Harness 的证据阅读面，不是复现 ReAct 轨迹，也不是预先生成 Knowledge 摘要。它应在有界内容中一致地突出：用户纠正与明确决定、公开的 Agent 结论、引用依据、工具行动及可观察结果、验证结果、Artifact 产出、错误与恢复，以及实际发生的 Skill 使用。大 payload 可以留在 Raw Evidence 并通过 locator 按需回查。

隐藏 thinking/reasoning、token 计数和能够明确识别的 Runtime 协议封装不应成为正式 Knowledge 的依据；Skill 注入等 Runtime 内容也不能伪装成用户陈述。对于未知但不能证明只是协议噪声的记录，阅读面至少应留下带 Raw locator 的 opaque marker，避免静默遗漏潜在证据。

**当前实现边界**：Source 读取、防撕裂检查、原始字节 hash、完整 Raw Evidence line model、range locator 和附件校验已经形成可靠基础。Adapter 会区分对话、工具调用、工具结果、状态与未知记录，保留原生调用关联和来源给出的错误状态；Claude 与 Pi 的 Runtime Skill 注入不作为用户陈述，Pi 的 active path 与放弃分支也不会被伪装成一段线性对话。大 payload 仍采用有界阅读表示，精确内容需按 locator 回查 Raw Evidence；跨 Harness 兼容仍需依靠真实 fixture 和版本审计持续验证。

`activity.md` 和 `evidence.txt` 都是可以用普通 `read` 按行继续读取的单文件；文件大小不再导致 Task 目录改变形状。Raw Evidence locator 的 `C` 是该物理行中从零开始的 JavaScript UTF-16 offset。当单行本身超过 `read` 工具的输出上限时，Agent 可通过 Bash 调用 Node，按行读取后用 `String.slice` 查看相应 UTF-16 范围；不能把 shell 的字节 offset 当成 `C`。这是普通 I/O 取舍，不因此引入分页、segment 或 index 概念。

## Maintainer 与 Reviewer

Maintainer 从 Task worktree 阅读证据输入、相关 Knowledge 和 Artifact，直接维护正式文件并提交变化。它应区分证据、推断与不确定性，优先修订已有内容并维护合理边界；只有经过公开结果或来源支持、对未来仍有价值的信息才应进入正式内容。用户纠正、可复现的方法、验证过的结果和需要维护的产物是强信号；一次性叙事、已经解决的瞬时环境错误和未经验证的失败尝试不应被包装成通用知识或可靠流程。

Reviewer 审阅 Task 定义、进度和完整候选 tree；Host 不向其 Prompt 注入原始 Observation，角色指令也要求它不读取 `inputs/`。这个行为层面的证据隔离是内容质量测试：如果候选内容必须依赖原始对话才能解释，说明它还不适合作为正式 Knowledge 或 Artifact。Reviewer 因此只能判断自足性、内部一致性、边界和可维护性，不能验证内容是否忠实于来源；证据核查是另一项职责。它不是权限隔离：Reviewer 使用同一组普通文件与 Shell 工具，技术上仍能读取 Task 输入。

Reviewer 要求修改时，直接在可定位的位置或统一进度记录中留下具体反馈并提交，Maintainer 在下一轮解决。Reviewer 接受内容后，把最新 `main` merge 进 Task branch，处理冲突并重新检查；它不得 rebase 或以其他方式改写既有 Task 历史。最后从主 checkout 仅以 fast-forward 方式整合最终 Task revision。Knowledge、Artifact、Review 反馈以及冲突解决等语义编辑由 Agent 完成；Repository 协作服务只创建纯机械的 Task-start commit 并验证后续 Git 结果。

两个角色当前复用同一种通用 Coding Agent 环境：每次 Invocation 都是新的 Runtime session，以 Task linked worktree 根为 `cwd`，只启用普通 `read`、`bash`、`edit`、`write` 工具，不加载外部 Agent resources、Extension、Skill 或 Host Todo。Session 和 Debug Record 位于 Repository 外；Task 的跨轮连续性来自 Git revision、`TASK.md` 与正式文件，而不是共享模型上下文。这个 worktree 是写入坐标，不是权限沙箱；Agent 仍以应用的 OS 权限运行。

Maintainer 和 Reviewer 也复用同一个 Agent 交接循环。Agent 自然停止后，Host 检查当前角色所需的 Git 事实；通过后才结束 Invocation，失败则把具体原因送回同一 Pi Session，让 Agent 在同一 Invocation 中修复。当前最多反馈两次，之后仍不满足条件则 Invocation 失败而 Task 保持 `open`。只有 Maintainer 与 Reviewer 真正交接时才创建新的 Invocation。这里不增加角色专用 finish 工具，也不把 Agent 的自然停止或口头结论当成新的业务状态。

当前执行链路保持一个简单闭环：

1. Repository 协作服务创建 Task-start revision 并校验固定输入；
2. Maintainer 把 `activity.md` 读到 EOF，必要时按 locator 回查 `evidence.txt`，搜索并维护正式内容，更新 `TASK.md` 后提交；
3. Maintainer 自然停止后，Repository 协作服务验证 clean worktree、commit 祖先关系、固定输入与 Repository tree；未通过时在同一 Session 反馈并有界重试；
4. Reviewer 在新的、按角色约束为 evidence-blind 的 Invocation 中检查候选 tree；有问题则提交可执行反馈，没有问题则把最新 `main` merge 进 Task branch、处理冲突、重新检查并从主 checkout fast-forward 整合；
5. Reviewer 每次自然停止后，Repository 协作服务验证要求修改的 commit 或批准后的精确 promotion；未通过时使用相同交接循环，最终 revision 进入 clean 的 `main` 后 Task 才完成，否则仍为 `open`。

这里不再拆出更多内容处理或专用 Git 角色：Maintainer 负责“证据是否值得进入长期内容”，Reviewer 负责“长期内容脱离证据后是否仍可用”，Repository 协作服务只承担机械边界。普通文件和 Git commit 就是两者的交接面。

## 接受与状态语义

当前 Task 只需要两个可由 Git 验证的状态：

- `open` 表示工作仍未进入正式分支，可以继续；
- `completed` 表示 Reviewer 接受的精确结果已经进入 `main`；

Task 完成后保留 branch 与进入 `main` 的正式记录，linked worktree 和该 Task 的 Runtime Session 被回收；显式放弃仍是后续生命周期设计，不在当前模型中预留无法到达的状态。

Agent Invocation 的成功、失败或取消只描述一次执行。Reviewer 说“批准”但尚未把结果整合进 `main` 时，Task 仍不是 `completed`。这使知识库和工作台能够把 `main` 作为一致的正式内容边界，不需要再解释“已完成但尚未生效”的中间状态。

## 记录边界

Git 保存理解业务变化所需的 Task 材料、协作进度以及 Knowledge/Artifact revision。`task.json` 是创建时的轻量定义，只保存来源与执行配置摘要；完成状态、结果 revision 和 changed paths 由 commit graph 重建。完整 Knowledge 可以直接从对应 revision 读取，不应再次序列化到 Task 记录。

成功 Task 的 Git 记录提供证据留存、固定输入完整性和 Task 级审计基础。Maintainer 还应在 `TASK.md` 中用自然语言记录重要 Knowledge 变更与 Raw Evidence locator 或输入 Knowledge revision 之间的关系；Git 使这份记录与它所解释的变更共同版本化。这就是当前的可溯源机制：它能被人和通用 Agent 直接阅读，但不声称是已经由机器校验的 Statement 级 provenance Schema。不新增 Knowledge version 到 Evidence 的映射数据或专用查询工具；需要理解时直接读取 `TASK.md`、其所引 locator 与 Git history。Artifact 仍遵循文件和变更集级审计边界，不在这里扩展通用内容级出处合同。

Pi Session、Agent Invocation 明细和 Debug Record 回答的是如何继续或诊断一次执行，可能包含完整上下文、工具结果和 Provider 数据。它们位于 Repository 外，不随 Task Git 历史传播。Task 完成后不依赖 Pi Session；Task 与 Preview 的 Debug Record 只服务当前进程，下一次启动清理没有持久 Chat 引用的记录。具体目录和保留边界见[应用数据](../architecture/application-data.md)。

当前归一化 Raw Evidence 仍可能包含隐藏推理、Runtime envelope、敏感文件正文、绝对路径或其他不应随 Repository 传播的信息。证据留存是核心需要，但不意味着执行引擎的全部轨迹都应永久进入 Git；在支持共享、同步或长期清理前，产品必须明确接受 Task 会复制什么、哪些内容只属于调试、删除如何影响历史，以及大附件和敏感内容的边界。

## 并发与当前边界

每个 Task 使用独立 branch/worktree，因此多个 Task 可以并行；同一 worktree 在任一时刻只交给一个写入者。用户主 checkout 的未提交内容既不阻止 Task 创建，也不会被静默纳入 Task。

**当前限制**：Renderer 与 IPC 仍以单个前台知识加工流程组织交互，取消入口可能中止进程内全部活动 Knowledge Task Invocation。按 `taskId` 独立展示、继续和取消属于后续交互设计。

**当前限制**：Task-start revision 使首次 Invocation 失败后的 Task 仍可从 Git 枚举为 `open` 并读取固定输入；但应用退出、崩溃后的自动恢复和继续入口尚未形成当前保证。

**候选方向**：通用 Chat Agent 可以在未来迁移到独立 writer worktree，让对话修改也通过 Agent 完成 Git 整合。该方案仍需验证用户如何接受变化以及如何处理冲突，目前不作为知识加工 MVP 的既定能力。
