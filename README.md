# Oyster

Oyster 是一个独立于外部 Agent Harness 的本地知识与协作产物中心。当前纵向切片已经覆盖 Claude Code、Pi、Codex 的会话 transcript 与人类指令发现、登记和按需读取；Maintainer 与 Reviewer 可以在统一 Git Repository 中运行完整知识加工链路，通用 Chat Agent 也从同一根目录维护全局 Knowledge 与 Artifact。

## 当前可用功能

- 主动探测 Claude Code、Pi、Codex 的默认目录、环境变量目录和 CLI 路径；
- 手工选择自定义历史目录；
- 有界读取 JSONL header，统计文件、会话、人类指令、字节数、时间范围和异常文件；
- 按各 Agent 的官方层级发现 `CLAUDE.md`、`AGENTS.md`、rules 和 system prompt files，明确排除 Agent 自动 memory；
- 登记外部记录的稳定身份、内部 locator 和轻量版本指纹，不复制聊天正文；
- 由 Source Adapter 从原始位置按需读取用户选中的单条记录，并拒绝已经变化或失效的版本；
- Session 选择器可显式刷新所有已配置的本机来源，并以单一 catalog snapshot 同步刷新状态与可选列表；
- 展示扫描状态、来源统计和异常文件数；
- Codex `sessions` / `archived_sessions` 去重；
- 配置 Codex Coding Plan、OpenAI API 或自定义 OpenAI-compatible Connection，发现其可用模型，OAuth 与 API Key 凭据保存在系统 Keychain；
- 在 AI 后端页面统一配置应用的默认 LLM，供 Knowledge Maintainer 新运行和新建 Chat Session 使用；
- 通过独立的 Agent 配置页查看当前已注册的模型运行角色、代码内置 System Prompt 和实际工具清单，并为各角色配置默认 System Prompt；
- 从可用外部 Session 的确定 revision 读取完整 Raw Evidence，由 Host 确定性分段并绑定为 Maintainer 的初始 Todo；
- 使用 Pi Agent Core 完整读取 Canonical Activity 与附件，按需回查 Raw Evidence，并直接维护全局 `knowledge/` 与 `artifacts/`；
- 在一次加工 Run 中依次运行 Maintainer 与 Reviewer；Reviewer 可以要求修改或批准候选 revision，但不执行 merge，也不为批准创建额外 commit；
- 在同一个运行窗口按 handoff 顺序展示 Maintainer 与 Reviewer 的完整 Agent Run 轨迹；
- 在 `runs/<run-id>/WORK.md` 保存工作清单与角色交接，在 `run.json` 保存终态输入、结果和多 Agent 运行历史；
- 通过知识页面直接搜索和浏览 `knowledge/**/*.md` 中的全局 Knowledge Statement；
- 使用持久化的通用 Chat Agent 进行普通对话，并通过 `read`、`edit`、`write`、`bash` 维护 Knowledge 与一个或多个 Artifact；
- 使用随 APP 捆绑的私有标准 Git Runtime 自动初始化固定的 `userData/repository/`，不依赖系统 Git 或用户 `PATH`；
- 按“带根 `AGENTS.md` 的一级目录”发现、刷新和创建 Artifact，并显示持久 Attention 与无效目录；
- 在系统文件管理器中打开 Artifact Repository 或单个 Artifact；Artifact 内部结构任意，通用管理 Agent 可以直接维护其普通文件；
- 在专门的 Skills 页面分开展示 Oyster 管理的 Skill Artifact 与其他 Agent 的外部注册事实，并预览各自入口文档；
- 将有效 Skill Artifact 的 `output/` 通过安全、可撤销的目录 symlink 绑定到 Claude Code、Pi 或 Codex 的用户级 Skill 注册位置；
- 提供 Maintainer → Reviewer 完整加工测试，并保留高级阶段调试；
- Electron Renderer 与文件系统业务逻辑通过 typed preload API 隔离。

## 本地开发

需要 Node.js 22.19 或更新版本（Pi Agent Core 的运行要求）。

```bash
npm ci
npm run dev
```

`npm run dev` 会先检查 Electron npm 包对应的桌面端二进制。如果依赖安装时因为 `--ignore-scripts`、网络中断或缓存不完整而缺少 `node_modules/electron/path.txt`，启动脚本会自动执行 Electron 官方安装器进行修复。

如果二进制下载仍然失败，可以单独重试并查看完整错误：

```bash
npm run electron:ensure
```

Electron 二进制来自 GitHub Releases。需要代理的环境可设置 `ELECTRON_GET_USE_PROXY` 和系统代理变量；无法访问 GitHub 的环境可按 [Electron 官方安装说明](https://www.electronjs.org/docs/latest/tutorial/installation)配置 `ELECTRON_MIRROR`。这些变量只影响 Electron 二进制下载，不应提交个人代理地址到仓库。

验证命令：

```bash
npm run typecheck
npm test
npm run build
npm run test:ui
```

`test:ui` 会启动固定数据模式的 Electron 窗口，将截图和语义快照写入 `artifacts/ui/`，然后自动退出。

## 代码边界

```text
src/renderer     页面、视图状态和用户动作
  src/ui         共享 Button/Icon 组件、design tokens 与控件样式
src/preload      typed IPC bridge
src/main         Electron 生命周期和 IPC composition root
src/main/discovery
  adapters       各 Agent 的定位、header 解析、人类指令发现与原地读取
  discovery-service  扫描、catalog、版本校验与访问协调
  repository     可替换的状态持久化边界
  source-evidence-reader 外部 Raw Evidence 的原地只读访问边界
src/main/ai-backends
  Connection、Keychain、Coding Plan OAuth、模型目录与 OpenAI-compatible 调用
src/main/knowledge-processing
  Maintainer/Reviewer Prompt、Run 工作文件、Pi Agent Runtime 与完整链路编排
src/main/knowledge-store
  基于统一 Repository 中 Markdown 文件的 Knowledge 浏览边界
src/main/chat
  基于 Pi Agent Core 的通用管理 Agent、文件/Coding 工具、JSONL 会话与默认 Prompt 配置
src/main/artifacts
  全局 Artifact 目录扫描与创建，以及 Skill Artifact 派生识别
src/main/repository
  统一 Repository 初始化与 Git Runtime 边界
src/main/skills
  外部 Skill 只读发现、Oyster 管理视图与用户级 symlink Binding
src/shared       Main / Preload / Renderer 共用契约
```

生产模式只把外部来源的 catalog 状态写入 Electron `userData/discovery-state.json`，不复制 Agent 历史正文。上游 Agent 目录始终只读；记录变化或消失后，已保存的出处身份继续存在，但原文可能无法再次展开。JSON repository 是当前 bootstrap 实现，接口已与业务层隔离，数据量验证后可以替换为 SQLite。

AI Connection 元数据和唯一 Default LLM 保存在 `userData/ai-connections.json`；Maintainer/Reviewer Prompt 覆盖独立保存在 `userData/knowledge-processing.json`；OAuth 与 API Key 凭据只保存在系统 Keychain。通用 Chat Agent 的默认 Prompt 保存在 `userData/chat-agent.json`，完整对话与工具消息使用 Pi JSONL 格式独立保存在 `userData/chat-sessions/`。新 Session 捕获创建时的 Default LLM，已有 Session 不随默认值变化；Session 不绑定 Artifact、Project 或独立 `cwd`。

APP 固定创建一个 `userData/repository/` 标准 Git Repository。`knowledge/` 与 `artifacts/` 是全局事实层；`runs/<run-id>/` 是与二者并列的过程记录，不拥有或复制领域文件。每个带根 `AGENTS.md` 的 `artifacts/` 一级目录是一个 Artifact，`AGENTS.md` 表达持久 Attention，其余内容保持包容。根部存在 `output` 时，Skill 应用派生出 Skill Artifact 视图，但不增加 manifest 或核心 Artifact 类型。Knowledge 与 Artifact 页面直接读取文件系统，不维护数据库镜像。

结构化知识加工从 `main` 创建 `processing/<run-id>` 分支，但所有 Agent 都在同一个物理工作树和 Repository 根工作，不创建 worktree、Workspace 副本或 symlink。Maintainer 创建 Knowledge/Artifact commit；Reviewer 请求修改时提交反馈，批准时只由 Harness 在当前 Run 的 `WORK.md` 记录精确 candidate OID。Reviewer 不 merge。`runs/` 被 Git 忽略，因此运行记录不会污染候选内容 diff；当前模型暂不加入并发锁、队列或 promotion 治理。

Oyster 随 APP 捆绑私有的标准 Git Runtime，APP 内部始终按绝对可执行文件路径调用它，因此系统 Git 不是运行前置条件。Repository 仍兼容普通 Git CLI。“私有”只描述 Runtime 的分发和定位，不表示专有 Git 格式。通用管理 Agent 的 `bash` 环境在局部 `PATH` 中提供同一个标准 `git` 命令，不增加专用 Git Tool；外部终端默认不获得这一注入。

所有通用 Chat Agent Session 常驻 `read`、`edit`、`write`、`bash`、通用 Todo 和 `spawn_agent`。工具以统一 Repository 根作为初始 `cwd`；Knowledge 搜索、读取和写入使用普通文件工具，不再维护平行的专用 Knowledge CRUD 协议。Harness 不绑定或预选 Artifact，也不设置路径 Sandbox、Shell 命令限制或逐次审批；工具按 APP 当前 OS 用户权限运行。Agent 根据对话和文件系统自行发现相关 Knowledge 与 Artifact，并读取各 Artifact 根 `AGENTS.md`。

当前产品范围与设计边界见 [Product Brief](docs/product/product-brief.md)、[本地 Agent 发现与外部证据访问](docs/product/local-agent-discovery-mvp.md)、[外部 Agent Skill 发现与浏览 MVP](docs/product/skill-discovery-mvp.md)、[Skill Symlink 注入 MVP](docs/product/skill-symlink-injection-mvp.md)、[AI Backend MVP](docs/product/ai-backends-mvp.md)、[知识加工验证 MVP](docs/product/knowledge-processing-mvp.md)、[通用管理 Agent MVP](docs/product/chat-agent-mvp.md)、[Artifact Repository MVP](docs/product/artifact-repository-mvp.md)和[知识加工、Projection 与 Artifact](docs/architecture/knowledge-model-and-projection.md)。
