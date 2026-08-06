# 通用 Agent Runtime

> 状态：当前实现规格
>
> 日期：2026-08-06

## 1. 职责

内置工具使用 Agent 复用同一套 Pi Agent Runtime。Runtime 负责模型—工具循环、上下文压缩、取消、错误映射和 Run Recorder，不理解 Knowledge、Artifact、Raw Evidence、Review marker、Git branch 或工作清单。

角色由业务层提供的 `agentId`、System Prompt、初始 `cwd`、工具集合和任务输入定义。Git handoff 由知识加工 Harness 在 Agent 结束后校验，不进入通用 Runtime 状态。

## 2. Todo 是可选能力

通用 Todo Store 和 `add_todos`、`complete_todos`、`list_todos` 实现继续保留，支持需要运行期清单的 Agent。Todo 不是 Runtime 的必选组成，也不会因 Agent 使用 Pi Runtime 而自动安装。

当前工具分配是：

- Chat Agent 仍可使用通用 Todo；
- Knowledge Maintainer 不安装 Todo，以 `.oyster/WORK.md` 作为工作状态；
- Knowledge Reviewer 不安装 Todo，以 Repository tree 和工作清单作为交接状态。

是否把文件清单推广为所有 Agent 的正式工作状态尚未决定，因此本轮不删除通用 Todo 代码。

## 3. Repository Agent

Maintainer 与 Reviewer 都从真实 collaboration worktree 根运行 Pi Coding Tools：

- Maintainer：`read`、`bash`、`edit`、`write`、`read_activity`、`read_activity_attachment`、`read_evidence`；
- Reviewer：`read`、`bash`、`edit`、`write`。

Coding Tools 的 `cwd` 是 worktree 根，Shell 获得 Oyster 捆绑的标准 Git CLI。Agent 自己修改文件并创建普通 commit；Harness 不为它们增加专用 Git、Knowledge CRUD、Contribution Draft 或 review submission 工具。

## 4. Run Record

Run Recorder 订阅 Agent、turn、message 和 tool execution 事件，并包装实际 `streamFn`。共享 `AgentRunRecord` 使用 `formatVersion: 1`，保存稳定 `agentId`、独立 `runId`、Turn、Message、Tool Call 和 Model Call；不保存凭据、Header、环境变量或 Provider Payload。

运行中 Record 用于实时 UI；持久化只接受 `completed | failed | cancelled` 终态。一次知识加工历史可以包含多个 Maintainer/Reviewer Agent Runs，并由业务结果显式引用每个 Run。Run Record 是解释与调试材料，不是 Agent 之间的持久交接事实；交接应从 Git revision 重建。

## 5. 当前边界

Runtime 不提供分布式 Trace、跨运行消息总线、长期 Todo 历史、Repository 权限控制或 Git 协作状态机。当前 MVP 也不增加固定模型轮次、工具次数或总时长配额；取消与单次 I/O 边界继续由现有机制处理。
