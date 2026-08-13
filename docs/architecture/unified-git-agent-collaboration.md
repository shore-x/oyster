# 统一 Repository 与 Agent Git 协作

本文定义 Task 如何借助 Git 修改正式 Knowledge 与 Artifact。相关名词见[领域概念](terminology.md)，知识加工体验见[知识加工](../product/knowledge-processing-mvp.md)。

## 为什么统一使用 Git

一次 Task 通常同时包含预期固定的证据输入、协作进度、Knowledge 修改和 Artifact 修改。如果这些内容分别保存在数据库、临时目录和 Git 中，同一次变化会形成多套难以对齐的历史，也需要额外的快照、同步和恢复协议。

Oyster 因此只使用一个标准 Git Repository 表达正式内容和版本化工作过程：

- 已提交的 `main` revision 表达正式版本的 Knowledge、Artifact 和已经完成的 Task；
- 每个 Task 使用自己的 branch 和 linked worktree 修改同一个 Repository；
- Task 目录保存任务定义、一份协作记录和本次证据输入，但不复制完整 Knowledge 或 Artifact；
- Git revision 是内容版本边界，不再建立平行的 Knowledge Snapshot 或自定义 workspace revision。

Repository 是协作历史，不是权限沙箱。Agent 仍以应用当前 OS 用户权限工作。

## Task branch 与 worktree

Task 是一段可持续的版本化工作，而不是一次模型调用。创建 Task 时，Repository 协作服务从已提交的 `main` 建立独立 branch/worktree，物化本次接受的 Task 定义、初始协作记录和输入，并立即创建纯机械的 Task-start commit。Maintainer 从 clean worktree 和这个明确 revision 开始；之后的 Maintainer、Reviewer 和可能的多次 Agent Invocation 都在这条历史上协作。

Task-start commit 只负责记录接受时工作面，不包含 Knowledge 或 Artifact 的语义判断。它的父 revision 是 Task 创建时的 `main`；只要后续集成保留这条历史，Git graph 就能同时表达 Repository 基线和固定输入基线，无需新增 digest 或平行 anchor。Task 目录的最小合同是：

```text
tasks/<taskId>/
├── task.json
├── TASK.md
└── inputs/
    ├── activity.md
    ├── evidence.txt
    └── attachments/       # 仅有附件时存在
```

`task.json` 是 Host 需要读取的轻量机器定义，`inputs/` 是本次接受的固定证据；两者在后续历史中不可修改。`TASK.md` 是 Maintainer 和 Reviewer 共同维护的自然语言记录，从起始 commit 开始被跟踪并可以继续变化。它承载待办 checklist、`## Knowledge–Evidence` 和必要的 Maintainer–Reviewer handoff。Maintainer 在其中用普通文字、Repository 路径、Raw Evidence locator 和必要的 Git revision 记录每项实质 Knowledge 变更的依据，不再建立专用 provenance 实体或映射工具。Artifact 只保留 Task 与 Git revision 提供的文件和变更集级审计；它自身需要更细出处时，由其内容格式表达。

`activity.md` 是完整有序的 Canonical Activity 阅读面，`evidence.txt` 是以换行连接 Raw Evidence lines 得到的普通文本，附件只在不能内联到文本时作为 sidecar 保存。这些区分来自读取方式和生命周期，不是新的业务分类。不为 Activity、Evidence 预先创建分页目录或索引文件。

独立 worktree 解决的是写入坐标和并发问题：用户主 checkout、不同 Task 不需要争用同一个 working tree。它不改变 Knowledge 和 Artifact 的全局含义，也不引入 Project 或 Workspace 领域概念。

主 checkout 中尚未提交的变化不属于任何 Git revision，因此不会被 Task 静默吸收。系统不应替用户 stash、reset、clean 或猜测这些变化的归属。

## Repository 协作服务与 Agent 的职责边界

Oyster 的 Repository 协作服务负责结构和验证：

- 初始化 Repository、Task branch 和 linked worktree，物化 Task 工作面并创建 Task-start commit；
- 为 Invocation 提供正确的工作目录、模型和工具；
- 验证 Agent 已提交预期变化、历史祖先关系成立、Repository tree 有效；
- 在 Reviewer 批准后验证目标分支确实包含最终 Task revision。

Agent 负责需要语义判断的 Git 工作：

- Maintainer 阅读输入，维护 Knowledge、Artifact 和 `TASK.md`，并提交完整变化；
- Reviewer 审阅精确 revision；有问题时直接留下可执行反馈并提交；
- Reviewer 准备批准时，把最新 `main` merge 进 Task branch，处理冲突并重新检查结果，不改写既有 Task 历史；
- Reviewer 只以 fast-forward 方式把最终 Task revision 纳入 `main`。

Repository 协作服务除初始化 Repository 和创建纯机械的 Task-start commit 外，不代理 Maintainer 或 Reviewer 的语义 commit，也不替 Agent 解决 merge 冲突。冲突涉及内容意图，由能够阅读上下文的 Agent 处理更清晰；服务只验证不可协商的结构性结果。Agent Runtime 只负责模型与工具执行，不理解这套 Git 业务语义。

## Review、批准与完成

Reviewer 的角色指令要求它不读取 `inputs/`，Host 也不把 Observation 正文注入其 Prompt。它只根据 `task.json`、`TASK.md` 和候选 Repository tree 判断结果能否脱离原始对话而自我解释。`TASK.md` 可以记录哪些变更依据哪些 locator，但不复制 Evidence 正文；Reviewer 检查关系是否清楚，不因此承担证据忠实性核查。这样可以检验 Knowledge 和 Artifact 是否真正成为可复用内容，而不是只有看过来源的人才能理解的摘要。这是 Agent 行为约束，不是权限边界；Reviewer 与 Maintainer 使用相同的普通工具和 OS 权限。

要求修改时，Reviewer 在候选内容或统一协作记录中写明问题，Maintainer 继续处理。批准不是一条独立于 Git 的布尔标记，而是以下条件共同成立：

1. Reviewer 接受候选内容；
2. Task 已基于最新 `main` 处理并重新验证；
3. `main` 能够 fast-forward 到最终 Task revision；
4. Repository 协作服务验证正式分支包含该结果。

只有变化进入 `main` 后，Task 才是 `completed`。Reviewer 的口头结论、一次成功 Invocation 或停留在 Task branch 上的候选 revision 都不表示完成；其他工作保持 `open`。状态由 Task branch tip 是否已经进入 `main` 推导，而不是写进第二套状态记录。显式放弃与清理尚未形成当前生命周期。

## 并发原则

协作只需要一个通用约束：

> 同一 Repository 可以存在多个并行写入者，但同一个 worktree 同时只有一个写入者。

因此，不同 Task 可以并行；同一 Task 的 Maintainer 与 Reviewer 串行使用其 worktree。`main` 在 Task 执行期间可以继续演进，Reviewer 在批准前负责把候选变化放到最新基础上。这里不预设全局任务队列、分布式锁、租约或路径级权限系统。

## 持久化边界

Task 的 Git 记录用于理解“为什么发生这次修改”，而不是复制执行引擎的全部内部状态：

- Task 定义、初始 `TASK.md` 和业务证据输入从 Task-start commit 起版本化；完成 Task 进入 `main` 后继续保留；
- `task.json` 只保存创建时的 Task 定义与来源摘要，执行状态由 Git 历史推导；
- Knowledge 和 Artifact 结果从 Git revision 读取，不写入 `task.json` 形成完整副本；
- Pi Session 位于 Repository 外，只保存单次 Invocation 的 Runtime 上下文；Task 的跨轮交接依赖 Git 和 Task 文件；
- Agent Invocation 明细与 Debug Record 位于 Repository 外，只服务执行检查和故障诊断。

Pi Session 和 Debug Record 可能包含完整业务上下文，不应因为 Task 可审计就自动进入长期 Git 历史。它们的保留与清理属于统一调试数据治理，而不是 Task 领域模型。

Task 输入与 Knowledge/Artifact 修改共处 Git 历史，可以关联成功 Task 的证据材料与修改路径。Repository 协作服务在每次 Agent 接手前和交接后验证原始 Task-start commit 仍在历史中，且 `inputs/` 与 `task.json` 没有偏离它。Reviewer 把最新 `main` merge 进 Task branch，因此既能保留这条接受时证据基线，也不需要新增持久字段、digest 或 ref。Task changed paths 以最近一次合入的 `main` revision 为比较基线，避免把其他并行变化算作本 Task 的修改。Git 不会自动解释“某项 Knowledge 变更依据哪段证据”；Maintainer 应在 `TASK.md` 中用自然语言把 Knowledge 变更路径与 Raw Evidence locator 或输入 Knowledge revision 连接起来，Reviewer 在不读取原始 Evidence 的前提下维护该记录的清晰性。Git history 保存每个版本的关系记录，不再从 commit 共现或 blame 中猜测，也不需要另一套 Knowledge version 到 Evidence 的映射存储。

## 当前限制与候选方向

**当前限制**：UI/API 的取消入口仍按前台知识加工执行工作，可能取消进程内所有活动 Knowledge Task Invocation；它不是底层 worktree 无法并行的限制。失败或取消不应把 Task 误记为完成，但应用退出、崩溃后的完整继续流程尚未形成稳定保证。

**当前限制**：通用 Chat Agent 仍从用户主 checkout 工作。它产生的 working-tree 变化会被知识库和工作台的文件读取立即看到，但提交前不属于正式 Git revision，也不会自动成为新 Task 的基线。

**候选方向**：未来可以让 Chat 使用独立 writer branch/worktree，并由 Agent 负责 rebase 或 merge。该方向仍需结合用户编辑、接受和冲突体验验证，不是当前架构承诺。
