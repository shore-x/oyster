# Knowledge、Artifact、Run 与 Projection

> 状态：当前架构
>
> 日期：2026-08-10

## 1. 四个边界

系统区分四类事实：

1. Observation 表达外部 Agent 实际发生了什么；
2. Knowledge 表达当前可复用的理解；
3. Artifact 表达围绕持久 Attention 维护的实际产物；
4. Run 表达 Agent 如何读取、修改、审阅并形成候选 revision。

Observation 来自外部来源边界；为一次知识加工选定确定版本后，Host 会把该版本物化成 Run-local 的固定输入文件。Knowledge、Artifact 与 Run 在一个 Oyster Repository 中分别使用 `knowledge/`、`artifacts/`、`runs/`。Run 是一级过程概念，但不拥有或复制全局 Knowledge 与 Artifact。

## 2. Knowledge

`knowledge/**/*.md` 中一个文件保存一条 Knowledge Statement：

- 第一个 H1 是 canonical title，剩余 Markdown 是自足正文；
- canonical title 在一个 revision 中唯一；
- `[[canonical title]]` 或 `[[canonical title|display text]]` 表达关系；
- 文件路径是 locator，不是 Statement 身份。

Knowledge 浏览器直接扫描这一文件层。全文搜索、邻域图和引用关系是可重建 Projection，不是第二份权威 Knowledge Store。

## 3. Artifact

`artifacts/<artifact>/` 保存一个 Artifact。其根 `AGENTS.md` 表达持久 Attention，其他文件结构任意。Artifact 内容不会仅因存在而自动成为 Knowledge；一次现实修改可以在同一个 commit 中同时更新两层。

根 `AGENTS.md` 是当前 Artifact 说明，也是本地维护契约的表达载体。除持久 Attention 外，维护契约应以无固定 Schema 的自然语言表达维护目标、证据边界、质量义务和完成条件，说明维护后什么应当成立以及需要核查什么；它不必规定固定 Agent 名称、数量、调用轮次或编排拓扑。四项内容是否表达充分属于 Artifact 的内容质量，不增加文件层的有效性字段或 Schema 校验。

Artifact Domain 不定义全局 Maintainer、Reviewer 或 Critic。知识加工链路中的同名角色属于该特定 Run 的工作流，不因能够修改 `artifacts/` 就成为 Artifact 的领域角色。Artifact 可以由用户、通用 Agent、多个临时协作 Agent、面向特定任务的流程或未来其他维护方式修订；当前通用 Chat Agent 只是已经实现的一种入口，不是 Artifact 的唯一责任主体或长期所有者。

当一次维护需要相互校验时，具体流程可以依据 Artifact 的说明形成临时、任务级分工并隔离必要证据。这些分工服务于一次维护，不进入 Artifact 的身份与本体，也不限定必须由 subagent 或其他某一种执行机制实现。说明文档本身只表达质量契约；若某类 Artifact 未来需要可强制的独立审批、权限分离或 promotion，应由相应工作流及其 Run/revision 语义另行定义。

## 4. Run

当前结构化知识加工中，一个 Processing Run 使用独立、持久的 `runs/<run-id>/` 作为文件工作空间：

- `TASK.md` 保存固定任务、来源引用、Repository 位置、base revision 与完成边界；
- `inputs/README.md` 解释输入视图，`inputs/activity/`、`inputs/evidence/` 与 `inputs/attachments/` 保存选定 Observation 的固定文件表示；
- `WORK.md` 是 Maintainer 与 Reviewer 共用的可变工作状态，保存检查清单和角色明确的 handoff；
- `workspace.json` 记录 `TASK.md` 与 `inputs/` 中固定文件的路径、大小和内容 hash，绑定初始 `WORK.md` 定义，并固定 Run 创建时 Knowledge/Artifact 的 Git status、tracked working-tree diff、staged index diff，以及未跟踪普通文件或 symlink 的 Git mode 和内容指纹；Harness 在首个 Maintainer 启动前重算初始 Repository 指纹，在每次 Agent 启动和交接中校验固定 manifest 与输入文件，并拒绝用另一份任务清单复用 Run。当前可变 `WORK.md` 与 Agent 开始工作后的 Repository 不要求保持初始状态；
- `run.json` 仅由 Full Chain 在已创建工作空间后进入终态时保存配置、结果以及各次 Agent Run 的轨迹；当前单阶段 Debug Run 不生成该文件。

一次 Knowledge Processing Run 可以包含多次 Maintainer/Reviewer Agent Run。它们共享同一 `TASK.md`、固定 `inputs/`、可变 `WORK.md` 和 processing branch；每次模型—工具调用仍有独立 Agent Run ID，并在 Full Chain 的 `run.json` 中区分。

Run 通过 `TASK.md` 中的 Repository 路径和 Git commit OID 引用正式输入状态与候选内容。Knowledge 与 Artifact 始终保留在全局 `knowledge/`、`artifacts/`，不复制进 Run；Run-local Observation 文件则是这次工作的证据输入，不是新的 Knowledge/Artifact revision。

Run 记录特定工作流实际采用的角色与过程，但不要求所有 Artifact 修改都经过 Run，也不把某一工作流的角色提升为 Artifact Domain 的全局角色。未来 Artifact 维护流程可以采用不同角色、单 Agent 或非 Agent 机制，而不改变 Artifact 的领域定义。

Run 文件不是候选内容 revision 的一部分，因此工作历史能够跨 Git branch 保留。

## 5. Observation

Raw Evidence 是 Source Adapter 从外部 Harness 原始位置读取并固定的确定版本。Canonical Activity 是其确定性、可定位的对话优先语义投影：用户与 Assistant 消息以及上下文压缩形成的语义摘要保留完整正文；工具只保留操作身份并绑定调用与结果的 Raw locator，参数、结果、模型内部 reasoning、压缩记录中的 replacement history、重复传输事件、上下文快照和协议包装不进入默认正文。Codex 以 user role 记录的 AGENTS、环境、权限和运行模式信封同样不是用户对话。图片等附件从工具结果中独立提取；知识加工 Agent 通过 locator 回查由固定 Raw Evidence 行模型生成的 Run-local Evidence page，`sourceRef` 则继续绑定外部 Raw Evidence 字节与版本。

当该 Observation 被选作一次知识加工输入时，Host 将完整 Canonical Activity 分成有界 Markdown 文件，从固定 Raw Evidence 行模型确定性生成带 locator 的文本页，并将附件还原为普通二进制文件，一并物化到该 Run 的 `inputs/`。上游 `sourceRef` 绑定外部原始字节，`workspace.json` 固定物化文件自身；二者不是同一个 hash。Maintainer 用普通 `read` 扫描 Activity、查看附件并在必要时回查 Evidence；不再需要 Observation 专用读取工具。`TASK.md` 与这些输入文件由 manifest 固定；这里的固定性由 Harness 在 Agent 启动和 handoff 时校验，而不是依靠 OS 只读权限。说明文档只解释格式和证据边界，不替代 Host 的来源版本固定与完整性校验。

Reviewer 与 Maintainer 共享 Run 目录和普通工具，但其 System Prompt 明确排除 `inputs/`，使审阅只依据候选 revision 的自足性与内部一致性。当前这是一项可审计但不可强制的行为契约，不是 OS 文件权限隔离；若将来需要强制 source-blind，必须另设 Runtime 或文件系统安全边界。
