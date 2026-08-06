# ADR-0002：使用统一 Git Repository 作为 Agent 协作事实

- 状态：Accepted；知识加工 MVP 已实现
- 日期：2026-08-06
- 修订：2026-08-06，采用文件工作清单；Reviewer 批准不再等于 merge
- 取代：ADR-0001 中 Knowledge/Artifact 分离物理存储、Contribution Draft 提交协议和“Git 不承担 Agent 修订工作流”的相关决定
- 关联文档：[统一 Git Repository 与 Agent 协作](../architecture/unified-git-agent-collaboration.md)

## Context

旧知识加工让 Knowledge 位于 SQLite Store、Artifact 位于独立 Git Repository，并让 Maintainer 通过专用工具维护内存 Contribution Draft。一次同时影响 Knowledge 与 Artifact 的修改无法由同一个 revision 表达，Agent 文件工作和知识工作也需要两套协议。

若 Reviewer 再通过结构化 verdict/issue 反馈，Harness 就必须复制问题并重新注入 Maintainer，形成第三套跨 Agent 状态。相反，仅传递 Git revision 又没有为“本轮还要做什么”提供简单、可见、可由单 Agent继续使用的载体。

## Decision

Knowledge 与 Artifact 在结构化知识加工中共享一个标准 Git Repository，分别位于 `knowledge/` 和 `artifacts/`。它们语义不同，但使用同一个 tree、commit 和 collaboration branch 历史。

一次协作由 Harness 从 target base 创建 branch/worktree，并通过初始 commit 加入 `.oyster/WORK.md`。该 Markdown 文件同时是单 Agent 工作清单和多 Agent 交接状态。Raw Evidence、Canonical Activity 和 transcript 不写入文件或 Repository。

Maintainer 和 Reviewer 使用普通 Coding Tools 直接修改文件并 commit。Maintainer 额外拥有 Activity/Evidence 只读工具；两者都不安装通用 Todo。Todo 实现暂时保留，等待是否把文件清单推广为所有 Agent 正式状态的后续决定。专用 Knowledge CRUD、Contribution Draft、SQLite Sandbox 和 `submit_review` 不进入知识加工协作模型。

Reviewer 请求修改时，在实际文件加入通用 `REVIEW` 标记，并在工作清单追加未完成项后 commit。Maintainer 在该 commit 上继续解决。Reviewer 通过时删除工作清单并创建一个只含该删除的 approval commit。

Approval 与 promotion 分离。知识加工测试只返回已批准的精确 revision，绝不 merge target branch；未来由独立 Harness 或产品动作决定是否接纳。这样 Reviewer 仍负责质量判断，但不隐式获得修改正式分支的职责。

## Consequences

### Positive

- Knowledge/Artifact 的耦合修改由同一个 revision 表达；
- Agent 使用普通文件与 Git，不需要平行领域写入协议；
- 工作清单对单 Agent 和跨 Agent 都可见，不需要 Runtime 消息总线；
- Reviewer 问题与 Maintainer 解决过程保留在 branch history；
- 测试、审阅和正式接纳具有清楚、独立的边界；
- Harness 只传递 revision、验证 handoff 和调度下一次运行。

### Negative

- collaboration branch 的中间 commit 可以包含 Review 标记或工作文件；
- 工作清单从批准 tree 删除后仍可能存在于早期历史；
- 当前文本 Review 协议不覆盖二进制内容；
- 现有 Knowledge 浏览、Chat 和 Artifact 页面尚未整体迁移到统一 Repository。

这些代价对当前 MVP 可接受。本阶段不增加 squash/history rewrite、并发 branch、远端同步、复杂 merge 或权限治理机制。
