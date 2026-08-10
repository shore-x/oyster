# 通用 Agent Runtime

> 状态：当前实现规格
>
> 日期：2026-08-10

Pi Agent Runtime 负责模型—工具循环、上下文压缩、取消、错误映射和 Agent Run Recorder，不理解 Knowledge、Artifact、Knowledge Processing Run、Review marker 或 Git branch。角色由业务层提供的 `agentId`、System Prompt、工具集合、初始工作目录和任务输入定义。

Agent 使用普通文件工作面，但不要求所有 Agent 共享同一个初始目录：

- Chat Agent：从 Repository 根启动，使用普通 Coding Tools、子 Agent 与通用 Todo；
- 当前结构化知识加工中的 Maintainer 与 Reviewer：都只安装普通 `read`、`bash`、`edit`、`write`，初始 `cwd` 是本次 `runs/<run-id>/`，并根据 `TASK.md` 中的 Repository 路径访问全局 `knowledge/` 与 `artifacts/`。

Maintainer/Reviewer 不安装通用 Todo，也不使用 `read_activity`、`read_activity_attachment`、`read_evidence` 等领域专用读取工具。Maintainer 从 Run 工作空间中的 `TASK.md`、`WORK.md` 与 `inputs/` 获得任务、可变工作状态和固定 Observation；Reviewer 只读取 `TASK.md`、`WORK.md` 与 candidate revision，不读取 `inputs/`。两者通过同一组普通工具维护或审阅 Repository 中的正式产物。文件格式由工作空间内的说明文档解释，不再通过工具名称编码领域概念。

Knowledge Processing Run 与 Agent Run 不同。前者拥有一个持久的 `runs/<run-id>/`，Full Chain 可以在其中进行多轮 Maintainer/Reviewer 交接；后者是其中一次独立的模型—工具执行。每次 Agent 调用都有独立 Agent Run ID；Full Chain 会把这些 records 写入同一工作空间的终态 `run.json`，当前单阶段 Debug Run 则不生成代表完整闭环历史的 `run.json`。

`TASK.md` 与 `inputs/` 的固定性、`workspace.json` 的 manifest 校验，以及 `WORK.md` 的可变性由知识加工 Harness 负责，不属于通用 Runtime。Manifest 还绑定初始工作清单和 Run 创建时 Knowledge/Artifact 的 working-tree 指纹，使同一 Run 不能被另一份工作定义复用，并让已有修改成为显式输入；Harness 只在首个 Maintainer 启动前要求当前 working tree 与该初始指纹一致，Reviewer 与后续 Maintainer 则要求干净工作树。它不要求后续可变 `WORK.md` 或 Agent 工作中的 Repository 保持初始状态。“固定”是 Agent 启动和 handoff 必须通过的完整性不变量，不表示普通工具在 OS 层无法写入；与 manifest 不一致的状态不会被接受。Reviewer 不读取 `inputs/` 同样是 System Prompt 与传入上下文定义的审阅行为边界；当前普通文件工具共享相同 OS 权限，因此这不是 Runtime 提供的文件系统沙箱。

Maintainer 与 Reviewer 是当前结构化知识加工工作流的业务角色，不是 Artifact Domain 的全局角色。Runtime 也不把 Chat Agent 固化为 Artifact 的唯一维护者。当前 Chat 的 `spawn_agent` 是通用委派能力，可以成为具体工作流实现临时任务分工的一种方式，但不专属于 Artifact，也不由 Artifact 说明自动触发；未来其他 Artifact 维护方式仍可复用同一 Runtime 或采用不同执行机制。

Agent Run Recorder 保存稳定 `agentId`、独立 Agent Run ID、Turn、Message、Tool Call 和 Model Call。实时记录在同一 UI 窗口按 `Maintainer`、`Reviewer` 名称展示；由完整链路管理的 Knowledge Processing Run 结束后，各次 Agent Run records 随所属业务 Run 写入 `runs/<run-id>/run.json`。凭据、Header、环境变量和 Provider Payload 不进入记录。

Runtime 不提供 Repository 权限控制、并发治理、分布式 Trace 或 Git 协作状态机，也不增加固定模型轮次、工具次数或总时长配额。
