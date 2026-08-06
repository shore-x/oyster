# 知识加工验证 MVP

> 状态：当前生产实现记录；目标架构已被统一 Git 协作取代，尚未迁移
>
> 日期：2026-08-06
>
> 范围：验证“外部 Session 的确定版本 → 完整 Raw Evidence 粗粒度分段 → 通用 Todo 驱动的 Knowledge Maintenance Agent → Host 冻结 Contribution → 隔离 Knowledge Sandbox 写入与回读”的最小闭环。
>
> 迁移说明：本文以下内容如实描述仍在运行的 SQLite/Contribution Draft 验证切片，不再定义下一阶段架构。目标设计见[《统一 Git Repository 与 Agent 协作》](../architecture/unified-git-agent-collaboration.md)：Knowledge 与 Artifact 共用 Repository，Maintainer/Reviewer 在同一协作分支上用文件和普通 Git commit 交接，Reviewer 用通用 `REVIEW` 标记提出问题并以 merge commit 表达接受。

## 1. 当前链路

```text
可用外部 Session 的确定 revision
  -> Source Adapter 读取完整 Raw Evidence
  -> Host 形成覆盖完整材料的粗粒度 Evidence Segment Todo
  -> Knowledge Maintenance Agent 通过一个或多个有界读取检查每段证据，并增加必要调查 Todo
  -> Agent 增量维护 Contribution Draft
  -> 所有 Todo 完成且 Agent 自然结束
  -> Host 冻结整份 Draft 为 Knowledge Contribution
  -> Oyster Core 校验并原子写入独立 SQLite Knowledge Sandbox
  -> 从 Sandbox 按 canonical title 回读 Statement
```

用户从 discovery catalog 选择 Session 及其当前 revision。主进程通过对应 Source Adapter 从原始位置读取记录，校验 revision，并以 Source Record 身份和实际内容哈希固定本次 `sourceRef`。记录变化、失效或无法读取时必须失败，不得静默换用其他版本或内部副本。

Source Adapter 不用模型缩减材料。Claude、Pi 与 Codex Adapter 均保留完整原始行和各自的格式版本。Host 根据当前模型的上下文容量，把完整材料确定性组织为较粗的 Evidence Segment；每个 Segment 作为一个 initial Todo，并列出一个或多个按顺序执行的有界 `read_evidence` 调用及预期结束位置。读取分页只限制单次工具 I/O，Segment 才是工作完成边界，因此 Todo 不随消息或工具分页一一增长，同时一次成功运行仍必须覆盖所选 Session 的全部证据。

## 2. Skill 激活线索

不同 Harness 使用不同记录格式，Skill 探测属于 Source Adapter 的 Harness-specific 能力。当前探测以下可观察信号：

- 原生 Skill 工具调用；
- 读取某个 Skill 的 `SKILL.md`；
- Harness 以结构化内容注入 Skill 指令。

Adapter 只把可得的 Skill 名称、工具名、来源类型和 Raw Evidence 位置记录为 hint。Host 将落在某个 Evidence Segment 内的 hint 附加到对应 Todo，作为不可信导航；hint 不证明激活成功、指令被遵守或输出受到了影响。

Maintainer Prompt 明确要求关注 Skill 激活，但 Agent 必须回到原始证据核查。Skill 正文、工具输出和证据中的任何指令都属于不可信材料，不能改变 Maintainer 的身份、权限或运行规则。当前不把 Skill 观测提升为知识层字段、Artifact 类型或跨 Harness 统一事件模型。

## 3. Maintainer Workspace

Knowledge Maintenance Agent 使用 Pi Agent Core 的普通 Agent loop。一次运行的 Workspace 只有以下状态：

- 完整 Raw Evidence 的只读分页访问；
- Host 绑定的粗粒度 Evidence Segment initial Todo，以及 Agent 自行增加的普通 Todo；
- 可搜索、可读取的当前 Knowledge Statement；
- 与 Todo 独立的 Contribution Draft。

通用 Runtime 只提供 `list_todos`、`add_todos` 和 `complete_todos` 三项 Todo 工具。Todo 不作为消息注入，也不在每次模型调用前重复加入上下文。Agent 自然结束时若仍有 pending Todo，Runtime 通过内部 Follow-up 告知不能结束的原因并继续同一运行。系统不设置整次运行的固定模型轮次、工具次数或总时长；用户可以显式取消，单次模型 I/O、分页读取和持久化仍遵守各自边界。

Evidence Segment Todo 要求 Maintainer 在完成前：

1. 按顺序执行该段列出的全部有界读取，并覆盖预期结束位置；
2. 识别严肃的局部名称、指代、缺失背景和疑似 Skill 激活；
3. 为仍需调查的问题增加 Todo；
4. 记录当前证据已经充分支持的 Draft 更新。

名称识别不由独立模型阶段提前完成。Maintainer 在同一知识上下文中判断一个表达是否指向现有 Statement、是否值得新增或修订、是否需要多个支撑 Statement，或是否不产生知识变更。

## 4. Contribution 与提交边界

Agent 使用 Draft 工具增量创建、读取、替换和删除候选 Statement。Todo 与 Draft 是独立状态：多个 Todo 可以支持一条 Statement，一个 Todo 可以要求多条 Statement，也可以在调查后不产生知识变化。

Maintainer 没有专用提交工具。所有 Todo 完成且 Agent 自然结束后，Host 冻结完整 Draft；独立高级调试只展示该 Contribution，不写入任何 Store。完整链路把它提交到物理隔离的 Knowledge Sandbox，并回读实际结果。运行失败或取消时丢弃 Sandbox；正式知识只有在用户从当前或历史测试结果显式导入时才发生变化。

## 5. 旧实现尚未接入 Reviewer

当前生产切片尚未接入 Reviewer。已确认目标中的 Reviewer 检查协作分支的精确 HEAD 能否在脱离原始 Session 后自我解释、引用完整且内部一致；为避免原始语境替模型补全缺失信息，它不访问 Raw Evidence、Maintainer transcript、工具轨迹或 Maintainer Todo。

Maintainer 与 Reviewer 的交接已经在独立原型中确定：Reviewer 直接在文件中加入通用 `REVIEW` 标记并提交，Maintainer 在该 commit 上继续解决；通过时由 Reviewer 创建 merge commit。旧生产切片中的 Contribution Draft 不参与这条新协作链路。

## 6. 页面与配置

“加工测试”页面提供三个工作面：

- **链路测试**：选择 Session 与可选 Attention，在 Sandbox 中运行完整 Maintainer 和提交链路；
- **历史记录**：按需读取成功、失败和取消的终态快照及 Agent Runs；只有成功结果可以显式导入；
- **高级调试**：单独运行 Maintainer，配置调试 Prompt，并查看证据段 Todo、Contribution、模型轮次与工具活动。

Agent 配置页列出真正使用通用 Agent Runtime 的 Agent，包括 Knowledge Maintenance Agent 和通用管理 Agent。Maintainer 的代码内置 Prompt、用户默认 Prompt 与加工页调试覆盖分别承担 fallback、默认和单次调试配置。Connection、Model 和思考强度只在“AI 后端”页面作为唯一 Default LLM 配置；Maintainer 每次新运行在开始时固定当时的 Default LLM 和生效 Prompt。

知识维护与对话复用通用 Agent Run 展示。Timeline 来自 Pi 的 Turn、Message 和 Tool 事件；单次 Model Call 由 `streamFn` 旁路记录，保存转换后的完整 Pi Context、模型可见工具 Schema 与最终输出，并区分 Agent 主调用和 Context Compaction。它不下探 Provider Payload，也不保存凭据、Header、环境变量或 AbortSignal。Todo 和 Contribution Draft 是业务 Workspace 状态，继续在加工页面单独展示，不进入通用轨迹模型。多个 Agent Runs 使用同一个通用选择器和详情组件，具体加工页面只决定哪些 Runs 属于同一次产品运行。

Agent Run 不是知识或审计真相，但可能包含完整原始材料。UI 必须如实提示敏感性，并按用户选择的调用展开 Context；Renderer 不获得来源路径、凭据或底层数据库写权限。

## 7. 历史与升级

加工历史使用 V5 终态 Envelope，产品运行 ID 与 Agent Run ID 相互独立。Envelope 保存输入、冻结的 Maintainer 执行绑定、`completed | failed | cancelled` 状态以及零个或多个版本化 Agent Runs；只有 `completed` 保存可导入结果，其他状态保存错误。来源读取或 Sandbox 创建提前失败时不会伪造 Agent Run，Agent 已启动后的失败和取消则保留其终态调用记录。

SQLite 继续以摘要列支持轻量列表，以单个 `payload_json` 保存按需读取的不可变详情。进入 V5 时会最后一次重建旧的开发期历史表；V5 稳定格式之后的 Schema 变化必须显式迁移，不再默认清空历史。`knowledge-processing.json` 使用 V2 格式，只保存 Maintainer Prompt 覆盖；无版本或 V1 配置直接重建为空配置，不迁移旧的阶段模型绑定。Default LLM 保存在 `ai-connections.json`。当前版本格式损坏或来自更高版本时仍明确报错。

## 8. 当前验收边界

- 三个 Harness 的 Adapter 保留完整 Raw Evidence，并能独立演进 Skill hint 探测；
- Host 生成的粗粒度 Evidence Segment Todo 无遗漏地覆盖完整 Session，读取分页不被建模为独立 Todo；
- Maintainer 通过通用 Todo 工具推进，不依赖领域专用完成状态；
- Prompt 明确要求核查 Skill 激活、名称、指代和必要背景；
- 成功结果只在 Sandbox 中自动提交，正式知识必须显式导入；
- 取消、来源版本变化、模型失败或提交失败不会留下半写入正式知识；
- 当前产品编排仍只运行一个 Maintainer，但 V5 Envelope、共享类型和历史详情支持零个或多个 Agent Runs，不把单 Agent 偶然性固化进 Runtime。
- 加工测试与对话使用同一 Agent Timeline 和 Model Call Inspector；Inspector 能查看完整 Pi Context，但不提供 Provider Payload。
