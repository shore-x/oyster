# 通用 Chat Agent

## 角色

Chat 是用户与 Oyster 协作的主要入口。它使用一个通用 Coding Agent 理解对话和 Repository，根据目标跨零个、一个或多个 Knowledge Statement、Artifact 或 Task 工作；用户不需要先选择 Project、Workspace 或 Artifact 类型。

一个 Chat Conversation 可以持续接收用户消息。每条消息产生新的 Agent Invocation；Runtime 原生历史保存模型与工具活动，业务记录只保留对话配置与必要执行摘要。子 Agent 是一次独立 Invocation，不是新的 Chat Conversation 或预设角色。

## 为什么采用普通工具

Knowledge 和 Artifact 已经以普通文件表达，因此 Chat 使用文件、Shell、Git、Todo 与通用委派能力，而不增加平行 Knowledge CRUD、Artifact router 或专用 Git 工具。这让 Agent 能够按照实际任务组合修改，并避免应用层过早固化模型可以自行完成的语义判断。

Agent 以 Repository 为初始工作坐标，按当前 OS 用户权限运行。该坐标不是访问沙箱；MVP 采用高信任 Agent 原则。

当前 Chat 直接修改用户主 checkout。文件变化会立即出现在知识库或工作台等文件视图中，但只有 commit 后才属于正式 Git revision，也只有已提交的 `main` 才能成为新 Knowledge Processing Task 的基线。

## 当前与候选边界

当前 Chat Conversation 在创建时固定模型与 System Prompt，后续改变默认模型不静默替换已有 binding。UI 语言与 Agent 回复/Repository 内容语言分别设置；后者在每次 Invocation 建立时生效。

Chat 会读取 Pi 的普通 context file，并可加载用户显式配置、因而被信任的 Headless Extension；不把 Pi Skill、Prompt Template 或 Theme 作为 Oyster 的隐式业务配置。

**候选方向**：Chat Agent 未来也可以拥有独立 Git worktree/branch，并由 Agent 负责 commit、merge 或 rebase。该方向旨在让对话维护与结构化 Task 使用一致的 Repository 视图，但并未确定，不应据此承诺当前隔离或集成行为。
