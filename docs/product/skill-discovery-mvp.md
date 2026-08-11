# 外部 Agent Skill 发现与浏览 MVP

> 状态：当前纵向实现规格
>
> 日期：2026-08-01
>
> 范围：定义 Skills 页面中“外部发现”视图的只读能力：发现本机 Claude Code、Pi 和 Codex 的文件系统型 Skill 注册，并展示其来源、作用域、原始位置和入口 Markdown。Oyster 管理视图、迁移、绑定、注入、执行、调用统计和优化不属于本页。
>
> 设计原则：[知识加工、Projection 与 Artifact](../architecture/knowledge-model-and-projection.md)
>
> 生态依据：[主流 Coding Agent 的 Skill 发现与格式调研](../research/agent-skill-discovery-and-format.md)
>
> 后续绑定设计：[Skill Symlink 注入 MVP](skill-symlink-injection-mvp.md)

## 1. 结论

本切片增加一个独立的外部 Skill 发现与浏览能力。它与 Oyster 管理视图共同位于专门的 Skills 页面，但数据和操作边界保持分离：外部发现不把 Skill 塞入现有历史发现的 `SourceRecord`，也不因发现而创建 Oyster Artifact。

这是四个不同对象：

- 历史 `SourceRecord` 指向 conversation 或 human instruction，属于外部观察访问 catalog；
- `DiscoveredSkill` 表示 Oyster 在某个 Agent、作用域和路径下发现的一条文件系统注册关系，是可重建的只读应用视图；
- Skill Artifact 是用户与 Agent 在 Oyster Artifact Domain 中维护的产物，只有用户后续发起明确的纳管动作才可能建立；发现本身永远不建立它。
- Skill Binding 是目标 Agent 注册位置中指向 Skill Artifact `output/` 的 symlink，由另一项显式写操作建立；发现可以观察到它，但不拥有它。

因此当前链路只有：

```text
用户触发发现
  -> 按 Agent 规则扫描已知注册根和已知项目上下文
  -> 展示每条注册关系
  -> 按选择读取入口 Markdown 或打开原始目录
```

发现不修改外部 Agent，不复制 Skill，不写入 Oyster Repository 的 Artifact 文件层，也不执行任何附带内容。

## 2. 最小对象与生命周期

一条 `DiscoveredSkill` 至少保留：

- 所属 Agent；
- Skill 名称和可选描述；
- scope；
- 项目 scope 对应的目录；
- 原始 Skill 目录与入口 Markdown 的绝对路径；
- 入口格式、文件大小、修改时间；
- 本轮 catalog 中使用的不透明 ID。

同名 Skill 不跨 Agent、scope 或路径合并。同一个共享目录被 Pi 与 Codex 同时发现时，它表示两条 Agent 注册关系；Oyster 不替目标 Agent 推断同名覆盖结果。

发现结果只保存在当前主进程内存中。每次用户刷新都从文件系统重建完整 snapshot；APP 不增加外部 Skill 数据库或 JSON 镜像。文件在发现后被删除、替换或失去权限时，预览和打开操作明确失败，不回退到缓存正文。

## 3. Scope

当前只保留解释 UI 所需的最小 scope：

| Scope | UI 含义 | 项目路径 |
| --- | --- | --- |
| `user` | 当前用户跨项目可发现，显示为“全局” | 无 |
| `project` | 只在特定项目或子目录语境中发现，显示为“项目” | 必须显示注册根所属目录 |
| `admin` | 机器管理员提供 | 无 |
| `system` | Agent 自带或缓存的系统 Skill | 无 |
| `other` | 已发现但不能归入前述 scope 的来源 | 按来源如实展示 |

这些 scope 描述发现来源，不表示 Oyster 已确认当前 Agent Runtime 的 enabled 状态。

## 4. 当前支持的发现来源

### 4.1 用户与机器级

| Agent | 当前扫描位置 |
| --- | --- |
| Claude Code | `${CLAUDE_CONFIG_DIR 或 ~/.claude}/skills`；兼容用户级 `.claude/commands/*.md` |
| Pi | `${PI_CODING_AGENT_DIR 或 ~/.pi/agent}/skills`；`~/.agents/skills` |
| Codex | `~/.agents/skills`；兼容 `${CODEX_HOME 或 ~/.codex}/skills`；其中 `.system` 单独标为 system；`/etc/codex/skills` 标为 admin |

### 4.2 项目级

Oyster 当前没有独立的 Workspace 或 Project Registry。项目上下文来自已经由历史 Discovery catalog 发现、当前可用 Source Conversation 中的 `projectPath`。对每个已知目录：

- Claude Code 检查当前目录到 Git repository root 各级 `.claude/skills`，并兼容相应 `.claude/commands/*.md`；
- Pi 检查当前目录的 `.pi/skills`，以及当前目录向上到 Git root 的各级 `.agents/skills`；没有 Git root 时按 Pi 规则继续到文件系统根；
- Codex 检查当前目录向上到 Git repository root 的各级 `.agents/skills`。

UI 必须给项目 Skill 显示“项目”标记和注册根所属目录。未出现在 Source Conversation catalog 中的项目不会通过遍历整个 Home 猜测；首次使用、没有外部对话历史的项目因此可能暂时不可见。

### 4.3 当前不能证明的来源

静态文件发现暂不完整覆盖：

- Claude Plugin、bundled、managed 和运行时动态目录；
- Pi CLI、settings 显式路径、Package 与 Extension；
- Codex App Server 冲突解析后的 enabled 集合和 Plugin 来源。

页面使用“已发现”，不使用“已启用”。后续可以把官方运行时枚举作为另一种发现证据接入，但不需要改变 Skill Artifact 内容模型。

未来由 Oyster 创建的 Skill Binding 也可能被本页按普通文件系统规则发现为一条 symlink 注册关系；这条 `DiscoveredSkill` 仍只是外部注册视图，不替代 Skill Artifact 或 Binding 的语义。绑定的 symlink 目标固定为 Artifact 的 `output/`，具体规则由[《Skill Symlink 注入 MVP》](skill-symlink-injection-mvp.md)定义。

## 5. 文件与格式边界

标准 Skill 以目录中的精确文件名 `SKILL.md` 为入口。发现目录时：

- 保留整个目录的原始位置，但只读取入口 Markdown 的有限前缀以提取展示名称和描述；
- 允许 Skill 目录本身是 symlink，并保留其逻辑注册路径；
- 不把 symlink 形式的入口文件当作可预览文档；
- 递归型 Agent 根在找到一个 Skill 入口后停止进入其附件目录；
- 一个损坏、无权限或无效候选只形成局部错误，不使其他 Agent 的发现失败；
- Pi 原生目录和 Claude legacy command 允许单个 Markdown 文件作为兼容入口。

未知 frontmatter、脚本、二进制、配置、资源和其他附件既不使发现失败，也不会在本切片中被解释或执行。格式兼容性不是 Oyster 接纳 Artifact 的门槛；本页只是读取外部入口以便浏览。

## 6. 文档预览与打开原始目录

入口正文只在用户选择一条 Skill 后读取，不在发现时把全部文档载入 Renderer。预览请求只提交本轮 catalog 签发的 Skill ID，由主进程解析已发现路径并重新检查文件：

- 当前单次 Markdown 预览上限为 2 MiB；这是 UI I/O 边界，不限制 Skill 目录内容；
- 文档必须是可读取的普通 UTF-8 文件；
- Markdown raw HTML 继续转义，`javascript:` 与 `file:` 链接不可导航；
- Skill 预览禁用 Markdown 图片，避免相对文件或远程 tracking URL 触发资源读取；
- 不解析、安装或执行 scripts、dependencies 和动态 shell 内容。

“打开文件夹”同样只接收 Skill ID。主进程确认请求来自主窗口 main frame，重新确认 catalog 中的路径仍是目录，再调用系统文件管理器；Renderer 不能提交任意绝对路径要求 APP 打开。

原始目录和入口文件的绝对路径可以在 Renderer 中显示，因为“查看原始位置”是本功能的明确用户目标；它们不进入模型输入或遥测。

## 7. UI

主导航增加独立“Skills”页，不把 Skill 混入“Agent 数据来源”的 Source Conversation 统计卡片。

页面只提供：

- 用户触发的“发现 Skill”或“重新发现”；
- 左侧按 Agent 分组的注册列表，显示 Skill 名称和 scope，并在自身区域内独立滚动；
- 右侧详情独立滚动，显示描述、Agent、scope、项目目录、原始 Skill 目录和入口文档路径；
- 打开原始文件夹；
- 入口 Markdown 预览；
- 空状态、局部扫描错误和单文档预览错误。

当前不增加搜索、调用频率、关系图、统计图、兼容性评分、导入或编辑操作。

## 8. 安全与权限

- 所有外部目录只读；
- 不执行 Skill 内文件；
- 不扫描整个 Home 寻找任意 `SKILL.md`；
- IPC 使用不透明 ID 和可信窗口校验；
- 单个不可读目录不扩大为更高权限扫描；
- 发现内容只在用户打开 Skills 页面并触发发现后读取；
- Fixture 与测试使用隔离临时目录，不扫描开发机真实 Home。

## 9. 验证

最小测试应覆盖：

- 三个 Agent 的用户、项目及 Codex admin/system scope；
- 同名、跨 Agent 共享目录和项目路径标记；
- `SKILL.md`、Pi/Claude 单 Markdown 兼容入口、任意附件与目录 symlink；
- 空目录、损坏入口、删除后读取、未知 ID 和预览大小边界；
- Renderer 的 scope、项目路径、原始路径、Markdown、空状态和错误状态；
- Skill Markdown 图片不会生成资源请求；
- 既有 history Discovery、知识加工和 Artifact 文件层测试保持通过。
