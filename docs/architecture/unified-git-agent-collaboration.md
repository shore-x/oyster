# 统一 Repository、全局事实层与 Run

> 状态：当前架构
>
> 日期：2026-08-06

## 1. 最小整体模型

Oyster 只管理一个标准 Git Repository 和一个物理工作树：

```text
<Electron userData>/repository/
├── .git/
├── knowledge/
├── artifacts/
└── runs/
    └── <run-id>/
        ├── WORK.md
        └── run.json
```

根级目录表达三个一级概念：

- `knowledge/` 是全局唯一的知识事实层；
- `artifacts/` 是全局唯一的 Artifact 事实层；
- `runs/` 是 Agent 工作过程的持久记录层。

Run 不拥有 Knowledge 或 Artifact，也不包含它们的副本。三层没有“正式版目录”“测试版目录”或每 Run workspace；不同内容状态由 Git revision 表达。

## 2. Repository 与 Run 的版本边界

Git commit 只表达 `knowledge/` 与 `artifacts/` 的一致内容 revision。`runs/` 由根 `.gitignore` 排除，因此切换内容 revision 不会删除工作历史，也不会把过程文件混入候选内容 diff。

一次 Run 位于 `runs/<run-id>/`：

- `WORK.md` 保存输入引用、Attention、检查清单和带角色名称的 Maintainer/Reviewer handoff；
- `run.json` 在终态保存输入、配置、结果和完整 Agent Run records；
- Run 通过 repository-relative path 和 commit OID 引用外部材料与内容 revision。

Raw Evidence 与 Canonical Activity 仍由 Observation 边界提供，不复制到 Run 或 Repository。

## 3. Agent 工作坐标

Maintainer、Reviewer 与 Chat Agent 的初始 `cwd` 都是同一个 Repository 根：

- 固定从 `knowledge/` 读取和修改 Knowledge；
- 固定从 `artifacts/` 读取和修改 Artifact；
- 加工 Agent 从 Harness 明确提供的 `runs/<run-id>/WORK.md` 读取当前工作状态。

不为 Run 创建 worktree、Knowledge/Artifact 副本或指向全局目录的 symlink。角色差异只来自 System Prompt、工具集合、输入材料和当前 revision。

## 4. Maintainer 与 Reviewer

Harness 从 `main` 的 base revision 创建 `processing/<run-id>` 分支，并创建该 Run 的 `WORK.md`。

Maintainer：

1. 读取 `WORK.md`、Canonical Activity、必要附件和 Raw Evidence；
2. 直接修改全局路径 `knowledge/` 与 `artifacts/`；
3. 完成清单并解决所有 `REVIEW` 标记；
4. 为 Knowledge/Artifact 变化创建一个普通单亲 commit；
5. Harness 验证后在 `WORK.md` 追加带 Maintainer 名称和 OID 的 handoff。

Reviewer 只审阅精确 candidate revision：

- 需要修改时，在实际文件写入完整 `REVIEW` block，在 `WORK.md` 增加未完成项，并为 Knowledge/Artifact 反馈创建普通 commit；
- 批准时，不创建无内容价值的 approval commit；Harness 验证后在 `WORK.md` 追加绑定精确 OID 的 Reviewer approval handoff，且不删除 `WORK.md`；
- Reviewer 永不 merge `main`。

Harness 校验 revision、工作清单和 Review marker，记录已验证的角色 handoff，并在 Maintainer/Reviewer 之间传递同一个 Run。

## 5. 当前边界

当前定义只规定事实位置、角色交接和 revision 语义。并发写入、队列、锁、租约、远端同步、自动 rebase、复杂冲突和 promotion 治理均留到出现明确需求后设计，不进入当前最小模型。
