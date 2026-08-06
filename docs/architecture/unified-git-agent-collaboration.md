# 统一 Git Repository 与 Agent 协作

> 状态：知识加工 MVP 当前实现
>
> 日期：2026-08-06

## 1. 最小模型

Knowledge 与 Artifact 是语义不同的两个文件层，但在知识加工协作中共享一个标准 Git Repository：

```text
repository/
├── knowledge/
├── artifacts/
└── .oyster/WORK.md   # 仅协作期间存在
```

Repository tree 是 Agent 可见的工作事实，commit 是不可变 handoff revision，collaboration branch 是一次尚未接纳的工作过程。Raw Evidence、Canonical Activity、Agent transcript 和运行轨迹不进入 Repository。

当前加工测试使用 Oyster 管理的 collaboration repository。现有 Knowledge 浏览、Chat Knowledge Store 和 Artifact 页面尚未整体迁移到这个 Repository；它们不是本次 MVP 的 promotion 目标。

## 2. Collaboration workspace

Harness 从目标分支 `main` 的当前 revision `B` 创建 `collaboration/<id>` 分支和独立 worktree，然后创建 `.oyster/WORK.md` 并提交初始工作清单 `W0`：

```text
main:             B
                   \
collaboration:     W0 --- M1 --- R1 --- M2 --- A
```

- `W0`：Harness 写入工作清单的初始 commit；
- `M*`：Maintainer 修改 Knowledge/Artifact 和工作清单后的 commit；
- `R*`：Reviewer 提出修改的 commit；
- `A`：Reviewer 删除工作清单形成的批准 commit。

测试运行结束时 `main` 仍停留在 `B`。批准只表示 collaboration branch 的精确 revision 通过审查，不等于 promotion 或 merge。未来如需接纳结果，应由独立于 Agent 审阅的 Harness/产品机制决定。

## 3. 文件工作清单

`.oyster/WORK.md` 是当前 MVP 唯一的显式工作状态，同时服务两个场景：

1. 单个 Agent 在一次运行中记录和完成工作；
2. Maintainer 与 Reviewer 通过 branch tree 交接未完成事项。

初始清单包含 opaque `sourceRef`、可选 Attention、按顺序执行的 `read_activity`/附件读取项和完成契约。它不得复制 Raw Evidence 正文。Maintainer 可以补充工作项；Reviewer 请求修改时必须追加至少一个未完成项。

工作清单是中间文件，不属于最终 Knowledge/Artifact tree。Reviewer 批准时必须以一个只删除 `.oyster/WORK.md` 的 commit 收尾。该文件仍可能存在于 collaboration branch 的早期历史中；当前 MVP 不为此增加 squash、history rewrite 或额外清理协议。

通用 Todo Store 与工具实现暂时保留供其他 Agent 使用，但 Maintainer 和 Reviewer 都不安装 Todo 工具。是否把 Markdown 清单确立为所有 Agent 的长期正式工作状态，留待后续验证。

## 4. Maintainer handoff

Maintainer 的初始 `cwd` 是 collaboration worktree 根。它使用 `read`、`bash`、`edit`、`write`，以及不能由文件替代的 `read_activity`、`read_activity_attachment`、`read_evidence`。

一次有效 handoff 必须满足：

- HEAD 是上一个 handoff revision 的单亲增量 commit；
- commit 至少修改一个 `knowledge/` 或 `artifacts/` 文件；
- `.oyster/WORK.md` 仍存在且没有未完成项；
- tree 中没有 `REVIEW` 标记；
- Knowledge Markdown 可解析且 canonical title 不重复；
- worktree clean；
- `main` 仍等于 collaboration base。

Maintainer 不删除工作清单，也不 merge 目标分支。

## 5. Reviewer handoff

Reviewer 在独立上下文中工作，只有 `read`、`bash`、`edit`、`write`。它不读取 Raw Evidence、Canonical Activity、Maintainer transcript 或 Todo。

需要修改时，Reviewer 在问题所在文件加入完整标记，并在工作清单追加未完成项后提交：

标记由五行组成：起始行 `<<<<<<< REVIEW`、被审内容（缺失时可以为空）、分隔行 `||||||| REVIEW COMMENT`、可执行的修改说明，以及结束行 `>>>>>>> REVIEW`。

通过时，Reviewer 验证没有标记，然后只删除 `.oyster/WORK.md` 并提交。Harness 根据这个 commit 识别 `approved`，但不修改 `main`。

## 6. Harness 职责

Harness 只处理 Agent 不能仅凭普通文件完成的编排边界：

1. 创建 branch、worktree 和初始工作清单 commit；
2. 将精确 revision 与 worktree 交给当前 Agent；
3. 在 Agent 自然结束后校验 Git 状态和 handoff；
4. 根据 Reviewer 的 changes-requested 或 approved 结果选择下一次运行；
5. 保存终态运行快照。

Harness 不维护 Contribution Draft，不复制 Reviewer issue，不代理 Agent 修改或 commit，也不在测试运行中 merge。

## 7. 当前边界

MVP 只实现单机、串行、单 collaboration branch。它不处理并发目标分支推进、远端同步、自动 rebase、复杂 merge conflict、权限治理或二进制 Review 协议。文件与 Shell 工具沿用当前高信任本机执行模型，worktree 根只是初始坐标，不是权限边界。
