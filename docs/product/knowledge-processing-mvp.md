# 知识加工验证 MVP

> 状态：当前实现
>
> 日期：2026-08-06
>
> 范围：验证“确定 Session revision → Canonical Activity/Raw Evidence → 文件工作清单 → Maintainer/Reviewer Git commit 交接 → 已批准但未合并 revision”的最小闭环。

## 1. 完整链路

```text
外部 Session revision
  → Source Adapter 读取 Raw Evidence 并生成 Canonical Activity
  → Harness 创建 collaboration branch/worktree
  → 初始 commit 写入 .oyster/WORK.md
  → Maintainer 读取活动并修改 Knowledge/Artifact，commit
  → Reviewer 审阅精确 revision
      ├─ 请求修改：REVIEW 标记 + 未完成清单项，commit → Maintainer
      └─ 批准：删除工作清单，commit → 结束
  → 保存 approved revision；main 保持不变
```

测试运行不会写入现有 SQLite Knowledge Store，也没有“导入 Sandbox”操作。

## 2. Observation 输入与确定性降噪

用户选择 discovery catalog 中一条 Session 及其当前 revision。Source Adapter 从原始位置读取并校验版本，产生：

- Raw Evidence：保留原始行、格式版本和可选 Skill hint；
- Canonical Activity：确定性、可回查、去除表示噪音的完整活动视图；
- Attachment：Base64 不进入文本上下文，图片由独立工具读取。

Canonical Activity 合并完全重复镜像、过滤正常遥测、摘要不可读加密 payload，并为每项活动保留 Raw locator。未知记录作为 opaque activity 保留。该预处理不使用模型判断内容价值，因此不能替代 Raw Evidence 的最终核查权。

Harness 根据模型 context window 沿 Activity 边界组织较粗的读取项。只有单个 Activity 过大时才按 offset 续页；分页是 I/O 边界，不是独立工作状态。

## 3. 工作清单

Harness 把读取计划写入 `.oyster/WORK.md` 并创建初始 commit。文件包含 opaque `sourceRef`、可选 Attention、按顺序执行的 Activity/Attachment 调用和完成契约，不包含 Raw Evidence 正文。

Maintainer 把它作为单 Agent 工作状态；Reviewer 把它作为跨 Agent 交接的一部分。Maintainer 结束前必须完成所有 checkbox。Reviewer 请求修改时必须追加未完成项；批准时必须删除该文件。

Todo Store 和工具代码暂时保留，但 Maintainer/Reviewer 的 runtime 都不安装 Todo 工具。是否将 Markdown 清单推广为其他 Agent 的长期正式状态不在本 MVP 中决定。

## 4. Agent 与工具

Maintainer 的 `cwd` 是真实 worktree 根，工具为：

- `read`、`bash`、`edit`、`write`；
- `read_activity`、`read_activity_attachment`、`read_evidence`。

它通过普通文件搜索和编辑维护 `knowledge/`、`artifacts/`，不使用 Knowledge CRUD、Contribution Draft 或提交工具。

Reviewer 在新的 Agent 上下文中运行，只有四个 Coding Tools。它看不到 Raw Evidence、Canonical Activity、Maintainer transcript 或工具轨迹，只审阅 Repository tree、diff 和工作清单。

## 5. Git handoff 校验

每个 Agent 必须从输入 revision 创建一个单亲增量 commit并保持 worktree clean。Harness 还校验：

- Maintainer 修改了 `knowledge/` 或 `artifacts/`；
- Maintainer 没有删除工作清单，且所有清单项已完成；
- Maintainer tree 没有 Review 标记，Knowledge Markdown 可解析；
- changes-requested Reviewer commit 含完整 Review 标记和未完成清单项；
- approved Reviewer commit 只删除工作清单；
- `main` 始终等于运行开始时的 base revision。

## 6. 页面与配置

“加工测试”页面提供：

- 链路测试：运行 Maintainer/Reviewer 完整协作并显示 worktree、branch、base/work-order/approved revision、运行次数、变更文件和最终 Knowledge；
- 历史记录：读取终态快照和全部 Agent Runs；成功结果保持未合并，没有导入按钮；
- 高级调试：单独运行 Maintainer，查看 Git handoff 和 Agent 调用轨迹。

“Agent 配置”列出 Maintainer、Reviewer 和 Chat Agent。前两者分别展示 7 个和 4 个工具，均不含 Todo。Default LLM 仍由“AI 后端”统一配置；每次运行冻结自己的 stage Prompt 与模型绑定。

## 7. 历史

加工历史使用 V6 终态 Envelope，保存输入、Session 摘要、Maintainer/Reviewer 配置、零个或多个终态 Agent Runs，以及成功时的 collaboration workspace 和 approved revision。

成功记录必须引用全部 Agent Runs，最后一个 Reviewer 结果必须为 `approved` 且 revision 等于 `approvedRevision`。列表只保存轻量摘要；完整 tree 结果与调用轨迹按需读取。Schema 4 到 5 只提升数据库版本，旧开发期 Schema 可重建。

## 8. 当前非目标

- 不 merge 或 promotion 到 `main`；
- 不把 collaboration result 同步到现有 Knowledge/Artifact 页面；
- 不建立 Contribution Draft、SQLite Sandbox、结构化 review report 或专用 Git 工具；
- 不处理并发、远端、自动 rebase、复杂冲突、权限治理或二进制 Review；
- 不把工作清单确立为所有 Agent 的最终通用状态协议。
