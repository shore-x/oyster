# Pi Coding Agent SDK 适配层

> 状态：当前实现规格
>
> 日期：2026-08-11
>
> 术语：[Oyster 术语与执行模型](terminology.md)

Oyster 直接以 `@earendil-works/pi-coding-agent` 的 `AgentSession` 作为唯一通用 Agent 执行基础。`pi-agent-core` 是 SDK 自身依赖的模型—工具循环引擎，也是 SDK 尚未完整重导出的 `AgentMessage`、`AgentTool`、`StreamFn` 和底层事件类型来源；Oyster 因而保留同版本的直接类型依赖，但 Chat、Maintainer 或 Reviewer 都不再直接构造 Core `Agent` 作为另一条执行路径。

适配层只负责把 Oyster 输入转换到 SDK 边界，并把执行状态投影为 Agent Invocation 与本地 Debug Record；它不理解 Knowledge Processing Task、Collaboration Round、Review marker 或 Git branch。业务层通过稳定 `agentId`、System Prompt、工具集合、初始工作目录、Pi 资源策略和任务输入定义角色。

## 执行与模型边界

每次 Agent Invocation 创建一个 `AgentSession`。Oyster Connection 仍拥有认证、计费通道、模型选择和凭据。代码中的 `SelectedModelStream` 只表示“已经选定的 Pi Model + 已认证 StreamFn”，不是 Agent Runtime、Session 或新的生命周期实体。适配层用它创建 request-local Pi `ModelRuntime` bridge；`ModelRuntime` 在 Oyster 代码和文档中只表示 Pi SDK 类型。Bridge 注册同一个 Model 的 native Provider，并把调用转回该 stream，因此：

- API Key 与 OAuth credential 继续由 Oyster Keychain 和 Connection 生命周期拥有；
- SDK 的 Agent loop、Extension hooks、工具注册、持久化上下文压缩和溢出重试能够正常工作；
- 不读取默认 `~/.pi/agent/auth.json`，也不允许 Pi 设置静默替换 Chat Conversation 或 Knowledge Agent 已固定的模型；
- Recorder 在实际 StreamFn 边界保存模型收到的 Pi Context，并通过 Provider callback 保存 Extension hook 处理后的最终 payload。

OpenAI Chat Completions 与 Responses 不再由 Oyster 维护平行的 streaming transport，而是直接使用 `pi-ai` 的原生 Provider 实现。Payload 转换、流解析、Provider retry/timeout、错误语义和 Provider hooks 均由 Pi 负责；Oyster 只提供已校验的 endpoint、所选模型和凭据。原有 `guardedFetch` 及其针对 Agent 模型请求的 redirect、响应体大小和自定义流解析策略已经删除，避免两套 transport 逐渐分叉。模型目录发现与连接测试仍可拥有各自的有界 HTTP 校验，但不能把这些校验误写成 Agent Provider transport 的保证。

## Headless Extension 资源策略

通用 Chat Agent 只启用 Pi 的 Headless Extension 和普通 context file：

- `cwd` 是唯一 Oyster Repository 根；
- `agentDir` 固定为 `<Electron userData>/pi-agent/`，不隐式继承用户的 `~/.pi/agent`；
- 设置页直接通过 Pi `SettingsManager` 管理 `<agentDir>/settings.json` 中的 Package 与本地 Extension 来源，不建立 Oyster 插件数据库；
- Package 配置显式关闭其中的 Skill、Prompt 和 Theme；Runtime 也设置 `noSkills`、`noPromptTemplates`、`noThemes`；
- Oyster 固定的 Chat System Prompt 是 base prompt，Extension 可以按 Pi 生命周期扩展它；
- 普通 Coding Tools、Extension tools、通用 Todo 与 `spawn_agent` 进入同一个 SDK tool registry。

Extension 是在 Electron 主进程内执行的受信代码，不是受限声明文件。本期采用“配置即信任”，不增加权限弹窗、命令白名单、Extension 沙箱或细粒度网络治理。`SettingsManager` 明确以 `projectTrusted: false` 创建，因此只有 Oyster 专属 `agentDir` 的配置生效，Repository 内的 `.pi/settings.json`、Package 和 Extension 不会因打开 Repository 而执行；普通 `AGENTS.md` 等 context file 仍按 Pi 规则加载。Pi TUI renderer、theme、shortcut 和交互组件不会映射为 Electron UI。

设置页支持添加、启用、停用和移除 Pi Package 或本地 Extension 路径。Package 的解析、安装缓存和加载语义沿用 Pi SDK，不由 Oyster 复制实现。配置从下一次通用 Chat Agent Invocation 起生效。

Knowledge Maintainer 与 Reviewer 使用同一 `AgentSession` 基础，但资源模式固定为 `disabled`：不加载 Extension、Skill、Prompt、Theme 或 context file，只启用普通 `read`、`bash`、`edit`、`write`，也不安装通用 Todo。这一差异是业务能力定义，不是第二套 Runtime。

所有 SDK bash 调用从各自 `cwd` 启动。适配层通过 SDK 的 shell command prefix 为完整复合命令固定 Oyster 捆绑 Git 的 PATH 与 Git runtime 环境，不修改 Electron 主进程的全局环境。

## 工作坐标

- Chat Agent 从 Repository 根启动，可使用普通 Coding Tools、Headless Extension、子 Agent 和通用 Todo；
- Knowledge Maintainer 与 Reviewer 从所属 `tasks/<taskId>/` 启动，只使用固定普通工具；
- Maintainer 读取 `BRIEF.md`、`PROGRESS.md` 和 `inputs/`；Reviewer 读取 `BRIEF.md`、`PROGRESS.md` 与精确 candidate revision，不读取 `inputs/`。

适配层不安装 `read_activity`、`read_activity_attachment` 或 `read_evidence` 等领域专用工具。`BRIEF.md`、`inputs/` 和 `manifest.json` 的固定性、`PROGRESS.md` 的可变性、Repository 初始指纹以及 Reviewer 的 source-blind 行为由 Knowledge Processing Harness 定义，不属于 SDK 适配层，也不代表 OS 文件系统沙箱。

## Pi Session

Pi Session 是执行历史的事实来源，保存 message、Tool Result、compaction 和分支关系：

- Chat Conversation 使用 `SessionManager` 的 append-only JSONL，并用一个小型 Oyster descriptor 固定模型/System Prompt binding、标题及空 Conversation；一次根 Invocation 通过 `startEntryId` / `endEntryId` 引用它在共享 Session 中产生的范围；
- Chat 子 Agent 创建独立的持久化 Pi Session，并通过 Pi `parentSession` 指向父 Session；父工具结果只保存最终文本以及子 `invocationId` / `sessionId`，不复制子 transcript；
- Knowledge Maintainer 与 Reviewer 的每次 Invocation 都在 `tasks/<taskId>/pi-sessions/` 创建独立持久化 Pi Session。

SDK 原生 persistent compaction 只改变下一次模型调用使用的活动上下文，不删除 JSONL 中被摘要的历史消息。溢出时由 `AgentSession` 执行“记录失败 Assistant message、生成 compaction、持久化边界、重试”；摘要调用在 Debug Record 中标记为 `purpose: context_compaction`。

## Invocation 与本地 Debug Store

持久化分为三个清晰层次：

```text
Pi Session JSONL
└─ messages / tool results / compaction / branches

AgentInvocationRecord
└─ identity / lifecycle / error / Pi Session range / call counts / debugRecordId

Local Agent Debug Store
└─ turns / messages / tool calls / model context / final provider request and response
```

`AgentInvocationRecord` 是精简、版本化的生命周期 envelope。它只保存 `invocationId`、`agentId`、可选父 Invocation、状态和时间、错误、Pi Session 引用、模型/工具调用计数以及 `debugRecordId`，不复制 transcript 或内部活动。Chat 把终态 envelope 写入 Pi JSONL custom entry；Knowledge Task 把所属终态 envelope 写入 `task.json`。

本地 Debug Store 位于 `<Electron userData>/agent-debug/invocations/`，每个 Invocation 使用一个原子替换的 JSON 文件。`AgentInvocationDebugRecord` 保存完整 Pi Context、消息和 Turn 投影、工具输入/结果、模型输出与用量、安全生成选项、Extension hook 处理后的最终 Provider payload、请求 header 视图以及响应 status/header。API Key、Authorization、Cookie 等 credential-bearing header 值不会保存；已出现于 header 视图的敏感值统一写为 `[redacted]`。Context、工具结果、payload 和非凭据 header 仍可能包含敏感业务数据，UI 必须如实披露。

Debug Store 是按 Invocation 组织的本地检查投影，不是第二份 Conversation 历史，也不是 Trace/Span 遥测系统。当前不引入数据库、Phoenix、OpenTelemetry、exporter 或采样；也不预先实现 retention。未来只有在实际存储量需要时，才增加按时间删除旧 Debug Record 的简单策略，Pi Session 与业务 Task 历史不随之删除。

## 边界

适配层不提供 Repository 权限控制、业务并发状态机、分布式 Trace、Git 协作编排，也不增加固定模型轮次、工具次数或总时长配额。Headless Extension 与普通 Coding Tools 都按应用当前 OS 用户权限执行；当前安全边界是明确来源、显式配置和不加载项目 `.pi` 可执行资源，而不是能力沙箱。
