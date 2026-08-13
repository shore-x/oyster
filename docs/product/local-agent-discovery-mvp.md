# 本地 Agent 来源发现与读取

## 选择

外部 Agent 历史是 Oyster 可以读取的 Observation 来源，不是必须整体导入的数据资产。发现阶段建立轻量 catalog；用户选择来源作为加工输入时，Source Adapter 才从原始位置读取并固定本次使用的内容。

这种按需模型避免为大型外部历史维护一份容易过期的正文镜像，同时保留来源身份和重新核查的可能。Knowledge Processing 接受输入后，会在对应 Task 的 `inputs/activity.md`、`inputs/evidence.txt` 和可选 `inputs/attachments/` 中物化完整 Canonical Activity、归一化 Raw Evidence 和附件，并由 Host 通过 Task-start commit 立即纳入 Git；这是对已选择来源的按需留证，不是全量导入所有外部历史。这些文件记录当次工作，不改变外部来源的所有权。

## 来源与身份

当前 Discovery 可以识别 Claude Code、Pi 和 Codex 的 Conversation transcript 以及人类编写的 Agent 指令。人类指令已经确定为一种可选 Observation 输入形态，但当前 Knowledge Processing 的结构化选择入口仍只支持 Conversation；指令的选择与加工入口是后续目标，不应被描述成当前能力。Agent 自动生成的 memory 不作为输入来源，因为它已经是派生结果，而且当前文件不能证明历史执行实际看到的版本。

Source Conversation 的逻辑身份和物理位置分开。用户选择稳定的 `sourceConversationId`，而不是 catalog 元数据推导出的内容版本；接受时，Adapter 重新定位来源并读取当时的当前内容。Catalog 元数据陈旧时可以刷新后重试，但不能把相似记录替换成用户选择的 Conversation。

读取必须避免把变化中的文件拼成一份快照：如果来源在读取期间持续变化，本次接受失败并提示稍后重试。成功读取的字节通过 SHA-256 形成不可变 `sourceRef`，用于表达 Task 实际依据的内容。Catalog 中的大小和修改时间只服务于定位、刷新和读取防撕裂，不是领域中的内容版本，也不要求用户仅因这些元数据变化而重新确认。

Task 中保存的 Raw Evidence 是严格 UTF-8 解码后的归一化 line view，不是原始 source blob。它适合通过稳定 locator 核查内容；若外部文件消失，仅凭 Task 不能重建原始换行与编码字节并重新计算 `sourceRef`。发现模块也不把全部 Runtime、Provider 或 Debug 数据视为业务证据。

准确的 locator、版本检测、扫描上限和格式兼容由 Adapter 代码与测试维护，不上升为领域中的“元数据指纹”。

## 启动探测目标

**目标体验**是应用启动后自动探测本机 Agent 的可执行程序、配置和数据状态，并在未来扩展到其他信息。为避免各功能各自增加启动副作用，后续应设计统一的启动探测管理模块，负责调度、状态汇总与错误隔离。

正文扫描和较重读取仍应遵循用户意图与可见性。自动探测不等于启动后复制或发送所有聊天正文。

## 边界与规模

外部目录保持只读，凭据、settings 与自动 memory 不进入来源 catalog。Renderer 使用受控身份请求主进程读取，不负责理解 Harness 路径。

当前 JSON catalog、同步扫描和按需读取是早期规模取舍。只有真实数据证明需要时，才增加分页、增量索引、Worker 或数据库。正式 Knowledge 的 provenance 是上层核心承诺，但其结构不由发现模块决定。当前完整 Raw Evidence 可能带入敏感内容；长期保留、Repository 传播和删除策略仍需在上层产品合同中明确。
