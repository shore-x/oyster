# 统一 Repository 与 Agent Git 协作

> 状态：当前架构
>
> 日期：2026-08-11
>
> 术语：[Oyster 术语与执行模型](terminology.md)

## 1. 最小整体模型

Oyster 只有一个标准 Git Repository。Knowledge、Artifact 与 Task 记录由同一组 revision 表达；并行写入通过 Repository 外的 linked worktree 隔离。

```text
<Electron userData>/
├── repository/                         # 用户主 checkout
│   ├── .git/
│   ├── knowledge/                      # tracked
│   ├── artifacts/                      # tracked
│   └── tasks/<taskId>/                 # tracked
│       ├── BRIEF.md
│       ├── PROGRESS.md
│       ├── inputs/
│       ├── pi-sessions/
│       └── task.json
├── worktrees/<taskId>/                 # linked checkout，不是业务数据
├── agent-runtime/<taskId>/             # Pi runtime cache，不进 Git
└── agent-debug/invocations/            # 完整本地 Debug Record，不进 Git
```

- `knowledge/` 是全局 Knowledge 层；
- `artifacts/` 是全局 Artifact 层；
- `tasks/<taskId>/` 是版本化 Task 记录，不是运行时垃圾目录；
- Task branch 使用 `task/<taskId>`；Agent 的 `cwd` 是 `worktrees/<taskId>/` 根目录。

Task 不复制 Knowledge 或 Artifact，但 Task 过程与领域修改属于同一 Git 历史。`tasks/` 不再被 `.gitignore` 整体排除。

## 2. Task 创建和版本边界

Source Snapshot 被接受后，Host 从已提交的 `main` revision 创建 `task/<taskId>` 和外置 linked worktree，然后一次性写入 Task 定义、物化输入、初始进度和 `task.json`，形成 `task: start <taskId>` commit。

Task start commit 直接固定 `BRIEF.md` 和 `inputs/` 的精确字节，因此不再需要 `manifest.json`、working-tree 指纹或自定义 `workspaceRevision`。上游 `sourceRef` 绑定外部来源版本，Task start commit 绑定本地物化视图，两者职责不同。

主 checkout 的未提交修改：

- 不阻止 Task 创建；
- 不会被复制或静默吸收到 Task；
- 始终由用户拥有，Host 不执行 stash、reset、clean 或自动 commit。

如果未来需要把用户未提交修改交给 Agent，应提供显式 Handoff，而不是根据路径猜测归属。

## 3. Host 与 Agent 的契约

Host 负责结构性 Git 行为：

- 创建 branch 和 linked worktree；
- 创建 Task start commit；
- 在 Agent 自然结束、失败或取消后保存 Task/Pi Session 并 checkpoint；
- 读取 branch 上的 `task.json`；
- 将来负责整合 `main` 和 promotion。

Agent 负责语义工作：

- 阅读 Task、Knowledge 和 Artifact；
- 编辑内容、更新 `PROGRESS.md`、执行必要检查；
- Maintainer 形成候选内容；Reviewer 留下反馈或批准。

Prompt 要求 Agent 不创建或切换 branch/worktree，不 commit、stash、reset、clean、merge、rebase 或 push。这是协作策略，不是 OS 权限边界。Host 不使用精确根目录 allowlist；偏离约定的修改会随 Task checkpoint 被 Git 保留并交给 Review，而不是被静默删除。

若 Agent 自己创建了普通 commit，Host 接受其现有历史并继续 checkpoint，不要求“正好一个单亲非空 commit”。

## 4. Maintainer / Reviewer 历史

典型历史为：

```text
main@base
└─ task: start <taskId>
   └─ maintainer: checkpoint Task work
      └─ reviewer: request changes
         └─ maintainer: checkpoint Task work
            └─ reviewer: approve Task candidate
               └─ task: complete
```

每个 commit 可以同时包含 `tasks/<taskId>/`、`knowledge/` 和 `artifacts/`。Reviewer approval 不是空提交：它至少保存 Reviewer Pi Session 与 `PROGRESS.md` handoff。

Review marker 和未完成 checklist 用于 Agent 协作与决策解释，不再承担复杂的 Repository 完整性证明。Reviewer 要求修改时可以让中间 tree 暂时包含 marker；Maintainer 解决后再验证正式 Knowledge tree。

## 5. 状态和恢复

Task 只有三个生命周期状态：

- `open`：仍可继续；
- `completed`：Reviewer 已批准并保存最终结果；
- `abandoned`：用户明确放弃。

`failed` 和 `cancelled` 只属于某次 Agent Invocation。一次 Invocation 失败或取消时，Host 尽量保存当前 Pi Session、`task.json.lastError` 和 worktree 修改，Task 保持 `open`。Host 不 reset、clean、删除 branch 或删除 worktree。当前 UI 尚未提供继续/放弃操作，但 Git branch 和 worktree 已具备恢复基础。

## 6. 并发和用户协作

唯一通用规则是：

> 同一 Repository 可以有多个并行写入者，但同一个 worktree 同时只有一个写入者。

- 用户拥有主 checkout，可以继续手工编辑；
- 每个 Task 拥有独立 branch/worktree，不同 Task Agent 可以并行；
- 同一 Task 内 Maintainer 与 Reviewer 串行复用一个 worktree；
- 用户需要手工修改 Task worktree 时，应先暂停该 Task Agent；
- Agent 启动前若 Task worktree 已经 dirty，Host 先创建可见的 pre-Agent checkpoint，不拒绝也不丢弃修改；
- 执行期间若用户与 Agent 同时写同一 worktree，系统无法可靠判断逐行归属，因此这仍由单写入者契约解决。

这里只使用进程内的每-worktree单写入者门禁，不引入 OS 锁、租约、权限系统或分布式协调。

当前 Renderer 一次只启动一个前台 Knowledge Task，因此取消入口仍表示“取消当前前台 Knowledge Agent 执行”，并会中止进程内所有活动 Knowledge Task Invocation。底层不同 worktree 已可并行，但真正面向多个前台 Task 的独立取消需要 start 协议先返回 `taskId`，当前尚未实现。

## 7. 历史读取

未合并 Task 的 `tasks/<taskId>` 只存在于 Task branch。Task 列表因此不能只扫描主 checkout：

- 通过 `refs/heads/task/*` 枚举活动或未合并 Task；
- 通过 `git show task/<id>:tasks/<id>/task.json` 读取状态；
- 已进入 `main` 的 Task 从 `main:tasks/` 读取；
- 旧版被忽略的本地 `tasks/<id>/task.json` 只作为兼容回退读取，不再删除。

Git Repository 是 Task 的权威索引，不建立第二个 Task 数据库。

## 8. Integration 与 promotion

当前产品仍停留在“批准但不 merge”的验证阶段，尚未暴露 promotion 操作。后续实现遵循以下契约：

1. 把最新 `main` merge 进 Task branch；
2. 在 Task worktree 解决冲突并重新 Review；
3. 当 `main` 是最终 Task HEAD 的 ancestor 时 fast-forward promotion；
4. 用户主 checkout dirty 时不自动 stash 或强行更新 `main`。

不自动 rebase 已保存的 Task/Pi Session/Review 历史。所有 repo-writing Agent 最终都应采用相同的独立 worktree 契约；当前通用 Chat Agent 仍直接使用主 checkout，这是待迁移的已知边界。
