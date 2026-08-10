# 知识加工验证 MVP

> 状态：当前实现
>
> 日期：2026-08-10

## 目标

用真实 Maintainer → Reviewer 链路验证：外部 Agent Session 能被完整读取，每次知识加工拥有独立的文件工作空间，Agent 只用普通文件与 Shell 工具直接维护全局 Knowledge/Artifact，Reviewer 能独立反馈或批准，并且完整轨迹可在同一个 UI 窗口查看。

## Repository 与 Run 工作空间

应用固定使用 `<Electron userData>/repository/`：

```text
repository/
├── knowledge/
├── artifacts/
└── runs/<run-id>/
    ├── TASK.md
    ├── WORK.md
    ├── workspace.json
    ├── inputs/
    │   ├── README.md
    │   ├── activity/
    │   ├── evidence/
    │   │   └── INDEX.md
    │   └── attachments/
    └── run.json        # 仅 Full Chain 终态产生
```

一个 Processing Run 是一次结构化知识加工工作流实例，并独占一个 `runs/<run-id>/` 工作空间。Full Chain 在同一个 Run 中完成 Maintainer/Reviewer 闭环，多轮 Maintainer 修复与 Reviewer 复审共享这个目录；每次角色调用仍拥有独立 Agent Run ID，并在 Full Chain 的终态 `run.json` 中按 handoff 顺序区分。单阶段 Debug Run 也保留自己的任务、输入和工作状态，但当前不生成代表完整闭环历史的 `run.json`。

Knowledge 与 Artifact 全局唯一，不从属于 Run，也不复制进工作空间。Harness 从 `main` base 创建 `processing/<run-id>`，但不创建 worktree 或领域文件副本。Run 目录由 `.gitignore` 排除，不进入候选内容 commit。

- `TASK.md`：本次 Run 的固定任务定义、Attention、来源身份、Repository 输出位置、处理分支和完成边界；
- `WORK.md`：Maintainer 与 Reviewer 共同维护的可变检查清单和 handoff；
- `inputs/`：Host 从已固定 Observation 物化出的普通文本、图片和说明文件；
- `workspace.json`：列出 `TASK.md` 与全部输入文件的长度和 hash，记录初始 `WORK.md` 定义的 hash，并保存 Run 创建时 Knowledge/Artifact 的 Git status、tracked working-tree diff 与 staged index diff 的大小和 hash、未跟踪普通文件或 symlink 的 Git mode、大小与 hash；它用于拒绝以不同任务清单复用 Run，也让已有 Repository 修改成为本次 Run 的显式输入，不要求可变的当前 `WORK.md` 或 Agent 工作中的 Repository 保持初始状态。Harness 在首个 Maintainer 启动前重算初始指纹，并在 Agent 启动及接受 handoff 时校验固定文件内容和 `inputs/` 文件树均未漂移；
- `run.json`：仅由 Full Chain 在已创建工作空间后进入终态时写入，保存输入选择、配置、结果和全部 Agent Run records。

## 文件化输入

Source Adapter 先从选定 Session revision 读取确定版本，生成可定位的 Canonical Activity，并保留 Raw Evidence locator。Host 随后在该 Run 的 `inputs/` 中物化一次固定的 Agent 输入视图：

- Canonical Activity 按模型上下文边界生成有序、完整的 Markdown page；
- 已固定 Raw Evidence 的规范化行模型生成有界文本 page，`evidence/INDEX.md` 把 `Lxxxxxx:Cn` locator 映射到相应文件；
- Base64 图片解码为真实图片文件；
- `inputs/README.md` 说明来源引用、格式、读取顺序、locator 和附件元数据。

这些文件是所选 Observation 的 Run-local 固定工作视图，不是新的来源权威，也不会因位于 Repository 下而成为 Knowledge 或 Artifact。上游 `sourceRef` 绑定外部来源字节和版本；Evidence page 则由 Adapter 的固定行模型确定性物化，`workspace.json` 固定的是物化文件自身，两种 hash 不等同。特殊输入格式由说明文件解释，不产生 `read_activity`、`read_activity_attachment` 或 `read_evidence` 等专用 Agent 工具。

## Maintainer

Maintainer 的普通 `read`、`bash`、`edit`、`write` 从本次 `runs/<run-id>/` 启动。它先读取 `TASK.md`、`inputs/README.md` 和 `WORK.md`，检查 Repository 已有的 working-tree 与 staged diff，再按清单用普通 `read` 检查全部 Activity 文件与图片，只在需要精确核查时读取对应 Evidence page；然后使用 `TASK.md` 给出的正式 Repository 路径维护 `knowledge/`、`artifacts/`，把合理的已有修改纳入同一候选，解决 Review marker 并创建一个普通 Knowledge/Artifact commit。新 Run 的首个 Maintainer 不要求丢弃或预先提交已有 Knowledge/Artifact 修改，但 Harness 会拒绝域外脏文件和无法由外层 Git 状态唯一固定的 nested working-tree 未提交内容，并在启动前要求当前状态与 manifest 初始指纹一致；后续 Maintainer 从干净工作树启动。Harness 在启动时还校验固定 workspace、processing branch 与精确 HEAD，在 handoff 时再次要求干净工作树，并校验清单、Git revision 和内容后追加 Maintainer handoff。

## Reviewer

Reviewer 从同一个 Run 工作空间和干净工作树启动，也只拥有普通 `read`、`bash`、`edit`、`write`。它读取 `TASK.md` 和 `WORK.md`，审阅精确 candidate revision：

- 需要修改：在实际文件加入完整 `REVIEW` block，在 `WORK.md` 增加未完成项，并创建反馈 commit；
- 批准：验证无未完成项和 marker 后结束；Harness 在 `WORK.md` 追加绑定精确 OID 的 Reviewer approval。Reviewer 不创建 approval commit、不删除工作记录、不 merge。

`inputs/` 对 Reviewer 明确属于证据范围之外，System Prompt 要求它不得读取；Harness 也不会把 Observation 或 Maintainer transcript 注入 Reviewer 上下文。当前 Coding Tools 仍以 APP 的 OS 用户权限运行，因此这个 source-blind 规则是工作流行为与上下文边界，不是文件系统安全沙箱。若未来需要不可绕过的证据隔离，应由 Runtime 权限边界实现，而不是重新引入按格式命名的读取工具。

## UI 与历史

运行视图在一个窗口中按 handoff 顺序展示所有 Agent Runs，并使用 `Maintainer`、`Reviewer` 名称区分。Session 选择器直接消费 Discovery 提供的 catalog snapshot，并可显式刷新所有本机来源；选择绑定稳定身份和精确 revision，刷新后版本变化或记录消失都会撤销选择。运行开始前的 Session 不可用、版本变化或权限问题以结构化输入拒绝返回，不创建 Run 工作空间或失败历史。

历史列表只展示存在 `runs/<run-id>/run.json` 的 Full Chain 历史；没有 `run.json` 的单阶段 Debug Run 仍是有效工作空间，但不冒充完整闭环记录。成功记录包含输入选择、Session、两种角色配置、全部轨迹、candidate revision、变更路径及 revision 对应的 Knowledge/Artifact 视图。Run Recorder 当前保存普通工具结果和模型上下文，因此 Agent 实际读取的 Evidence 也可能在 `run.json` 中重复出现；这是当前完整调试轨迹的明确取舍，不把专用读取工具误当作脱敏边界。

## 当前边界

统一 Repository 只有一个物理工作树，因此当前 Harness 只允许一个结构化知识加工角色运行；这是避免交叉污染的单进程完整性边界，不是队列或分布式锁。MVP 不定义 promotion、多进程并发治理、队列、租约、远端同步、自动 rebase、复杂冲突策略、Run 清理策略或强文件系统隔离。这些问题不改变当前三条核心定义：每个 Processing Run 有独立工作空间；Agent 的业务任务、输入和工作状态通过文件表达；Knowledge 与 Artifact 始终只存在于全局正式层和 Git revision 中。
