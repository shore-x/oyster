# ADR-0002：统一 Repository 与一级 Run 记录

- 状态：Accepted；已实现
- 日期：2026-08-06
- 取代：Knowledge/Artifact 分离物理存储、Contribution Draft、独立 collaboration repository、每 Run worktree 和单例 `.oyster/WORK.md`
- 关联文档：[统一 Repository、全局事实层与 Run](../architecture/unified-git-agent-collaboration.md)

## Context

Knowledge 位于 SQLite、Artifact 位于独立 Git Repository、加工又位于 collaboration repository/worktree 时，同一现实状态被拆成多套权威位置。把工作清单固定为 `.oyster/WORK.md` 又把 Run 状态误表达成单例，并暗示 Knowledge/Artifact 从属于某个 workspace。

## Decision

Oyster 只有一个标准 Git Repository 和一个物理工作树。根目录固定包含：

- `knowledge/`：全局唯一 Knowledge；
- `artifacts/`：全局唯一 Artifact；
- `runs/<run-id>/`：一级、持久的工作过程。

Run 不拥有领域文件。`WORK.md` 位于自己的 Run 目录，保存 Maintainer/Reviewer 清单与 handoff；终态 `run.json` 保存多 Agent 轨迹和结果。`runs/` 不进入候选内容 commit，Knowledge/Artifact 状态由 Git revision 区分。

所有 Agent 从 Repository 根使用普通文件工具。Maintainer 创建 Knowledge/Artifact commit；Reviewer 请求修改时创建带 Review marker 的反馈 commit，批准时不创建新 commit。Harness 验证后在 `WORK.md` 自动记录角色与精确 candidate OID。Reviewer 不 merge。

Knowledge 浏览改为直接扫描 Markdown 文件；Artifact 页面扫描统一 Repository 的 `artifacts/`；Chat Agent 也从统一根工作。SQLite Knowledge、独立 Artifact Git、独立 collaboration Git、worktree 根和专用 Knowledge CRUD 不再是当前模型。

## Consequences

- 一个路径和一个 revision 可以解释 Knowledge/Artifact 的共同状态；
- Run 历史稳定存在，同时不会伪装成领域事实或污染候选 diff；
- Maintainer、Reviewer、Chat 使用相同文件坐标，角色只由输入和能力区分；
- 不需要 workspace 副本、symlink 或跨 Store 同步；
- 并发、锁、队列、promotion 和远端治理延期到有明确需求时决定。
