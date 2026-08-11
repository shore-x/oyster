# 主流 Coding Agent 的 Skill 发现与格式调研

> 状态：生态调研，不是实现规格或长期兼容性契约
>
> 日期：2026-08-01
>
> 范围：调研主流 Coding Agent 如何发现用户级、项目级及其他来源的 Skill，以及它们对 Skill 入口、元数据和附带文件的要求。本文不设计迁移、注入、绑定或执行机制。
>
> 相关原则：[知识加工、Projection 与 Artifact](../architecture/knowledge-model-and-projection.md)、[Artifact Repository MVP](../product/artifact-repository-mvp.md)
>
> 后续设计：[Skill Symlink 注入 MVP](../product/skill-symlink-injection-mvp.md)

## 1. 结论

调研结果支持当前已经确认的设计：**一个由 Oyster 管理的 Skill 对应一个完整 Artifact，当前通常表现为一个目录；Artifact 内部不应增加文件类型或内容白名单。** 早期主要维护知识型 Markdown 可以是产品默认期望，但不能成为接纳或保存契约。

原因不是为了预留抽象能力，而是现有生态已经如此：主流 Agent 正在向开放的 Agent Skills 目录格式收敛，但一个真实 Skill 经常同时包含 `SKILL.md`、脚本、参考资料、模板、图片、数据、字体甚至完整工程。开放规范本身也允许任意附加文件和目录。

不过，格式趋同不等于管理方式趋同：

- `SKILL.md` 正在成为最常见的入口文件，但各 Agent 对 frontmatter 的严格程度和扩展字段不同；
- 安装根目录、项目扫描边界、符号链接、同名冲突、插件与内置 Skill 的加载方式没有统一标准；
- “磁盘上有一个 Skill”不等于“它对当前工作目录可发现”，更不等于“当前配置已启用”或“某次 Agent Invocation 已经调用”；
- 某些 Agent 提供运行时枚举或结构化调用事件，另一些只能通过 UI、日志或文件读取间接观察。

因此，可以复用的是**整个 Skill Artifact 的内容**；发现、兼容性判断和使用观测仍然必须保留 Agent 与版本语境。Oyster 不应为了获得一个最低公共格式而丢弃未知文件、未知 frontmatter 字段或 Agent 专属元数据。

## 2. 本文中的“发现”

“Agent 注册了哪些 Skill”在现有产品中不是一个单一事实。为避免把不同证据混在一起，本文只在调研语境中区分四层含义，不预设 Oyster 的持久化 Schema：

| 含义 | 能够证明什么 | 不能证明什么 |
| --- | --- | --- |
| 文件存在 | 已知位置存在一个候选 Skill 目录或入口文件 | Agent 会加载它、它没有被禁用或遮蔽 |
| 对上下文可发现 | 按某 Agent 的规则，该 Skill 对给定版本、用户、工作目录或 Workspace 属于候选集合 | 冲突解析后一定生效 |
| 运行时有效 | Agent 自己的枚举结果表明它当前已启用或可用 | 用户或模型实际调用过它 |
| 已调用或激活 | Hook、Telemetry、Tool Call 或 Harness 原生历史记录显示发生过一次加载或调用 | Skill 改善了任务结果 |

项目级 Skill 尤其不能脱离上下文列出。不同 Agent 可能从当前目录向上扫描、只检查当前 Workspace、递归发现子目录，或者在首次访问某个子目录后才动态加入 Skill。因此所谓“本机这个 Agent 的全部已注册 Skill”，至多是若干用户级来源与一个或多个项目上下文结果的组合，而不是天然存在的全局清单。

## 3. 共同格式基线：Agent Skills

[Agent Skills Specification](https://agentskills.io/specification) 定义的是可移植包格式，不定义安装位置、作用域、冲突优先级或调用协议。规范中的最小结构是：

```text
skill-name/
├── SKILL.md          # 必需入口
├── scripts/          # 可选的可执行代码
├── references/       # 可选的参考资料
├── assets/           # 可选的模板、图片、数据等资源
└── ...               # 允许任意其他文件或目录
```

规范要求 `SKILL.md` 由 YAML frontmatter 和 Markdown body 组成：

| 字段 | 规范要求 |
| --- | --- |
| `name` | 必填，1–64 字符；只含 ASCII 小写字母、数字和单连字符；不能以连字符开头或结尾，不能包含连续连字符，并应与父目录名一致 |
| `description` | 必填，1–1024 字符；说明 Skill 做什么以及何时使用 |
| `license` | 可选 |
| `compatibility` | 可选，最多 500 字符 |
| `metadata` | 可选的字符串键值映射 |
| `allowed-tools` | 实验性可选字段；不同客户端的支持和解释并不一致 |

Markdown body 没有固定章节要求。规范也没有规定附带文件的扩展名白名单、文件数量、目录总大小、脚本语言或依赖安装方式。`scripts/`、`references/` 和 `assets/` 是推荐组织方式，不是仅有的合法目录。

这项规范能够作为目标 Agent 的**兼容性参照**，但不应成为 Oyster 接纳 Skill Artifact 的门槛。实际客户端可能比规范宽松，也可能增加专属字段；例如 Claude Code 可以加载缺少标准字段甚至 frontmatter 损坏的正文，而 Codex 等实现更依赖有效的 `name` 与 `description`。把“是否符合开放规范”和“某个具体 Agent 是否能加载”合并成一个布尔结论会产生误报。

## 4. 各 Agent 如何发现 Skill

以下结论基于截至调研日期的官方文档、官方仓库源码和发行记录。路径中的 `~` 或 `$HOME` 表示当前用户主目录；项目结论都必须结合启动目录、Workspace Trust、配置与产品版本理解。

### 4.1 发现矩阵

| Agent | 用户级或机器级来源 | 项目级来源与范围 | 其他来源与运行时证据 |
| --- | --- | --- | --- |
| Codex | `$HOME/.agents/skills`；管理员目录 `/etc/codex/skills`；OpenAI bundled system Skills；当前实现还兼容旧 `$CODEX_HOME/skills` | 从当前 `cwd` 到 repository root 的每一级 `.agents/skills` | App Server `skills/list` 可按一个或多个 `cwd` 返回 Skill 的路径、scope、enabled 与错误，并有 `skills/changed` 失效通知；用户和项目 Skill 支持目录 symlink |
| Claude Code | `~/.claude/skills`；bundled Skills；enterprise managed 来源 | 从启动 `cwd` 向上到 repo root 的各级 `.claude/skills`；启动目录以下的嵌套 `.claude/skills` 在首次读写相应子树后动态加入 | `--add-dir`、Plugin `skills/`、Plugin 自定义路径和旧 `.claude/commands/*.md` 都可能贡献能力；官方未公布稳定的外部机器可读全量枚举 API |
| Pi | `~/.pi/agent/skills`、`~/.agents/skills`；前者根可由 `PI_CODING_AGENT_DIR` 改写 | 只检查当前 `cwd/.pi/skills`；同时从 `cwd` 向上到 Git 根或文件系统根检查各级 `.agents/skills`；项目 Skill 受 Trust 控制 | 用户/项目 `settings.json`、Pi Package、重复 `--skill` 和 Extension 均可提供 Skill；RPC `get_commands` 可列当前有效名称、路径和来源，但不列被遮蔽副本 |
| Gemini CLI | `~/.gemini/skills`、`~/.agents/skills`；另有 built-in 与 Extension Skills；没有独立机器级 Skill 目录 | 只检查当前 `cwd/.gemini/skills` 和 `cwd/.agents/skills`，不向祖先扫描，并要求受信 Workspace | `gemini skills list --all` 列冲突解析后的名称、enabled、built-in、描述与位置，但输出面向人且不显示被遮蔽副本 |
| GitHub Copilot / VS Code | 文档列出 `~/.copilot/skills`、`~/.claude/skills`、`~/.agents/skills`，具体集合随 Copilot surface 与版本变化 | 文档列出 `.github/skills`、`.claude/skills`、`.agents/skills`；VS Code 默认围绕打开的 Workspace，monorepo 父级发现默认关闭 | VS Code 可用 `chat.agentSkillsLocations` 增加位置，Extension 可通过 `contributes.chatSkills` 注册；内置、Plugin 与 GitHub 云端环境不能由本机固定目录扫描完整覆盖 |
| Cursor | `~/.agents/skills`、`~/.cursor/skills`，并兼容 `~/.claude/skills`、`~/.codex/skills` | `.agents/skills`、`.cursor/skills`，并兼容 `.claude/skills`、`.codex/skills`；还发现仓库任意嵌套的 `.agents/skills` 与 `.cursor/skills`，按子目录限定作用域 | Customize → Skills 显示已发现、内置和 Plugin Skills；官方未公布稳定的本地机器可读枚举 API 或固定的内置/Plugin 文件位置 |
| OpenCode | `~/.config/opencode/skills`、`~/.claude/skills`、`~/.agents/skills` | 从当前 `cwd` 向上到 Git worktree 扫描 `.opencode/skills`、`.claude/skills`、`.agents/skills` | `opencode debug skill` 和 Server `GET /skill` / SDK `app.skills` 可以列当前有效集合；源码在 Skill 根内递归匹配 `**/SKILL.md` |

### 4.2 同名、作用域与优先级不能跨 Agent 统一

- **Codex** 不合并同名 Skill；同名项可以同时出现在 selector 中。
- **Claude Code** 公布的层级是 `enterprise > personal > project > bundled`；同名 Skill 优先于旧 command，Plugin Skill 使用 `plugin-name:skill-name` namespace。该顺序甚至与 Agent Skills 非规范客户端指南建议的 project-over-user 不同。
- **Pi** 的有效顺序为 CLI 显式路径、项目 settings、项目自动发现、用户 settings、用户自动发现、Package；同名先到先得。
- **Gemini CLI** 采用 built-in、Extension、用户、Workspace 逐层覆盖，同层 `.agents/skills` 高于 `.gemini/skills`。
- **GitHub Copilot CLI** [明确采用 first-found](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#skill-locations)，但 VS Code 与 GitHub 云端没有公布可直接套用的稳定顺序。
- **Cursor** 没有公布稳定同名优先级。
- **OpenCode** 文档要求所有来源名称唯一；当前源码会警告后覆盖，但加载并发使覆盖顺序不应被当作契约。

因此，静态扫描时不能仅按 `name` 合并来源，也不能由 Oyster 发明一个跨 Agent 优先级来判断“最终生效版本”。来源 Agent、版本、scope、实际路径和查询时的 `cwd` 都是解释发现结果所需的证据语境。

### 4.3 运行时枚举与文件扫描互补

如果 Agent 提供官方运行时枚举，它更接近“对给定上下文实际有效的集合”：Codex App Server 能返回 scope 与 enabled，Pi RPC 能反映冲突后的 command 集合，Gemini CLI 能列冲突解析结果，OpenCode 则有结构化 Server/SDK 接口。

但运行时枚举通常围绕当前有效集合：有些接口能额外显示 enabled 状态，却仍不能完整显示被同名遮蔽或未进入当前项目上下文的目录；文件扫描可以补足这些候选来源。反过来，只扫描文件又会漏掉 bundled、Plugin、Extension、managed source、动态目录与配置状态。二者是不同证据，不能互相伪装：

```text
文件扫描：有哪些已知候选来源？
运行时枚举：给定 Agent、版本、配置和 cwd，哪些项当前有效？
```

Codex 已有一个值得保留的产品先例：App Server 把 `externalAgentConfig/detect` 与 `externalAgentConfig/import` 分成两个动作，检测不会修改源 Agent，导入也不会覆盖已有目标目录。这进一步说明“发现外部 Skill”和“把它纳入 Oyster Artifact”应保持为两个独立用户动作，但本文不提前定义导入机制。

## 5. 各 Agent 的格式与附带文件要求

### 5.1 兼容性矩阵

| Agent | 入口与 frontmatter | 产品扩展或宽松行为 | 附带文件与其他载体 |
| --- | --- | --- | --- |
| Codex | 采用目录根 `SKILL.md` 和 Agent Skills 的 `name`、`description` 基线 | 可选 `agents/openai.yaml` 表达 UI、隐式调用策略和工具依赖；这是 Codex 元数据，不是开放 Skill 的通用要求 | 支持 scripts、references、assets 与其他内容；Plugin 打包还有独立校验，不能反推普通本地 Skill 的 Artifact 限制 |
| Claude Code | 入口为 `SKILL.md`，但产品实现把 frontmatter 字段都视为 optional；无 description 时可使用正文首段，损坏 YAML 仍可能加载正文 | 支持 `argument-hint`、`disable-model-invocation`、`user-invocable`、`allowed-tools`、`model`、`context`、`agent`、`hooks` 等产品字段，以及动态 shell 内容 | supporting files 与脚本均受支持，可用 `${CLAUDE_SKILL_DIR}` 相对引用；旧 `.claude/commands/*.md` 是单文件兼容来源 |
| Pi | 文档要求 `name`、`description`；当前实现缺 name 时回退目录名，缺 description 则不加载，未知字段忽略 | `disable-model-invocation: true` 隐藏自动发现但仍可显式调用；`allowed-tools` 尚不能当作稳定权限契约 | 递归发现 Skill 目录并允许任意附件；原生 `.pi/skills` 和显式目录还兼容根部单个 `*.md`；支持 symlink |
| Gemini CLI | 文件名必须精确为 `SKILL.md`；frontmatter 必须从首字符开始并给出字符串 `name`、`description`；运行时校验比开放规范宽松 | 未知字段不会进入运行时定义；内置 skill-creator 的严格打包校验不等于加载契约 | 官方示例包含 JS、Python、Bash、JSON、模板、图片、字体与完整工程；`.skill` 安装包是 ZIP，`skills link` 使用目录链接 |
| GitHub Copilot / VS Code | `name`、`description` 必填，整体遵循 Agent Skills | GitHub 支持 `license`、`allowed-tools`；VS Code 另有 `argument-hint`、`user-invocable`、`disable-model-invocation` 与实验性 `context` | 自动发现目录内脚本、示例和其他资源；附带文件通常由 `SKILL.md` 相对引用 |
| Cursor | `name`、`description` 必填，声明采用 Agent Skills | 支持 `paths`、`disable-model-invocation`、`metadata`，旧 `globs` 仅用于兼容 | Skill 根内可以按类别嵌套并携带 scripts、references、assets 和其他资源；脚本语言取决于 Agent 可用工具 |
| OpenCode | 文档要求 `name`、`description`；当前实现读取可能更宽松，不应代替文档契约 | 识别 `license`、`compatibility`、`metadata`，未知字段忽略 | 原生 `skill` Tool 返回正文、基础目录与附件样本，Agent 可继续读取脚本和其他资源 |

### 5.2 目录扫描也没有统一深度

- Codex 和 Claude Code 的公开本地目录契约以 Skill 根的直接子目录为基本单位；Claude 的“动态嵌套项目 Skill”指项目子树作用域，不表示在一个 Skill 根中任意递归。
- Pi 会递归查找 `SKILL.md`，但发现一个 Skill 根后停止向其内部继续寻找嵌套 Skill，并跳过点目录、`node_modules` 及 ignore 规则覆盖内容。
- Gemini CLI 只检查一个 Skill root 自身或其一级子目录中的 `SKILL.md`。
- Cursor 和 OpenCode 明确支持在 Skill root 内递归寻找 `SKILL.md`。

所以，即使所有产品都接受 `SKILL.md`，也不能用同一个递归 glob 代表每个 Agent 的真实发现规则。扫描算法属于 Agent 适配事实，不属于 Skill Artifact 的内容定义。

### 5.3 保存、兼容与执行是三件事

Skill 中存在脚本、二进制、依赖声明或动态 shell 内容，只说明这些文件属于外部 Skill 的完整内容。它不自动表示：

- Oyster 信任或执行了这些内容；
- 目标 Agent 具有对应的语言运行时、工具或依赖；
- Agent Skills 的 `allowed-tools` 或某个产品的依赖字段在其他 Agent 上有同样含义；
- 这个 Skill 在另一个 Agent 中通过格式校验或能正确运行。

因此，外部格式和未知扩展应原样保留；发现或兼容性检查可以给出目标 Agent 专属诊断，但不得自动删除文件、改写字段或阻止它成为 Oyster Artifact。这不限制用户或维护 Agent 在明确的 Artifact 编辑任务中修改 Skill。

当前 Artifact Repository 统一要求的根 `AGENTS.md` 属于 Oyster 的载体与 Attention 契约，不替代外部 Agent 使用的 `SKILL.md`，也不是对目标 Agent Skill 格式作出的要求。后续绑定设计已确定把外部可消费内容放在 Artifact 根 `output/` 中，并只将该目录 symlink 到目标 Agent，因此根 `AGENTS.md` 不会成为外部 Skill 根文件；这项后续设计不改变本文的格式调研结论。

## 6. 使用情况的现有可观测线索

虽然本轮不设计调用统计，发现调研已经足以说明后续“调用频率”不能采用一个跨 Agent 的统一读取方法：

| Agent | 可观察证据 | 主要限制 |
| --- | --- | --- |
| Codex | App Server 提供当前 Skill 的枚举接口；本轮没有确认一个公开、稳定的逐 Skill 调用事件 | 可用不等于被调用，不能从 `skills/list` 推导频率 |
| Claude Code | 模型调用可由 `Skill` Tool 的 Hook/OTel 观察；用户直接 `/skill` 需观察 `UserPromptExpansion` 或对应 OTel；成本与 token 可带 `skill.name` | 两条调用路径必须合并；工具成功、成本和 token 都不代表任务效果 |
| Pi | 显式 `/skill:name` 会在历史中留下展开块；自动选择通常只能从读取已知 `SKILL.md` 路径推断 | 自动调用没有稳定专用事件，路径读取只是代理信号 |
| Gemini CLI | 自动和显式调用都会经过 `activate_skill`，可从 Session、Hook 和 OTel 观察 | 非内置 Skill 可能等待确认，应以成功结果而非请求次数统计实际激活 |
| VS Code Copilot | Opt-in OTel 的 tool span 可包含 `skill_name` | 默认关闭，不能补回启用前历史；GitHub 云端没有等价的全局聚合接口 |
| Cursor | UI 可见已发现状态；通用 Hook 和 transcript 能提供部分文件/工具活动 | 没有官方 Skill 专用调用事件，不能把读取入口文件直接当作效果事实 |
| OpenCode | Skill 是原生 `skill` Tool，Session Tool Part 含名称、输入、结果与状态 | 调用成功仍不表示 Skill 改善了任务结果 |

“调用次数”“成功激活次数”“处于 Skill 上下文中的 token/cost”和“任务效果”是不同指标。当前生态没有提供统一的 Skill 效果事件，后续可观测性设计必须如实标注证据含义，不能把代理信号包装成效果评估。

## 7. 对下一步开发方向的分析

在不进入具体方案的前提下，本轮调研支持以下开发顺序：

1. **先验证只读可观测性。** 当前最明确的问题是用户不知道各 Agent 在不同项目语境中有哪些候选、哪些实际有效。它可以独立验证价值，不要求先解决迁移、注入或执行。
2. **保持外部发现与 Oyster 纳管分离。** 发现只描述外部 Agent 的当前事实；只有后续明确的用户动作才可能把完整目录转为一个 Skill Artifact。外部目录不能因为被看见就自动成为 Oyster 的权威状态。
3. **以 Agent 适配保留差异。** 通用部分只需要理解“完整 Skill 候选”和开放格式基线；路径、scope、cwd、优先级、插件、内置来源与运行时枚举都留在各 Agent 适配边界。
4. **优先相信 Agent 的运行时有效集合，同时保留文件来源证据。** 有官方枚举时，它比猜测配置更接近实际状态；静态扫描则用于发现未启用、被遮蔽或运行时不暴露的候选。界面和分析不应把两者合并成一个含糊的“已安装”。
5. **格式分析只提供兼容性信息。** Oyster 保存完整目录和未知内容；面向某个目标 Agent 时，再判断入口、frontmatter、专属扩展、依赖与目录位置是否兼容。一个 Agent 无法加载不构成拒绝 Artifact 的理由。
6. **调用观察后于发现，但早于自动优化。** 只有先确认每个 Agent 能提供什么级别的调用证据，优化建议才有可解释基础。调用次数本身不足以支持“自进化”或自动改写 Skill。

这意味着调研阶段最小的下一验证方向是“看清外部状态并在 Oyster 内维护完整 Skill Artifact”，而不是立即统一接管其他 Agent 的 Skill 注册。后续在保持发现与纳管分离的前提下，已以固定 `output/` 和目录 symlink 落地首个用户级 Skill Binding 切片，见[《Skill Symlink 注入 MVP》](../product/skill-symlink-injection-mvp.md)。

## 8. 不确定性与后续验证

以下内容不应在没有安装版本验证时固化为兼容性承诺：

- Agent Skills 规范不负责发现路径；`.agents/skills` 是越来越常见的共享位置，但不是每个 Agent 都承诺扫描它。
- VS Code 2026-07-29 的 Skills 页面列出 `.agents/skills`，同日 settings 文档和当前默认常量仍只列 GitHub、Claude、Copilot 目录，应按具体安装版本核验。
- Claude Code 没有完整公开 enterprise Skill 的逐平台子路径；Plugin cache 中的旧版本可以暂时保留，扫描 cache 不能证明当前启用。
- GitHub 云端 coding agent、VS Code 与本地 Copilot CLI 是不同运行环境，本机个人目录不能直接外推为云端发现来源。
- Cursor 没有公开内置/Plugin Skill 的稳定文件位置、机器可读枚举 API 或同名优先级。
- OpenCode、Pi、Gemini CLI 的当前源码在部分 frontmatter 校验上比产品文档宽松；兼容性结论应以文档为契约，并把实际版本行为另行记录。
- Codex 的当前 loader 使用 `agents/openai.yaml`，但 App Server 协议注释仍可见 `SKILL.json` 表述；这类产品扩展仍在演进，不能提升为 Oyster 通用格式。
- Symlink、忽略规则、Workspace Trust、配置关闭、Plugin 启用与同名冲突都会使文件扫描和运行时结果不同。

后续若进入实现前验证，应为每个目标 Agent 固定记录 `product/version + cwd/workspace + config/trust + discovery source`，并用包含用户级、项目级、同名、禁用、symlink、脚本与未知文件的 fixture 对照“文件扫描结果”和“Agent 自身枚举结果”。这只是兼容性验证要求，不改变 Skill Artifact 的包容性原则。

## 9. 主要官方来源

### 开放规范

- [Agent Skills Specification](https://agentskills.io/specification)
- [Adding Agent Skills support to your product](https://agentskills.io/client-implementation/adding-skills-support)
- [Agent Skills 官方仓库与参考实现](https://github.com/agentskills/agentskills)

### Codex

- [Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex 官方源码：Skill loader](https://github.com/openai/codex/blob/6751b54cae32b23786001e2414d749a9916201e1/codex-rs/core-skills/src/loader.rs)
- [Codex 官方源码：App Server 协议](https://github.com/openai/codex/blob/6751b54cae32b23786001e2414d749a9916201e1/codex-rs/app-server/README.md)

### Claude Code

- [Skills](https://code.claude.com/docs/en/skills)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Monitoring usage](https://code.claude.com/docs/en/monitoring-usage)

### Pi

- [Skills 文档（核对快照）](https://github.com/earendil-works/pi/blob/4488ad55c18f07ae89a489096c90de8667b3adfb/packages/coding-agent/docs/skills.md)
- [Skill loader（核对快照）](https://github.com/earendil-works/pi/blob/4488ad55c18f07ae89a489096c90de8667b3adfb/packages/coding-agent/src/core/skills.ts)
- [发现与优先级（核对快照）](https://github.com/earendil-works/pi/blob/4488ad55c18f07ae89a489096c90de8667b3adfb/packages/coding-agent/src/core/package-manager.ts)

### Gemini CLI

- [Agent Skills 文档（核对快照）](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/docs/cli/skills.md)
- [创建 Skill（核对快照）](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/docs/cli/creating-skills.md)
- [Skill loader（核对快照）](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/core/src/skills/skillLoader.ts)

### GitHub Copilot 与 VS Code

- [GitHub Copilot：About Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
- [GitHub Copilot CLI：Skill locations](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#skill-locations)
- [GitHub Copilot CLI：Loading order and precedence](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference#loading-order-and-precedence)
- [VS Code：Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills)
- [VS Code：Customizations in a monorepo](https://code.visualstudio.com/docs/agent-customization/overview#_use-customizations-in-a-monorepo)
- [VS Code：Monitoring agents with OpenTelemetry](https://code.visualstudio.com/docs/agents/guides/monitoring-agents)

### Cursor

- [Cursor：Agent Skills](https://cursor.com/docs/skills)
- [Cursor：Hooks](https://cursor.com/docs/hooks)

### OpenCode

- [OpenCode：Agent Skills](https://opencode.ai/docs/skills/)
- [OpenCode 官方源码：Skill discovery](https://github.com/anomalyco/opencode/blob/19231fce4b70aa5f7894a0a0eb20ff29bd417db5/packages/opencode/src/skill/index.ts)
- [OpenCode 官方源码：Skill Tool](https://github.com/anomalyco/opencode/blob/19231fce4b70aa5f7894a0a0eb20ff29bd417db5/packages/opencode/src/tool/skill.ts)
