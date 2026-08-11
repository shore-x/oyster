# 通用 Chat Agent MVP

> 状态：当前实现
>
> 日期：2026-08-11
>
> 术语遵循：[Oyster 术语与执行模型](../architecture/terminology.md)

Chat Agent 是一个基于 Pi Coding Agent SDK `AgentSession` 的普通工具使用 Agent。一个 Chat Conversation 是用户可持续追加消息的产品对话；它在创建时固定模型和 System Prompt，可以拥有多次 Agent Invocation。完整消息历史由 Pi Session 保存，Chat repository 只补充产品 binding 和精简 Invocation envelope。

每次用户消息触发一次新的 Agent Invocation。Invocation 覆盖该 Agent 的模型—工具循环；精简 envelope 记录生命周期、Pi Session entry 范围和调用计数，完整内部活动写入本地 Debug Store。取消当前执行只终止该 Invocation，不结束 Chat Conversation；下一条用户消息会产生新的 Invocation。

Agent 的初始 `cwd` 是 `<Electron userData>/repository/`。它通过普通 `read`、`bash`、`edit`、`write` 直接理解和维护：

- `knowledge/**/*.md`：全局 Knowledge；
- `artifacts/<artifact>/`：全局 Artifact；
- `tasks/<taskId>/`：结构化知识加工的工作空间与历史。

Chat 不连接平行 SQLite Knowledge Store，也不安装 `search_knowledge`、`read_knowledge`、`upsert_knowledge` 写入协议；普通文件搜索、读取和编辑就是唯一事实层的访问方式。Shell 使用 Oyster 捆绑的标准 Git CLI。

Chat 仍拥有通用 Todo 与 `spawn_agent`。子 Agent 使用独立、持久化的 Pi Session，但继承相同 Repository 根、模型、System Prompt 和工具集合；Pi `parentSession` 和 Oyster `parentInvocationId` 分别连接 Session 与 Invocation。子 Invocation 不是新的 Chat Conversation，父 Tool Result 只保存其最终文本以及 `invocationId` / `sessionId`，不复制完整子 transcript。

Chat 只启用 Pi 生态中的 Headless Extension 和普通 context file。应用把 `<Electron userData>/pi-agent/` 作为专属 `agentDir`，设置页直接管理其 Pi 原生 `settings.json`：用户可以添加、启用、停用和移除 Pi Package 或本地 Extension 路径。Package 中的 Skill、Prompt 和 Theme 被显式关闭，Runtime 也不加载 Skill、Prompt Template 或 Theme。

Extension 注册的工具和 hooks 与内置工具处于同一个 `AgentSession` 生命周期；TUI renderer、shortcut 和交互组件不进入 Electron UI。Extension 在 Electron 主进程中按当前 OS 用户权限执行，本期采用“配置即信任”。Oyster 以 `projectTrusted: false` 创建 Pi 设置，因此 Repository 内的 `.pi/settings.json`、Package 和 Extension 不会自动生效，普通 `AGENTS.md` context file 仍按 Pi 规则加载。

Chat repository 以 Coding Agent `SessionManager` JSONL 保存完整 transcript、Tool Result、持久化 compaction entry 和终态 Invocation envelope custom entry，并以 Oyster descriptor 保存 Chat binding 与空 Conversation。详情页再通过 `debugRecordId` 从 `<Electron userData>/agent-debug/invocations/` 读取 Context、模型/工具活动和最终 Provider 请求/响应。

当前 MVP 不为 Chat 自动创建 branch、commit、merge、rollback 或权限沙箱。Agent 根据任务和 Repository 当前状态选择普通文件/Git 操作。
