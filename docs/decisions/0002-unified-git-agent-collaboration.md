# ADR-0002：统一 Repository、tracked Task 与独立 worktree

- 状态：Superseded（历史记录）
- 日期：2026-08-06
- 取代：Knowledge/Artifact 分离存储、Git 外 Task sidecar、单一共享 working tree 和全局 Agent 串行门禁
- 后续演进：当前 Agent 自主 commit、Reviewer 负责 Repository 整合以及执行数据位于 Repository 外的边界，见[统一 Repository 与 Agent Git 协作](../architecture/unified-git-agent-collaboration.md)

## Context

Knowledge、Artifact 与一次加工过程如果分别保存在不同数据库、临时目录和 Git Repository 中，同一次业务变化就会形成多套难以对齐的历史。让 Chat、用户编辑和多个 Knowledge Task 共用一个 working tree，又会造成写入相互污染，并迫使应用增加大量 dirty-tree 特例。

## Decision

Oyster 采用一个标准 Git Repository 保存 Knowledge、Artifact 与可审计的 Task 材料。每个 Knowledge Processing Task 使用独立 branch 和 Repository 外的 linked worktree，在同一 Git 历史中固定输入、记录协作过程并修改正式内容。

这项决定解决的是内容版本边界和并发写入坐标，不建立 Knowledge 或 Artifact 副本，也不引入 Project、Workspace 或通用工作流实体。

## Why

统一 Repository 让一个 revision 能够同时解释 Task 输入、Knowledge 修改和 Artifact 修改。独立 worktree 则允许不同 Task 并行，同时避免自动吸收用户主 checkout 中尚未提交的内容。两者都复用标准 Git 与 Coding Agent 已有能力，不需要另建同步协议或专用领域写入系统。

## Consequences

- Knowledge、Artifact 与 Task 过程可以使用同一 commit graph 回溯；
- 多个 Task 可以拥有独立工作坐标，用户主 checkout 不再是结构化加工的共享写入面；
- Task 材料会随业务修改进入 Git 历史，需要与仅供执行和调试的数据保持边界；
- Task 如何提交、审阅、整合以及何时完成已经继续演进，本 ADR 不再定义这些执行语义。

本文只保留采用统一 Repository 与 linked worktree 的理由。当前规则由架构文档定义，不能从本记录中的历史选择推导当前实现。
