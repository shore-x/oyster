# 应用数据边界

Oyster 以 Electron 启动时解析出的默认 `userData` 位置作为本机应用数据根，但不同生命周期的内容不能平铺混放，也不能因为都在本地就进入同一个 Git Repository。

当前根目录只保留以下稳定边界：

```text
oyster/
├── repository/        # 正式 Knowledge、Artifact 与 Task Git 历史
├── config/            # 应用、AI Connection 与 Agent 配置
├── state/             # 来源发现状态与 Chat Conversation
├── runtime/           # linked worktree 与单次 Agent Runtime Session
├── diagnostics/       # Agent Debug Record
└── chromium/          # Electron sessionData
```

`repository/` 是唯一可审计、可传播的正式内容边界。其余目录都是本机应用支持数据，不应被解释为 Knowledge、Artifact 或 Task 历史，也不应复制进 Repository。AI 凭据由系统 Keychain 保存，配置文件只保存连接元数据。

`config/` 和 `state/` 是持久数据。来源发现状态可以从外部来源重新扫描，但仍应保留以维持正常启动和用户选择；Chat Conversation 是用户可持续追加的业务记录，不能当作缓存清理。

`runtime/` 保存仍在执行或可能继续的工作坐标。Task 进入 `main` 后，Host 保留 Task branch 和 Repository 中的正式 Task 文件，回收 linked worktree 与该 Task 的 Runtime Session。启动时会回收上次进程遗留的已完成 Task checkout 和 Agent Preview；仍为 `open` 或带有未提交变化的 Task 不会被自动删除。

`diagnostics/` 可能包含完整业务上下文和 Provider payload，不是普通无正文日志。Chat Invocation 的 Debug Record 只要仍被持久 Conversation 引用就继续保留；Task 与 Preview 的 Debug Record 只服务当前进程中的执行检查和查看，下一次启动会删除没有持久 Chat 引用的记录。这个边界依据业务可达性，不引入任意数量或时间配额。

`chromium/` 是 Electron 自动管理的 Cookie、Local Storage、网络状态和缓存目录。Oyster 先捕获应用数据根，再在 `ready` 前把 Electron 自己的 `userData` 与 `sessionData` 都重定向到这里，防止 preload Code Cache 等实现文件散落到根目录。当前产品不把 Renderer 中的浏览器状态当作业务数据。

从旧版平铺路径升级时，App 只迁移仍由现行功能拥有的配置、状态、Runtime 和 Debug 数据；新旧目标同时存在时拒绝覆盖。已经废弃的数据库、独立 Artifact 仓库和 Run 模型不由启动迁移静默删除，而应在确认其内容后单独清理。
