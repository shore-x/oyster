# Unified Git Agent Collaboration Prototype

这个独立原型验证一项统一模型：Knowledge 与 Artifact 共享一个标准 Git Repository；Maintainer 与 Reviewer 只通过文件 tree 和普通 Git commit 交接工作；Harness 只传递 revision 并调度下一个 Agent。

它不接入当前 APP、SQLite Knowledge Store、UI 或正式 processing pipeline。Agent 原型复用现有 Pi Agent loop、模型 Runtime、Coding tools 和 Maintainer Todo，但没有修改生产 Agent。

## 文件事实

```text
repository/
├── .git/
├── knowledge/
│   └── any-locator.md
└── artifacts/
    └── <artifact>/
        ├── AGENTS.md
        └── ...
```

- `knowledge/**/*.md` 中每个文件保存一个 Knowledge Statement；第一个 H1 是 canonical title，其余 Markdown 是正文，路径只是 locator。
- `artifacts/<artifact>/AGENTS.md` 表达该 Artifact 的持久 Attention；其余结构任意。
- 引用、未解析引用、Artifact 清单等索引从指定 commit 的 tree 重建，不写回 Repository。

## 线性协作分支

Harness 从当前 `main` 创建一条 `collaboration/<id>` 分支和 worktree。Maintainer 与 Reviewer 依次在这条分支上工作：

```text
main:          B ---------------------------- A
                \                            /
collaboration:  M1 --- R1 --- M2 --- R2 --- M3
```

- `M*` 是 Maintainer 对当前 HEAD 的增量修改 commit。
- `R*` 是 Reviewer 在原文件中加入 Review 标记的 commit。
- `A` 是 Reviewer 验证通过后创建的 `--no-ff` merge commit，也是接受记录。

协作不重建 replacement candidate，也不把 Reviewer feedback 保存为独立 Runtime 对象。每个 Agent 从上一个 handoff commit 继续工作；merge commit 保留全部 Maintainer 与 Reviewer 原始 commit。

## Review 标记

Reviewer 发现问题时直接修改受影响的文本，并使用不包含项目名称的通用格式。完整块依次包含 `<<<<<<< REVIEW`、被审内容、`||||||| REVIEW COMMENT`、下一行开始的可执行修改说明，以及 `>>>>>>> REVIEW`；反引号不属于标记内容。

Maintainer 修改实际内容并移除完整标记块。Reviewer 通过前必须确认当前 tree 中不再存在任何 Review 标记。原型只验证文本内容，不为二进制文件增加另一套反馈协议。

## Agent 工具

Maintainer 使用：

- Pi 默认 `read`、`bash`、`edit`、`write`；
- 外部只读来源工具 `read_evidence`；
- Host 持有的 `list_todos`、`add_todos`、`complete_todos`。

Reviewer 使用 Pi 默认 `read`、`bash`、`edit`、`write`。它没有 Raw Evidence、Maintainer Todo、`submit_review` 或其他审阅专用工具。

两个 Agent 都自己执行普通 `git commit`。Harness 在每次自然结束后只检查工作区 clean、HEAD 的 parent、允许的文件层级和 Review 标记状态：

- Maintainer 必须在上一个 handoff revision 上产生一个无 Review 标记、可建立索引的 commit；
- Reviewer 若拒绝，必须在被审 revision 上产生一个包含完整 Review 标记的 commit；
- Reviewer 若接受，必须把自己刚审阅的精确 HEAD 通过 `--no-ff` merge 到目标分支。

## 验证

```bash
npm test -- tests/unified-git-repository-prototype.test.ts tests/unified-git-agents-prototype.test.ts
```
