# 统一 Git Repository 与 Agent 协作

> 状态：已确认目标架构，独立原型已实现
>
> 日期：2026-08-06
>
> 生产迁移状态：尚未接入当前 APP、SQLite Knowledge Store、UI 或正式 processing pipeline

## 1. 核心定义

Knowledge 与 Artifact 是语义不同的两个权威层，但它们共享同一个 Git Repository 和修订历史。一次现实中的修改可能同时改变两个层，因此不能分别提交或分别决定版本。

```text
repository/
├── knowledge/
└── artifacts/
```

Repository tree 是两个层的共同文件事实；commit 是不可变 revision；branch 是一次尚未接纳的协作过程；merge commit 是 Reviewer 接受这次协作的记录。

派生的全文搜索、引用图、反向引用、Artifact 清单和其他索引都必须从指定 commit tree 重建。它们不是第二份知识事实，也不写回 Repository。

## 2. Knowledge 与 Artifact 文件

`knowledge/**/*.md` 中每个文件保存一个 Knowledge Statement。第一个 H1 是 canonical title，剩余 Markdown 是自足正文；文件路径只负责定位，不是 Statement 身份。正文可以使用 `[[canonical title]]` 或 `[[canonical title|local display text]]` 引用其他 Statement。

`artifacts/<artifact>/` 保存一个 Artifact 的任意文件；根 `AGENTS.md` 表达需要跨任务延续的 Attention。Artifact 可以包含文档、代码、配置、脚本或资源，不因与 Knowledge 共用 Repository 而变成 Knowledge Statement。

两个层共享 revision，但不合并语义：Knowledge 解释可以怎样理解事物，Artifact 保存围绕 Attention 共同维护的产物。

## 3. 协作分支

一次结构化维护从目标分支当前 revision `B` 创建 `collaboration/<id>` 分支。Maintainer 与 Reviewer 在同一分支上交替追加 commit，而不是让 Harness 在每轮重建候选快照：

```text
target:         B ---------------------------- A
                 \                            /
collaboration:   M1 --- R1 --- M2 --- R2 --- M3
```

- `M1/M2/M3`：Maintainer 从当前 HEAD 继续修改并提交；
- `R1/R2`：Reviewer 把问题直接标记在相关文件中并提交；
- `A`：Reviewer 验证当前 HEAD 后创建的 `--no-ff` merge commit。

这条历史同时保存问题被提出的位置、Reviewer 的原始说明、Maintainer 的解决方式以及最终批准。正式目标分支的当前 tree 始终是通过审阅的完整状态；中间 Review commit 可以暂时包含不可发布的文本标记。

## 4. 文件内 Review 标记

Reviewer 使用一种项目无关的通用冲突式格式。完整块依次包含 `<<<<<<< REVIEW`、被审内容（内容缺失时可以为空）、`||||||| REVIEW COMMENT`、下一行开始的可执行修改说明，以及 `>>>>>>> REVIEW`。反引号只用于文档排版，不属于标记。

这只是提交到普通文件的文本，不是 Git unmerged index。Reviewer 应把标记放在问题实际发生或缺失内容应出现的位置；Maintainer 必须修改实际内容并删除完整标记块，不能只删除评论。

当前最小模型只覆盖文本文件。没有必要为了尚未出现的二进制审阅需求预先增加 sidecar issue、Review 数据库或专用工具。

## 5. Maintainer

Maintainer 负责读取完整 Raw Evidence、已有 Repository tree 和当前分支中的 Review 标记，维护可复用 Knowledge，并在一个逻辑修改需要时同时更新 Artifact。

最小工具集合是 Pi 的 `read`、`bash`、`edit`、`write`，外加不能由 Repository 代替的 `read_evidence` 与通用 Todo 工具。知识搜索、读取、增删改和 Draft 管理不再使用专用工具；Agent 通过普通文件和 Shell 能力完成。

Maintainer 每次运行从 Harness 传入的 revision 开始，只在当前协作分支创建增量 commit。自然结束前必须完成绑定 Todo、解决全部 Review 标记、提交完整修改并保持 working tree clean。Maintainer 不负责 merge 目标分支。

Raw Evidence、Todo、transcript 和派生索引不进入 Repository。它们是来源或运行期状态，不因知识与 Artifact 使用 Git 而变成持久内容。

## 6. Reviewer

Reviewer 在独立 Agent 上下文中审阅当前协作分支的精确 HEAD 和相对 base 的完整变化。它不能访问 Raw Evidence、Maintainer transcript、Maintainer Todo 或工具轨迹，因此只从消费者视角判断自足性、概念边界、必要背景、内部一致性、引用语义以及 Knowledge/Artifact 协调性。

Reviewer 也只使用 Pi 的基础 `read`、`bash`、`edit`、`write`：

- 有问题时，在相关文件中增加 Review 标记，创建一个普通 commit，然后结束；
- 没有问题时，确认当前 HEAD 未变化、没有遗留 Review 标记，并把该精确 HEAD 通过 `--no-ff` merge 到目标分支。

Reviewer 创建的 merge commit 就是接受记录，因此不需要 `submit_review`、结构化 verdict、review report 文件或另一套跨 Agent issue API。

## 7. Harness

Harness 只承担不能由静态文件或 Git 自己完成的调度：

1. 从目标 revision 创建协作分支和 worktree；
2. 把当前 revision 交给 Maintainer 或 Reviewer；
3. 在 Agent 自然结束后读取新的 Git 状态；
4. Reviewer 提交标记 commit 时再次调度 Maintainer；
5. 目标分支出现预期 Reviewer merge commit 时结束协作。

Harness 不复制 Reviewer 问题、不把问题转成 Prompt 字段，也不维护独立的 Contribution Draft。Agent 的工作内容在文件中，交接边界在 commit 中，Harness 只传递 revision 并选择下一个运行。

当前原型串行执行一条协作分支，并要求目标分支在 Reviewer merge 前仍位于初始 base。并发、远端同步和复杂 merge conflict 等真实需求出现后再扩展。

## 8. 当前实现与迁移

独立实现位于 `prototypes/unified-git-repository/`。当前生产代码仍使用 SQLite Knowledge Store、Contribution Draft 和专用 Knowledge 工具；这些是尚待迁移的旧实现，不再代表目标架构。

生产迁移应作为后续独立变更完成，包括统一 Repository、通用管理 Agent 工具精简、Maintainer worktree、Reviewer 运行、索引重建、UI 和历史数据边界。迁移前不得把原型文档描述成已上线产品行为。
