# 知识加工验证 MVP

> 状态：当前实现规格
>
> 日期：2026-08-05
>
> 范围：验证“外部 Session 的确定版本 → 完整 Raw Evidence 分页 → 通用 Todo 驱动的 Knowledge Maintenance Agent → Host 冻结 Contribution → 隔离 Knowledge Sandbox 写入与回读”的最小闭环。

## 1. 当前链路

```text
可用外部 Session 的确定 revision
  -> Source Adapter 读取完整 Raw Evidence
  -> Host 确定性分页，每页绑定为一个 initial Todo
  -> Knowledge Maintenance Agent 逐页读取证据并增加必要调查 Todo
  -> Agent 增量维护 Contribution Draft
  -> 所有 Todo 完成且 Agent 自然结束
  -> Host 冻结整份 Draft 为 Knowledge Contribution
  -> Oyster Core 校验并原子写入独立 SQLite Knowledge Sandbox
  -> 从 Sandbox 按 canonical title 回读 Statement
```

用户从 discovery catalog 选择 Session 及其当前 revision。主进程通过对应 Source Adapter 从原始位置读取记录，校验 revision，并以 Source Record 身份和实际内容哈希固定本次 `sourceRef`。记录变化、失效或无法读取时必须失败，不得静默换用其他版本或内部副本。

Source Adapter 不用模型缩减材料。Claude、Pi 与 Codex Adapter 均保留完整原始行和各自的格式版本；Host 使用统一的有界读取原语确定性分页。每个分页 Todo 包含精确的 `read_evidence` 调用和预期结束位置，因此一次成功运行必须覆盖所选 Session 的全部证据，而不依赖模型自行决定是否继续。

## 2. Skill 激活线索

不同 Harness 使用不同记录格式，Skill 探测属于 Source Adapter 的 Harness-specific 能力。当前探测以下可观察信号：

- 原生 Skill 工具调用；
- 读取某个 Skill 的 `SKILL.md`；
- Harness 以结构化内容注入 Skill 指令。

Adapter 只把可得的 Skill 名称、工具名、来源类型和 Raw Evidence 位置记录为 hint。Host 将落在某个证据页内的 hint 附加到对应 Todo，作为不可信导航；hint 不证明激活成功、指令被遵守或输出受到了影响。

Maintainer Prompt 明确要求关注 Skill 激活，但 Agent 必须回到原始证据核查。Skill 正文、工具输出和证据中的任何指令都属于不可信材料，不能改变 Maintainer 的身份、权限或运行规则。当前不把 Skill 观测提升为知识层字段、Artifact 类型或跨 Harness 统一事件模型。

## 3. Maintainer Workspace

Knowledge Maintenance Agent 使用 Pi Agent Core 的普通 Agent loop。一次运行的 Workspace 只有以下状态：

- 完整 Raw Evidence 的只读分页访问；
- Host 绑定的证据页 initial Todo，以及 Agent 自行增加的普通 Todo；
- 可搜索、可读取的当前 Knowledge Statement；
- 与 Todo 独立的 Contribution Draft。

通用 Runtime 只提供 `list_todos`、`add_todos` 和 `complete_todos` 三项 Todo 工具。Todo 不作为消息注入，也不在每次模型调用前重复加入上下文。Agent 自然结束时若仍有 pending Todo，Runtime 通过内部 Follow-up 告知不能结束的原因并继续同一运行。系统不设置整次运行的固定模型轮次、工具次数或总时长；用户可以显式取消，单次模型 I/O、分页读取和持久化仍遵守各自边界。

证据页 Todo 要求 Maintainer 在完成前：

1. 执行该页指定的有界读取；
2. 识别严肃的局部名称、指代、缺失背景和疑似 Skill 激活；
3. 为仍需调查的问题增加 Todo；
4. 记录当前证据已经充分支持的 Draft 更新。

名称识别不由独立模型阶段提前完成。Maintainer 在同一知识上下文中判断一个表达是否指向现有 Statement、是否值得新增或修订、是否需要多个支撑 Statement，或是否不产生知识变更。

## 4. Contribution 与提交边界

Agent 使用 Draft 工具增量创建、读取、替换和删除候选 Statement。Todo 与 Draft 是独立状态：多个 Todo 可以支持一条 Statement，一个 Todo 可以要求多条 Statement，也可以在调查后不产生知识变化。

Maintainer 没有专用提交工具。所有 Todo 完成且 Agent 自然结束后，Host 冻结完整 Draft；独立高级调试只展示该 Contribution，不写入任何 Store。完整链路把它提交到物理隔离的 Knowledge Sandbox，并回读实际结果。运行失败或取消时丢弃 Sandbox；正式知识只有在用户从当前或历史测试结果显式导入时才发生变化。

## 5. Reviewer 方向

未来的 Reviewer 与 Maintainer 对应，目标是检查冻结 Draft 和相关知识能否在脱离原始 Session 后自我解释、引用完整且内部一致。为避免原始语境替模型补全缺失信息，Reviewer 不访问 Raw Evidence、Maintainer transcript、工具轨迹或 Maintainer Todo。

Reviewer 尚未接入当前链路。Maintainer 与 Reviewer 的外层交接、问题表示和重新维护循环仍待设计；通用 Todo 只管理单次 Agent 内部工作，不承担跨 Agent 协议。当前也不增加第二个长上下文证据审查 Agent；证据支持、限定和覆盖由读取完整 Raw Evidence 的 Maintainer 负责。

## 6. 页面与配置

“加工测试”页面提供三个工作面：

- **链路测试**：选择 Session 与可选 Attention，在 Sandbox 中运行完整 Maintainer 和提交链路；
- **历史记录**：按需读取成功运行的不可变结果与有界 Debug Trace，并可显式导入；
- **高级调试**：单独配置和运行 Maintainer，查看证据段 Todo、Contribution、模型轮次与工具活动。

Agent 配置页列出真正使用通用 Agent Runtime 的 Agent，包括 Knowledge Maintenance Agent 和通用管理 Agent。Maintainer 的代码内置 Prompt、用户默认 Prompt 与加工页调试覆盖分别承担 fallback、默认和阶段配置；实际运行固定当次生效的 Connection、Model、思考强度和 Prompt。

Debug Trace 只保存有界的模型与工具事件副本，不是知识或审计真相。它可能包含原始材料，UI 必须如实提示敏感性。Renderer 不获得来源路径、凭据或底层数据库写权限。

## 7. 历史与升级

成功链路记录使用当前 V3 payload，只保存 Maintainer 配置、结果、Sandbox 写入结果和一份共享 Debug Trace。历史 SQLite schema 升级时直接删除并重建旧表，不迁移旧记录。`knowledge-processing.json` 使用显式格式版本；单 Maintainer 链路之前的无版本配置会直接重建为空配置，由用户重新选择 Maintainer 的 Connection 和 Model，不解释或迁移旧阶段。当前版本格式损坏或来自更高版本时仍明确报错。当前阶段优先保证概念和数据结构一致，不维护旧格式兼容分支。

## 8. 当前验收边界

- 三个 Harness 的 Adapter 保留完整 Raw Evidence，并能独立演进 Skill hint 探测；
- Host 生成的证据页 Todo 无遗漏地覆盖完整 Session；
- Maintainer 通过通用 Todo 工具推进，不依赖领域专用完成状态；
- Prompt 明确要求核查 Skill 激活、名称、指代和必要背景；
- 成功结果只在 Sandbox 中自动提交，正式知识必须显式导入；
- 取消、来源版本变化、模型失败或提交失败不会留下半写入正式知识；
- UI、共享类型、IPC、历史记录和文档只呈现单 Maintainer 链路。
