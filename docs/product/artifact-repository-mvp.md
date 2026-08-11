# Artifact 文件层 MVP

> 状态：当前实现
>
> 日期：2026-08-10

Artifact 是统一 Oyster Repository 中的全局文件层，不是独立 Repository：

```text
<Electron userData>/repository/artifacts/<artifact>/
├── AGENTS.md
└── ...
```

带可读取普通根 `AGENTS.md` 的一级真实目录是一个 Artifact；该文件保存持久 Attention，并作为维护目标、证据边界、质量义务和完成条件的自然语言表达载体，其他内部结构任意。四项内容是否表达充分属于 Artifact 的内容质量，不是当前文件层的有效性 Schema。目录名是当前 locator。隐藏目录、symlink 目录以及缺少普通根 `AGENTS.md` 的目录不成为 Artifact。

Artifact 页面直接扫描 `repository/artifacts/`，显示有效 Artifact 和无效目录；创建操作只建立目标目录与最小 `AGENTS.md`。打开 Repository 时打开统一根，打开 Artifact 时打开其实际目录。初始化和 Git Runtime 由统一 Repository 负责。

Skill Artifact 仍可在 Artifact 内使用真实 `output/` 和 `output/SKILL.md`，并由 Skill 页面派生注册视图。该约定不改变 Artifact 的通用文件语义。

Artifact 内容当前可以由用户、Chat Agent 或 Knowledge Processing Task 中的 Agent 直接修改，并能与 `knowledge/` 变化进入同一个 commit。Task 只引用这些路径，不建立 Artifact 副本或 symlink。

上述入口只是当前实现，不定义 Artifact 的唯一维护者。Artifact 文件层不预设全局 Maintainer、Reviewer、Critic 或固定多 Agent 编排；具体维护方式可以结合 Artifact 说明，采用单个通用 Agent、临时 subagent、其他多 Agent 流程或非 Agent 机制。任务内临时分工不因此成为 Artifact Domain 的角色，正式审批或 promotion 也必须由采用它的具体工作流另行定义。
