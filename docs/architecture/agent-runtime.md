# Agent Runtime 与信任边界

## 选择

Oyster 使用成熟的 Coding Agent Runtime 驱动通用 Agent，并在当前实现中适配 Pi Coding Agent SDK。这样可以复用模型—工具循环、上下文管理、Extension 和 Provider 适配，而不在业务层维护第二套执行引擎。

具体依赖版本、Provider payload、重试数和存储字段由代码与测试维护。本页只说明职责边界。

## 职责

Agent Runtime 负责：

- 驱动一次 Agent Invocation 的模型与工具循环；
- 在业务要求交接检查时，把 Host 的具体失败反馈送回同一 Session 并继续循环；
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
- Runtime 原生历史保存一次 Invocation 中模型继续工作所需的消息和工具活动；
- Agent Debug Record 保存排查一次 Invocation 所需的完整 Context、模型调用、工具输入输出和 Provider 信息。

Knowledge Processing 的 Maintainer 与 Reviewer 每次 Invocation 都建立独立 Runtime session。Task 跨轮继续依赖 Git revision、Task 文件和正式 Repository tree，不依赖 Session 身份或隐藏上下文；因此 Pi Session 只是 Runtime 私有实现，不是 Task 状态。

一次模型自然停止只表示 Agent 当前准备交接，不自动表示 Invocation 的业务条件已经成立。需要可靠交接的角色复用同一个通用循环：Agent 自然停止后，业务服务检查 Repository 等权威状态；检查通过才结束 Invocation，检查失败则把具体原因作为隐藏 Runtime feedback 发回同一 Pi Session，让 Agent 继续检查和修复。修复过程不创建新的 Invocation，也不产生新的业务协作轮；只有当前角色真正结束、下一角色接手时才建立新的 Invocation。

当前一次 Invocation 最多接收两次 Host 交接反馈，即初次自然停止加两次修复机会。第三次检查仍失败时 Invocation 失败，Task 保持原本的 `open` 状态，后续可以从 Git 继续。固定输入被写入后续历史、Task 历史被改写等无法在允许操作内修复的问题也遵循这个有界失败语义。

这个机制不引入 `finish_review`、`finish_maintenance` 一类角色专用工具。Agent 仍按 Coding Agent 的自然停止语义工作，Host 只检查外部事实；角色差异只存在于业务 Prompt 和校验条件中。Host-owned 交接合同随 Task Prompt 动态提供，不能被用户自定义的角色 System Prompt 替换。

Debug Record 不是“无正文日志”，可能包含敏感业务内容。实现应采用成熟、简洁的 credential 过滤，不承诺不存在所有敏感内容。Chat Invocation 的 Debug Record 随持久 Conversation 引用保留；Task 与 Preview 的 Debug Record 只服务当前进程中的执行检查和查看，下一次启动清理没有持久 Chat 引用的记录。该规则依据业务可达性，不引入任意数量或时间配额。具体目录边界见[应用数据](application-data.md)。

同步全量写入等简单存储方式是可接受的 MVP 取舍。只有实测出现主进程阻塞或明显写放大时再演进。

## 语言

UI 语言与 Agent 回复/Repository 自然语言是两种偏好，应该分别设置。前者只影响界面 locale；后者在每次 Invocation 建立时进入 Agent 指令，并允许代码、命令、路径、结构化格式、引文或 Repository 自身要求保持原语言。

## 已知的后续边界

- 应用退出、崩溃和中断后的统一恢复仍需单独设计；当前不为所有异常建立复杂事务协议；
- Agent Preview 是可丢弃的调试执行；当前进程退出后，下一次启动回收其 worktree、Runtime Session 和未被 Chat 引用的 Debug Record；
- 多 Task 并发是明确需求；当前全局取消可以作为紧急停止，后续再增加更精细的 Task 管理；
- `@earendil-works/pi-*` fork 的维护来源与升级策略需要在依赖管理中补充，但不构成新的领域概念。
