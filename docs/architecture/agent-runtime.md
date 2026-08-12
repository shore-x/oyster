# Agent Runtime 与信任边界

## 选择

Oyster 使用成熟的 Coding Agent Runtime 驱动通用 Agent，并在当前实现中适配 Pi Coding Agent SDK。这样可以复用模型—工具循环、上下文管理、Extension 和 Provider 适配，而不在业务层维护第二套执行引擎。

具体依赖版本、Provider payload、重试数和存储字段由代码与测试维护。本页只说明职责边界。

## 职责

Agent Runtime 负责：

- 驱动一次 Agent Invocation 的模型与工具循环；
- 管理上下文、Runtime 原生执行历史、取消和执行事件；
- 把执行活动记录到本地 Agent Debug Record；
- 接入业务选择的模型、System Prompt、工作目录和工具集合。

业务服务负责定义 Chat、Knowledge Processing Task、Maintainer/Reviewer 和完成含义。Agent 自己在业务提供的工作坐标中维护 Git；Runtime 不解释 Review marker、Knowledge、Artifact 或 Repository 集成语义。

AI Connection 与 Runtime 同样分离：Connection 决定凭据、Provider、传输和计费来源，Runtime 只消费已经选择的模型调用能力。Oyster 自己持有凭据，不从其他 Agent Runtime 导入 token。

## 高信任原则

Agent 使用普通文件、Shell 与 Git，并按桌面应用当前 OS 用户权限运行。Pi Extension 也在 Electron 主进程中以相同权限执行；用户配置 Extension 即表示信任它。Repository 或 worktree 是工作坐标，不是安全沙箱。

这是早期产品的明确取舍：优先让 Agent 完整维护 Repository，避免用大量路径规则、命令白名单、固定写入者门禁或审批状态机取代 Agent 判断。若真实使用出现重复且无法由提示、可见性或用户确认解决的风险，再引入最小必要约束。

## Session、业务记录与调试记录

三类记录回答不同问题：

- Chat Conversation 或 Task 记录业务发生了什么；
- Runtime 原生历史保存 Agent 继续工作所需的消息和工具活动；
- Agent Debug Record 保存排查一次 Invocation 所需的完整 Context、模型调用、工具输入输出和 Provider 信息。

Debug Record 不是“无正文日志”，可能包含敏感业务内容。实现应采用成熟、简洁的 credential 过滤，不承诺不存在所有敏感内容。当前倾向将调试数据保留在本地；**目标**是由统一模块和用户设置管理 Chat、Task 和 Preview 的调试数据保留。产品不需要让“删除对话”承担这项治理。

同步全量写入等简单存储方式是可接受的 MVP 取舍。只有实测出现主进程阻塞或明显写放大时再演进。

## 语言

UI 语言与 Agent 回复/Repository 自然语言是两种偏好，应该分别设置。前者只影响界面 locale；后者在每次 Invocation 建立时进入 Agent 指令，并允许代码、命令、路径、结构化格式、引文或 Repository 自身要求保持原语言。

## 已知的后续边界

- 应用退出、崩溃和中断后的统一恢复仍需单独设计；当前不为所有异常建立复杂事务协议；
- Agent Preview 是可丢弃的调试执行；当前没有专用清理机制，用户可以显式要求 Chat Agent 清理，未来可以提供统一的临时资源清理能力；
- 多 Task 并发是明确需求；当前全局取消可以作为紧急停止，后续再增加更精细的 Task 管理；
- `@earendil-works/pi-*` fork 的维护来源与升级策略需要在依赖管理中补充，但不构成新的领域概念。
