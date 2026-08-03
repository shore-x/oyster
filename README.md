# Oyster

Oyster 是一个独立于外部 Agent Harness 的本地知识与协作产物中心。当前纵向切片已经覆盖 Claude Code、Pi、Codex 的会话 transcript 与人类指令发现、登记和按需读取，可以在物理隔离的 SQLite Knowledge Sandbox 中运行完整知识加工链路，并通过一个通用管理 Agent 搜索和维护正式 Knowledge 以及文件系统中的 Artifact；自动 Projection、Canonical Activity 与正式知识生产仍待实现。

## 当前可用功能

- 主动探测 Claude Code、Pi、Codex 的默认目录、环境变量目录和 CLI 路径；
- 手工选择自定义历史目录；
- 有界读取 JSONL header，统计文件、会话、人类指令、字节数、时间范围和异常文件；
- 按各 Agent 的官方层级发现 `CLAUDE.md`、`AGENTS.md`、rules 和 system prompt files，明确排除 Agent 自动 memory；
- 登记外部记录的稳定身份、内部 locator 和轻量版本指纹，不复制聊天正文；
- 由 Source Adapter 从原始位置按需读取用户选中的单条记录，并拒绝已经变化或失效的版本；
- 展示扫描状态、来源统计和异常文件数；
- Codex `sessions` / `archived_sessions` 去重；
- 配置 Codex Coding Plan、OpenAI API 或自定义 OpenAI-compatible Connection，发现其可用模型，OAuth 与 API Key 凭据保存在系统 Keychain；
- 为知识加工的每个阶段独立选择 Connection、具体 Model 和模型支持的思考强度；
- 通过独立的 Agent 配置页查看当前已注册的模型运行角色、代码内置 System Prompt 和实际工具清单，并为各角色配置默认 System Prompt；
- 从可用外部 Session 的确定 revision 运行 Observation Preprocessor，分段发现带 Raw Evidence 位置的开放 Candidate 问题；
- 使用 Pi Agent Core 调查开放 Candidate Agenda、按需读取 Raw Evidence、增量维护 Contribution Draft，并在全部 Candidate 得到处置后提交 Knowledge Contribution；
- 在独立 SQLite Knowledge Sandbox 中按 canonical title 原子创建、覆盖并回读自由文本 Statement；
- 持久保存成功的完整链路测试快照，按需查看历史结果、模型输出和工具结果；
- 将当前或历史测试结果显式导入正式知识库，并按 canonical title 创建或覆盖 Statement；
- 通过独立知识库页面搜索、浏览和清空当前持久 Knowledge Statement；
- 使用持久化的通用管理 Agent 进行普通对话，搜索、读取和维护正式知识库，或通过 `read`、`edit`、`write`、`bash` 维护一个或多个 Artifact；
- 使用随 APP 捆绑的私有标准 Git Runtime 自动初始化固定的 `userData/artifacts/` Repository，不依赖系统 Git 或用户 `PATH`；
- 按“带根 `AGENTS.md` 的一级目录”发现、刷新和创建 Artifact，并显示持久 Attention 与无效目录；
- 在系统文件管理器中打开 Artifact Repository 或单个 Artifact；Artifact 内部结构任意，通用管理 Agent 可以直接维护其普通文件；
- 在专门的 Skills 页面分开展示 Oyster 管理的 Skill Artifact 与其他 Agent 的外部注册事实，并预览各自入口文档；
- 将有效 Skill Artifact 的 `output/` 通过安全、可撤销的目录 symlink 绑定到 Claude Code、Pi 或 Codex 的用户级 Skill 注册位置；
- 默认提供明确标记为 Sandbox 的完整链路测试，同时保留不提交 Knowledge Contribution 的高级阶段调试；
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
  Prompt 与工具目录、临时 Workspace、Observation Preprocessor、Pi Agent Runtime 与完整链路编排
src/main/knowledge-store
  当前 SQLite Knowledge Store 验证实现、按 title 读写 Statement 与隔离 Sandbox
src/main/chat
  基于 Pi Agent Core 的通用管理 Agent、Knowledge/Coding 工具、JSONL 会话与默认 Prompt 配置
src/main/artifacts
  固定 Artifact Repository、目录扫描与创建，以及 Skill Artifact 派生识别
src/main/skills
  外部 Skill 只读发现、Oyster 管理视图与用户级 symlink Binding
src/shared       Main / Preload / Renderer 共用契约
```

生产模式只把外部来源的 catalog 状态写入 Electron `userData/discovery-state.json`，不复制 Agent 历史正文。上游 Agent 目录始终只读；记录变化或消失后，已保存的出处身份继续存在，但原文可能无法再次展开。JSON repository 是当前 bootstrap 实现，接口已与业务层隔离，数据量验证后可以替换为 SQLite。

AI Connection 元数据，以及知识加工阶段的 Connection、Model 和用户默认 Prompt 配置，分别保存在 `userData/ai-connections.json` 与 `userData/knowledge-processing.json`；OAuth 与 API Key 凭据只保存在系统 Keychain。通用管理 Agent 的默认 Prompt 保存在 `userData/chat-agent.json`，完整对话与工具消息使用 Pi JSONL 格式独立保存在 `userData/chat-sessions/`。Session 不绑定 Artifact、Project 或 `cwd`。Observation Workspace 只存在于主进程内存中，Candidate Agenda 和 Contribution Draft 只存在于一次知识维护运行中。当前验证 Knowledge Store 位于 `userData/knowledge-store/knowledge.sqlite`；完整链路使用 `userData/knowledge-store/sandboxes/` 下的独立快照，失败或取消时立即丢弃，成功重跑会替换当前 Sandbox。成功的完整链路结果另存于 `userData/knowledge-processing-history.sqlite`，不依赖 Sandbox 继续存在；它默认与正式知识隔离，只有用户显式导入时才按 canonical title 写入正式 Store。SQLite 是当前实现选择，不代表正式知识层的长期存储介质已经确定。

Artifact Repository 固定在 `userData/artifacts/`，由 APP 创建并初始化为标准 Git Repository；用户不选择其他目录。每个带根 `AGENTS.md` 的一级目录是一个 Artifact，`AGENTS.md` 表达持久 Attention，其余内容保持包容。根部存在 `output` 时，Skill 应用派生出 Skill Artifact 视图，但不增加 manifest 或核心 Artifact 类型。Artifact 页面只显示这一身份和摘要；绑定管理集中在 Skills 页面。UI 直接读取文件系统，不维护数据库镜像；当前路径暂作身份，APP 不自动 commit、创建 branch/worktree、审核 diff、merge 或处理冲突。

Oyster 随 APP 捆绑私有的标准 Git Runtime，APP 内部始终按绝对可执行文件路径调用它，因此系统 Git 不是运行前置条件。Repository 仍兼容普通 Git CLI。“私有”只描述 Runtime 的分发和定位，不表示专有 Git 格式。通用管理 Agent 的 `bash` 环境在局部 `PATH` 中提供同一个标准 `git` 命令，不增加专用 Git Tool；外部终端默认不获得这一注入。

所有通用管理 Agent Session 常驻 `read`、`edit`、`write`、`bash`、`search_knowledge`、`read_knowledge` 和 `upsert_knowledge`。Coding 工具以 Artifact Repository 根作为初始 `cwd`，但 Harness 不绑定或预选 Artifact，也不设置路径 Sandbox、Shell 命令限制或逐次审批；工具按 APP 当前 OS 用户权限运行。Agent 根据对话和文件系统自行发现相关 Artifact，并读取各自根 `AGENTS.md`。

当前产品范围与设计边界见 [Product Brief](docs/product/product-brief.md)、[本地 Agent 发现与外部证据访问](docs/product/local-agent-discovery-mvp.md)、[外部 Agent Skill 发现与浏览 MVP](docs/product/skill-discovery-mvp.md)、[Skill Symlink 注入 MVP](docs/product/skill-symlink-injection-mvp.md)、[AI Backend MVP](docs/product/ai-backends-mvp.md)、[知识加工验证 MVP](docs/product/knowledge-processing-mvp.md)、[通用管理 Agent MVP](docs/product/chat-agent-mvp.md)、[Artifact Repository MVP](docs/product/artifact-repository-mvp.md)和[知识加工、Projection 与 Artifact](docs/architecture/knowledge-model-and-projection.md)。
