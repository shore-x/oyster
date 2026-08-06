# Artifact Repository MVP

> 状态：当前生产实现记录；独立 Artifact Repository 将迁移为统一 Repository 的 `artifacts/` 层
>
> 日期：2026-08-01
>
> 领域边界：[知识加工、Projection 与 Artifact](../architecture/knowledge-model-and-projection.md)
>
> 迁移说明：本文描述现有 `userData/artifacts/` 页面实现。知识加工 MVP 已在独立 collaboration repository 中使用 branch、Agent commit 和 Reviewer approval，但不会 merge 或同步到本 Artifact Repository；见[《统一 Git Repository 与 Agent 协作》](../architecture/unified-git-agent-collaboration.md)。

## 1. 目标

本 MVP 用最小、通用的文件系统模型验证 Artifact Domain 的持久载体和人机协作界面：Oyster 在自己管理的数据目录中维护一个固定的标准 Git Repository，并把其中每个有效的一级目录作为一个 Artifact 展示；同一个通用管理 Agent 可以根据对话自行发现并维护其中的 Artifact。

本阶段不为 Artifact 设计专用 Agent、Session 类型、Project 绑定、语义 router 或固定 Projection 流程。Artifact 维护只是通用 Agent 可以根据当前对话执行的一类工作。

## 2. 已确认的最小模型

当前 MVP 只引入三个实现概念：

- **Artifact Repository**：固定位置的本地标准 Git Repository，保存全部 Artifact；
- **Artifact**：Repository 中一个有效的一级目录；
- **Attention**：该 Artifact 根目录 `AGENTS.md` 中由用户维护的持久关注。

目录约定如下：

```text
<Electron userData>/artifacts/
├── .git/
├── agent-memory-tracking/
│   ├── AGENTS.md
│   ├── current-assessment.md
│   └── timeline.md
└── a-group-skill/
    ├── AGENTS.md
    ├── notes.md
    └── output/
        ├── SKILL.md
        ├── references/
        └── scripts/
```

一个可见的一级目录只有在其根部存在可读取的普通文件 `AGENTS.md` 时才是有效 Artifact。`.git` 和其他点号开头的目录不参与 Artifact 发现。缺少、无法读取或没有普通文件形态的 `AGENTS.md` 的可见一级目录不是 Artifact，UI 将其明确显示为无效目录，供用户自行补全或处理，而不会猜测其 Attention。

Artifact 内除根 `AGENTS.md` 外没有通用固定结构。文档、代码、脚本、配置、资源和任意嵌套目录都只是该 Artifact 的内容；嵌套目录即使包含另一个 `AGENTS.md`，也不会被当前 MVP 识别为新的 Artifact。具体应用可以赋予一个目录名称明确语义；当前唯一实例是 Skill 应用使用的根 `output`。

上例中的 Skill 体现同一包容性边界。每个由 Oyster 管理的 Skill 使用一个 Artifact 作为产物载体，当前通常就是一个一级目录；APP 不对其中的 Skill 文档、脚本、可执行文件、配置、资源或其他格式增加内容白名单。早期主要提供和维护知识型 Markdown Skill 只是产品默认期望，不是 Artifact 扫描或保存契约。保存任意文件也不意味着 APP 自动执行、安装或信任这些内容。

固定 `output` 是 Skill 应用约定，不是通用 Artifact Schema。有效 Artifact 根部存在这个文件系统项时，APP 派生出 Skill Artifact 视图；只有它是有效输出目录且入口满足当前通用基线时，才允许创建 Skill Binding。目标 Agent 通过 symlink 看到 `output/`，Artifact 根 `AGENTS.md`、`notes.md` 等维护材料不进入外部 Skill 根。缺少 `output` 不影响普通 Artifact 的有效性。Artifact Repository 只负责识别和展示派生 Skill 摘要；外部 symlink 的写入由 Skills 模块单独负责，完整设计见[《Skill Symlink 注入 MVP》](skill-symlink-injection-mvp.md)。

## 3. 固定位置与初始化

Artifact Repository 的位置固定为 Electron `app.getPath('userData')` 下的 `artifacts/`。用户不选择、切换或登记其他 Repository。

Oyster APP 初始化时：

1. 确保 `userData/artifacts/` 是 APP 管理的真实目录，而不是指向其他位置的符号链接；
2. 如果本地真实 `.git/` 尚不存在，使用随 APP 捆绑的私有标准 Git Runtime 初始化 Repository；
3. 直接扫描文件系统，返回有效 Artifact 与无效一级目录。

APP 自己发起 Git 操作时，始终通过捆绑 Runtime 中 Git 可执行文件的绝对路径调用标准 CLI，不依赖进程 `PATH`，也不探测或调用系统 Git。因此系统是否安装 Git、系统 Git 的版本以及用户 `PATH` 都不是 Artifact 功能的前置条件。初始化失败只使 Artifact 功能进入可重试的错误状态，不阻止 APP 的其他功能和主窗口启动；用户刷新 Artifact 页面时会再次尝试。已有本地真实 `.git/` 时，普通扫描、创建和打开不需要再次调用 Git。

当前源码通过 production dependency 获取并定位平台 Git Runtime，开发、测试和 `electron-vite` 构建后的主进程均使用该 Runtime。项目尚未引入发行安装包构建器，因此 `electron-vite build` 本身不等于已经产出包含 Git Runtime 的可分发安装包。未来接入安装包构建时，必须把完整 Runtime 作为 APP 资源保留在可执行文件系统中，并在没有系统 Git 的全新环境验证初始化；这是“随 APP 捆绑”产品契约的发行验收要求，不改变本节的运行时边界。

Repository 路径由 Oyster 管理，但其中的普通文件保持用户可访问。用户可以通过系统文件管理器或外部编辑器修改内容；刷新后，APP 重新读取文件系统中的当前状态。

## 4. Artifact 与 `AGENTS.md` 契约

当前 MVP 使用 Artifact 的 Repository 相对路径作为身份，使用一级目录名称作为 UI 显示名称。不增加数据库记录、稳定 ID、manifest、frontmatter、Artifact 类型或独立元数据文件。

这意味着目录重命名在当前实现中等同于身份改变；MVP 不承诺在移动或重命名后维持同一个 Artifact 身份。是否引入稳定 ID 与迁移语义留待真实使用验证。

每个 Artifact 根目录必须包含 `AGENTS.md`。它是普通 Markdown，表达需要跨多次任务持续存在的 Attention，例如目标、范围、读者和维护重点。它不要求固定标题、章节、frontmatter 或机器字段，UI 也不从中推断类型和权限。

一次性的当前任务不属于持久 Attention；`AGENTS.md` 只表达需要跨任务延续的关注，不是 Artifact manifest、权限文件或知识副本。通用管理 Agent 在判断对话与某个 Artifact 有关时，从文件系统读取该 Artifact 当前的 `AGENTS.md`，而不是由 Harness 预先绑定或注入。

## 5. 当前 APP 行为

### 5.1 扫描与刷新

APP 直接枚举 Repository 的一级目录，并读取每个有效 Artifact 根部的 `AGENTS.md`。Artifact 列表和详情不依赖数据库镜像或额外索引；用户触发刷新时重新读取当前文件系统状态。

UI 展示：

- 有效 Artifact 的目录名称和 `AGENTS.md` 内容；
- Skill Artifact 的派生标记、输出状态及前往 Skills 页面管理的入口；
- 缺少或无法读取根 `AGENTS.md` 的无效可见一级目录；
- Repository 和单个 Artifact 的系统打开入口。

当前 Artifact 页面不展示内部文件树，不提供专用文件编辑器，也不承载 Skill 绑定和解绑操作；这些操作集中在 Skills 页面。通用管理 Agent 可以通过其常驻文件和 Shell 工具直接维护 Artifact 中的普通文件。

### 5.2 创建

创建 Artifact 只需要目录名称和 Attention 正文。Oyster 在 Repository 下创建对应的一级目录，并生成只包含 `# Attention` 标题和用户所填正文的根 `AGENTS.md`。这个初始排版不是后续读取所要求的固定 Schema；已有 `AGENTS.md` 仍可以使用任意 Markdown 结构。初始 Artifact 可以只有这一个文件，其余结构由用户或未来的维护流程按实际用途建立。

目录名称必须解析为 Repository 的直接子目录，不能通过绝对路径、路径分隔符或父目录引用越过 Repository 边界。目标目录已经存在时，创建失败，不覆盖已有内容。

### 5.3 打开

用户可以让系统文件管理器打开整个 Artifact Repository 或某个 Artifact 目录，再使用任意外部工具查看和修改其中内容。APP 不把外部编辑复制到另一份状态；后续刷新直接读取修改后的文件。

### 5.4 通用管理 Agent

所有对话 Session 都拥有常驻的 `read`、`edit`、`write`、`bash`、`search_knowledge`、`read_knowledge` 和 `upsert_knowledge`。四个 Coding 工具以 Artifact Repository 根作为初始 `cwd`，但 Session 不绑定 Artifact、Project 或目录；Harness 也不保存“当前 Artifact”。

当对话可能涉及 Artifact 时，Agent 自行检查 Repository 当前状态、识别相关的零个、一个或多个一级目录，并读取各自的根 `AGENTS.md`。Oyster 不引入 Artifact selector、router、自动 Attention 加载或 Artifact 级锁。

MVP 不对文件与 Shell 工具增加路径权限边界、命令白名单、Sandbox 或 Bash 逐次审批。工具以 APP 当前 OS 用户权限运行，初始 `cwd` 只是坐标起点，不能被描述为安全隔离。具体 Agent 契约见[《通用管理 Agent MVP》](chat-agent-mvp.md)。

## 6. Git Runtime 与当前职责

Git 是 Artifact Repository 的文件历史基础，而不是 Artifact Domain 的本体，也不是当前 APP 的修订工作流。Repository 从创建起就是标准 Git Repository，可以由普通 Git CLI 读取；“私有 Runtime”只表示 Git 可执行文件随 APP 捆绑且由 Oyster 自己定位，不表示专用 Repository 格式、私有 Git 方言或 Oyster 特有协议。

当前 MVP：

- 使用捆绑的私有标准 Git Runtime 初始化并保留一个标准 Git Repository；
- APP 内部调用始终使用该 Runtime 的绝对可执行文件路径，不依赖系统 Git 或 `PATH`；
- 不自动 `commit`；
- 不自动创建 branch 或 worktree；
- 不实现 diff 审核、merge 或冲突处理；
- 不要求工作区保持 clean；
- 不为每个 Artifact 建立独立 Repository 或长期 branch。

用户可以在外部按普通 Git Repository 的方式自行查看差异和提交。Oyster 默认不会向用户打开的外部终端或其他外部进程注入私有 Runtime 的路径；外部工具仍使用用户自己的环境，是否具备 Git 不影响 APP 内部 Artifact 功能。

通用管理 Agent 的 `bash` 环境在局部 `PATH` 中提供同一个标准 Git CLI，让 Agent 继续通过普通 `git` 命令工作。Oyster 不为此设计专用 Git Tool、Git RPC 或替代命令语义。Harness 不自动形成 commit，也不自动接纳或回滚一次 Agent 修订；Agent 是否使用 Git 以及如何操作由当前对话与 Repository 状态决定。并发与冲突仍按普通共享文件系统和共享 Git working tree 的语义呈现，当前不增加 Artifact 锁或专用解决流程。

## 7. 验收范围

本 MVP 验证：

- APP 总是使用固定的 `userData/artifacts/`，不要求用户选择目录；
- Repository 缺失时能够使用捆绑 Runtime 建立目录并初始化标准 Git Repository，不要求系统安装 Git；
- 有根 `AGENTS.md` 的一级目录被识别为 Artifact；
- 缺少或无法读取根 `AGENTS.md` 的可见一级目录被明确识别为无效目录；
- Artifact 的内部结构不受限制；
- 创建 Artifact 会得到一个包含根 `AGENTS.md` 的新一级目录；
- 刷新能够反映用户从外部完成的文件系统修改；
- 用户可以在系统文件管理器中打开 Repository 或 Artifact；
- 通用管理 Agent 的所有 Session 都能从 Repository 根出发，自主发现并维护相关 Artifact；
- Agent 可以通过 `bash` 使用 APP 捆绑的普通 `git` 命令，而无需系统 Git；
- Session、工具和 Harness 不绑定或预选 Artifact。

## 8. 明确不做与未决定事项

当前 MVP 明确不做：

- Artifact 专用 Agent、Artifact Session、Project/目录绑定、Artifact selector 或语义 router；
- Harness 编排的自动 Projection、知识同步或 Artifact 自动重建流程；
- Harness 自动为 Artifact 读取、选择或复制 Knowledge Statement；
- manifest、稳定 `artifactId`、Artifact 类型或固定内部 Schema；
- APP 内文件树和文件编辑器；
- Harness 自动执行的 commit、branch、worktree、diff 审核、merge、rollback 或冲突处理；
- 远端 Git、同步、团队协作或多 Repository；
- 跨 Artifact 引用、依赖、组合或构建；
- 独立的脚本执行、验证、完整安装或发布工作流；当前已确认的 Skill symlink 绑定属于后续独立应用切片，不改变本页的 Repository 实现；
- 自动把 Artifact 内容回流为 Knowledge。

以下问题继续保留为未决定事项：

- 路径身份是否足以长期使用，何时需要稳定 ID；
- Artifact 的移动、重命名、删除、归档和彻底清除语义；
- APP 是否以及何时管理 Git 修订历史；
- 多设备、团队和不同权限范围是否需要拆分 Repository；
- Artifact 之间是否需要正式引用或依赖；
- 长期是否需要稳定的 Artifact 并发、修订接纳或冲突治理机制；
- 真实使用是否证明需要在高信任 MVP 之外增加权限、Sandbox 或审批机制；
- 包含可执行内容时的验证、构建和发布产品能力。

这些问题应由真实 Artifact 使用和维护场景驱动，不应提前扩张当前最小模型。
