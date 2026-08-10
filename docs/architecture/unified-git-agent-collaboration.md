# 统一 Repository、全局事实层与 Run

> 状态：当前架构
>
> 日期：2026-08-10

## 1. 最小整体模型

Oyster 只管理一个标准 Git Repository 和一个物理工作树：

```text
<Electron userData>/repository/
├── .git/
├── knowledge/
├── artifacts/
└── runs/
    └── <run-id>/
        ├── TASK.md
        ├── WORK.md
        ├── workspace.json
        ├── inputs/
        │   ├── README.md
        │   ├── activity/
        │   ├── evidence/
        │   └── attachments/
        └── run.json                 # 仅 Full Chain 终态产生
```

根级目录表达三个一级概念：

- `knowledge/` 是全局唯一的知识事实层；
- `artifacts/` 是全局唯一的 Artifact 事实层；
- `runs/` 是 Agent 工作过程的持久工作空间与记录层；每个子目录只对应一项 Knowledge Processing 工作，不与其他任务共用工作状态。

Run 不拥有 Knowledge 或 Artifact，也不包含它们的副本。`runs/<run-id>/` 是任务与输入的文件工作空间，不是独立 Git worktree，也不是 Knowledge/Artifact 的“测试版目录”；正式内容的不同状态仍由全局工作树上的 Git revision 表达。

## 2. Repository 与 Run 的版本边界

Git commit 只表达 `knowledge/` 与 `artifacts/` 的一致内容 revision。`runs/` 由根 `.gitignore` 排除，因此切换内容 revision 不会删除工作历史，也不会把过程文件混入候选内容 diff。

一次 Run 位于 `runs/<run-id>/`：

- `TASK.md` 保存本次固定任务、Attention、来源引用、全局 Repository 路径、processing branch 与 base revision；
- `inputs/README.md` 解释文件格式和证据边界，`activity/` 保存完整 Canonical Activity 的有界 Markdown 页，`evidence/` 保存从固定 Raw Evidence 行模型确定性生成的 locator 文本页与索引，`attachments/` 保存还原后的附件文件；
- `WORK.md` 是共享的可变工作文件：加工 Agent 维护检查清单，Harness 追加带角色名称的 Maintainer/Reviewer handoff；
- `workspace.json` 是固定 manifest：记录 `TASK.md` 与 `inputs/` 中每个文件的路径、字节数和 SHA-256，记录初始 `WORK.md` 定义的 SHA-256，并保存 Run 创建时 Knowledge/Artifact 的 Git status、tracked working-tree diff 与 staged index diff 的大小和 SHA-256，以及未跟踪普通文件或 symlink 的 Git mode、大小和 SHA-256。Harness 保留其 `workspaceRevision`（manifest 内容的 SHA-256）并在 Agent 启动和角色交接时校验内容及输入文件树，防止任务、初始清单或输入静默漂移。当前 `WORK.md` 仍可由角色与 Harness 修改，不与初始 hash 比较；
- `run.json` 由完整链路在进入 completed、failed 或 cancelled 终态时产生，保存输入、配置、结果和完整 Agent Run records；一次独立阶段调试不会被伪装成已经完成的 Maintainer/Reviewer 闭环。

在创建 Run 前，Source Adapter 先选定并验证一个确定版本的 Observation。Host 随后把 Canonical Activity、由固定 Raw Evidence 行模型生成的 Evidence page 与附件物化到该 Run 的 `inputs/`。上游 `sourceRef` 绑定外部原始字节，`workspace.json` 绑定物化后文件，两者不共享 hash 身份。这份 Run-local 文件视图是本次任务的固定证据，不是另一个全局 Observation Store，也不会进入候选内容 commit。

## 3. Agent 工作坐标

当前结构化知识加工中的 Maintainer 与 Reviewer 都以自己的 `runs/<run-id>/` 为初始 `cwd`：

- 从当前目录直接读取 `TASK.md` 和 `WORK.md`；
- Maintainer 还从 `inputs/` 读取固定 Observation；
- 根据 `TASK.md` 给出的真实 Repository 路径读取和修改全局 `knowledge/`、`artifacts/`，而不是在 Run 内创建副本。

两种角色都只使用普通 `read`、`bash`、`edit`、`write`，不安装 `read_activity`、`read_activity_attachment`、`read_evidence` 等专用工具。特殊文件格式由 `inputs/README.md` 与任务文档解释。Chat Agent 仍从 Repository 根工作，并可拥有不同的通用能力。

不为 Run 创建 Git worktree、Knowledge/Artifact 副本或指向全局目录的 symlink。`TASK.md`、`workspace.json` 与 `inputs/` 的固定性是 Harness 在 handoff 时验证的接受条件，不是 OS 只读权限。Reviewer 不读取 `inputs/` 由 System Prompt 与执行上下文定义；由于当前角色共享 OS 用户和普通文件工具，这也不是文件系统级访问控制。结构化知识加工中的角色差异来自 System Prompt、任务上下文、证据边界和当前 revision，而不需要角色专用读取能力，也不为 Artifact Domain 定义全局角色。

## 4. 结构化知识加工中的 Maintainer 与 Reviewer

Harness 从 `main` 的 base revision 创建 `processing/<run-id>` 分支，选择确定版本的 Observation，并一次性创建该 Run 的 `TASK.md`、固定 `inputs/`、`workspace.json` 与初始 `WORK.md`。

Maintainer：

1. 从 Run 工作空间读取 `TASK.md`、`WORK.md`、完整 Canonical Activity、必要附件和由固定 Raw Evidence 行模型生成的 Evidence page；
2. 直接修改全局路径 `knowledge/` 与 `artifacts/`；
3. 完成清单并解决所有 `REVIEW` 标记；
4. 为 Knowledge/Artifact 变化创建一个普通单亲 commit；
5. Harness 验证后在 `WORK.md` 追加带 Maintainer 名称和 OID 的 handoff。

Reviewer 只审阅精确 candidate revision：

- 需要修改时，在实际文件写入完整 `REVIEW` block，在 `WORK.md` 增加未完成项，并为 Knowledge/Artifact 反馈创建普通 commit；
- 批准时，不创建无内容价值的 approval commit；Harness 验证后在 `WORK.md` 追加绑定精确 OID 的 Reviewer approval handoff，且不删除 `WORK.md`；
- Reviewer 永不 merge `main`。

Harness 在角色启动前校验固定 workspace、正确 processing branch 和精确输入 revision，并拒绝 Knowledge/Artifact 之外的脏文件。新 Run 的首个 Maintainer 可以从已有的 Knowledge/Artifact working-tree 修改开始；`workspace.json` 将 working tree、index 和未跟踪文件的初始状态固定为本次 Run 的显式输入，Harness 在首个 Agent 启动前重算并要求完全一致，Maintainer 再检查这些修改并将其中合理的部分纳入候选 commit。Clean gitlink 及其精确 OID 变化可以由外层 Repository revision/diff 表达；nested working tree 中无法被外层指纹唯一表达的未提交内容不进入 Run 边界。Reviewer 与后续 Maintainer 启动时要求干净工作树。若一次失败运行留下未提交内容，后续 Run 只有在自己的 manifest 中重新记录这份初始状态后才会接手，不把它当作无来源的隐藏输入。Harness 在 handoff 时再次校验 workspace、revision、干净工作树、工作清单和 Review marker，记录已验证的角色 handoff，并在 Maintainer/Reviewer 之间传递同一个 Run。

一次完整闭环只创建一个 Knowledge Processing Run。Maintainer 首轮、Reviewer、修改后的 Maintainer 以及后续 Reviewer 调用共享其固定任务、输入视图、`WORK.md` 和 processing branch；每次调用本身是独立 Agent Run，拥有独立 Agent Run ID。Full Chain 的终态 `run.json` 汇总这些 ID 及其 records，从而同时区分“哪一次业务工作”和“业务工作中的哪一次 Agent 执行”。单阶段 Debug Run 同样拥有独立工作空间，但当前不写代表完整闭环的 `run.json`。

本节只定义当前结构化知识加工的角色交接。其他 Artifact 维护可以使用不同角色、临时 subagent、单 Agent 或非 Agent 机制；只要共享 Repository，就仍服从相同的事实位置，不因此继承本节的 Reviewer approval。

## 5. 当前边界

当前定义规定统一事实位置、每次知识加工的独立文件工作空间，以及结构化知识加工现有的角色交接和 revision 语义。由于只有一个物理工作树，进程内同时只运行一个结构化知识加工角色；这是一项最小数据完整性边界，不引入队列或锁协议。它不定义 Artifact Domain 的全局维护角色，也不把 Reviewer 的 source-blind 行为提升为强制安全隔离。多进程并发写入、队列、锁、租约、远端同步、自动 rebase、复杂冲突、强文件权限隔离和 promotion 治理均留到出现明确需求后设计，不进入当前最小模型。
