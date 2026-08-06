# 通用 Agent Runtime

> 状态：当前实现规格
>
> 日期：2026-08-06

Pi Agent Runtime 负责模型—工具循环、上下文压缩、取消、错误映射和 Run Recorder，不理解 Knowledge、Artifact、Run、Review marker 或 Git branch。角色由业务层提供的 `agentId`、System Prompt、工具集合和任务输入定义。

所有 Repository Agent 从唯一 Repository 根启动：

- Chat Agent：普通 Coding Tools、子 Agent 与通用 Todo；
- Maintainer：普通 Coding Tools，以及 `read_activity`、`read_activity_attachment`、`read_evidence`；
- Reviewer：普通 Coding Tools。

Maintainer/Reviewer 不安装通用 Todo；它们使用 Harness 明确传入的 `runs/<run-id>/WORK.md`。三种 Agent 都通过普通文件工具维护 `knowledge/`、`artifacts/`，不使用另一套 Knowledge CRUD、Contribution Draft 或专用 Git 提交协议。

Run Recorder 保存稳定 `agentId`、独立 Agent Run ID、Turn、Message、Tool Call 和 Model Call。实时记录在同一 UI 窗口按 `Maintainer`、`Reviewer` 名称展示；终态 records 随所属业务 Run 写入 `runs/<run-id>/run.json`。凭据、Header、环境变量和 Provider Payload 不进入记录。

Runtime 不提供 Repository 权限控制、并发治理、分布式 Trace 或 Git 协作状态机，也不增加固定模型轮次、工具次数或总时长配额。
