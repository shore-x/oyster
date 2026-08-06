# 知识加工验证 MVP

> 状态：当前实现
>
> 日期：2026-08-06

## 目标

用真实 Maintainer → Reviewer 链路验证：外部 Agent Session 能被完整读取，Agent 能直接维护全局 Knowledge/Artifact，Reviewer 能独立反馈或批准，并且完整轨迹可在同一个 UI 窗口查看。

## Repository 与 Run

应用固定使用 `<Electron userData>/repository/`：

```text
repository/
├── knowledge/
├── artifacts/
└── runs/<run-id>/
    ├── WORK.md
    └── run.json
```

Knowledge 与 Artifact 全局唯一，不从属于测试或 Run。Harness 从 `main` base 创建 `processing/<run-id>`，但不创建 worktree 或副本。`WORK.md` 保存本次输入引用、Attention、读取清单和角色 handoff；`run.json` 保存终态结果与全部 Agent Run records。

## 输入读取

Source Adapter 从选定 Session revision 生成可定位的 Canonical Activity，并保留 Raw Evidence locator。Harness 沿 Activity 边界生成 `WORK.md` 清单。Maintainer 使用 `read_activity` 完整扫描活动，以 `read_activity_attachment` 检查图片，只在精确核查时调用 `read_evidence`。原始证据不复制进 Repository 或 Run。

## Maintainer

Maintainer 从 Repository 根运行普通 `read`、`bash`、`edit`、`write`，并拥有三个 Observation 只读工具。它读取指定 Run 的 `WORK.md`，直接维护 `knowledge/`、`artifacts/`，完成清单、解决 Review marker并创建一个普通 Knowledge/Artifact commit。Harness 验证后自动追加 Maintainer handoff。

## Reviewer

Reviewer 从同一个 Repository 根工作，但没有 Raw Evidence 或 Observation 工具。它审阅精确 candidate revision：

- 需要修改：在实际文件加入完整 `REVIEW` block，在 `WORK.md` 增加未完成项，并创建反馈 commit；
- 批准：验证无未完成项和 marker 后结束；Harness 在 `WORK.md` 追加绑定精确 OID 的 Reviewer approval。Reviewer 不创建 approval commit、不删除工作记录、不 merge。

## UI 与历史

运行视图在一个窗口中按 handoff 顺序展示所有 Agent Runs，并使用 `Maintainer`、`Reviewer` 名称区分。历史列表读取各 `runs/<run-id>/run.json`；成功记录包含输入、Session、两种角色配置、全部轨迹、candidate revision、变更路径及 revision 对应的 Knowledge/Artifact 视图。

## 当前边界

MVP 不定义 promotion、并发写入治理、锁、队列、远端同步、自动 rebase 或复杂冲突策略。这些问题不改变当前三个全局目录和 Run 不拥有领域文件的定义。
