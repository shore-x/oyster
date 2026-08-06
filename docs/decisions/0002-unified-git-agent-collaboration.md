# ADR-0002：使用统一 Git Repository 作为 Agent 协作事实

- 状态：Accepted
- 日期：2026-08-06
- 取代：ADR-0001 中 Knowledge/Artifact 分离物理存储、Contribution Draft 提交协议和“Git 不承担 Agent 修订工作流”的相关决定
- 关联文档：[统一 Git Repository 与 Agent 协作](../architecture/unified-git-agent-collaboration.md)

## Context

现有生产实现让 Knowledge 位于 SQLite Store、Artifact 位于独立 Git Repository，并让 Maintainer 通过专用工具维护内存 Contribution Draft。这造成两个问题：一次同时影响 Knowledge 与 Artifact 的修改无法由同一个 revision 原子表达；Agent 的普通文件工作与知识工作需要两套搜索、读写和提交协议。

Reviewer 若再通过结构化 `submit_review` 返回 verdict 与 issue，会形成第三套与 Git 平行的跨 Agent 协作状态。Harness 必须复制问题内容并重新注入 Maintainer，文件 tree 和 commit 不再是完整交接事实。

## Decision

Knowledge 与 Artifact 共享一个标准 Git Repository，分别位于 `knowledge/` 和 `artifacts/`。它们保留不同语义，但使用同一个 tree、commit 和 branch 历史。索引从指定 commit 派生，不进入 Repository。

Maintainer 与 Reviewer 使用 Pi 基础文件和 Shell 工具直接维护 Repository。不可由文件代替的 Raw Evidence 读取和运行期 Todo 继续作为外部能力；专用 Knowledge CRUD、Contribution Draft 和 `submit_review` 不进入目标模型。

一次维护使用线性 collaboration branch。Maintainer 从当前 HEAD 增量修改并提交；Reviewer 发现问题时直接在相关文本中加入通用 `REVIEW` 冲突式标记并提交；Maintainer 在该 commit 上继续修改并解决标记。Reviewer 验证通过后，把自己审阅的精确 HEAD 以 `--no-ff` merge 到目标分支。merge commit 是接受记录，并通过 ancestry 保存所有原始 Maintainer 与 Reviewer commit。

Harness 只创建协作工作区、传递 revision、调度下一个 Agent，并观察预期 merge 是否出现。它不复制 Reviewer issue，不拥有另一份 Draft，也不代替 Agent 表达工作内容。

## Consequences

### Positive

- Knowledge 与 Artifact 的耦合修改由同一个历史表达；
- Agent 使用普通文件和 Git 能力，不需要领域 CRUD 或审阅提交工具；
- Maintainer 直接在 Reviewer commit 上继续工作，交接自然且可检查；
- Reviewer 问题与 Maintainer 解决过程保留在 Git ancestry 中；
- merge commit 同时形成协作边界和 Reviewer 接受记录；
- 派生索引可以按 revision 重建，不形成第二份事实。

### Negative

- collaboration branch 的中间 commit 可以包含 Review 标记或暂时不可运行的内容；
- merge 后的历史仍可访问这些中间状态；
- 当前最小标记协议只适合文本文件；
- 当前串行模型要求目标分支在审阅完成前不发生并行推进。

这些代价在早期阶段是可接受的；不提前增加 squash/archive、二进制 review、并发 merge 或权限治理机制。
