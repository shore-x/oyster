# 本机 Agent 发现与存量数据定位

> 状态：MVP 设计基线
>
> 日期：2026-07-22
>
> 范围：只讨论发现本机 Agent、定位聊天历史/记忆并生成导入预览；不讨论实时插件、知识提取或 MCP 输出。
>
> 上位文档：[Product Brief](../product/product-brief.md)、[整体可行性分析](agent-knowledge-hub-feasibility.md)
>
> 第一阶段的简化数据模型与功能范围见[《本地 Agent 发现与历史同步 MVP》](../product/local-agent-discovery-mvp.md)。本文件中的多 Realm、证据模型和 Connector Manifest 是演进方向，不要求第一版全部落库。

## 1. 结论

这部分具有较高可行性，可以先作为 Oyster 的第一条纵向切片实现。Claude Code、Pi 和 Codex 都把可回填的结构化会话保存在本机；Claude Code 与 Codex 还分别提供独立的自动记忆目录，Pi 则明确提供全局/项目指令文件。现有开源历史查看器已验证，对二十余种 Agent 做只读发现和统一浏览在桌面端是可维护的。

但实现时不能使用单一的 `is_installed` 布尔值，也不能把“某个熟悉的目录存在”直接等同于“可以安全导入”。以下情况都很常见：

- CLI 不在桌面应用继承的 `PATH` 中，但数据目录存在；
- CLI 已卸载，但历史仍值得导入；
- 同名命令不是目标 Agent，例如 `pi` 的名称并不唯一；
- 环境变量或设置把状态目录迁到了默认位置之外；
- 目录存在，但内部格式属于旧版本、另一个工具或已经损坏；
- 会话、自动记忆、项目指令、配置和凭证混在同一状态根目录下，但用途与敏感级别不同；
- 同一 Agent 可能存在 CLI、桌面端、IDE、容器或 WSL 等多个相互独立的数据域。

因此，MVP 应实现一个**基于证据的 Data Source Discovery**：分别报告 Runtime、状态根、数据制品、格式与权限证据，并在用户授权后才读取内容进行格式确认和导入。

## 2. 研究边界与证据等级

本设计优先采用以下证据顺序：

1. 上游官方文档或官方仓库代码；
2. 目标 Agent 当前安装产生的结构，仅用于补充验证；
3. 已运行在真实用户环境中的开源跨 Agent 工具；
4. 文件名、目录名等启发式规则。

路径或字段若没有被上游公开承诺，Connector 必须标记为 `implementation_detail`，并使用格式探针、版本范围和 Fixture 防止静默误解析。

2026-07-22 对当前开发机做过一次只读结构检查：Claude、Pi、Codex 的状态目录都存在，但三个 CLI 均不在当前 shell 的 `PATH` 中。这个样本直接证明了“Runtime 发现”和“Data 发现”必须分离。检查未读取或记录聊天正文。

## 3. 开源项目调研

### 3.1 Agent Sessions

[Agent Sessions](https://github.com/jazzyalex/agent-sessions) 是最接近本问题的参考实现。研究时固定在 commit `0b7a0bc`，重点代码包括 [SessionDiscovery.swift](https://github.com/jazzyalex/agent-sessions/blob/0b7a0bc/AgentSessions/Services/SessionDiscovery.swift)、[PiSessionDiscovery.swift](https://github.com/jazzyalex/agent-sessions/blob/0b7a0bc/AgentSessions/Services/PiSessionDiscovery.swift) 和 [CLIBinaryPresence.swift](https://github.com/jazzyalex/agent-sessions/blob/0b7a0bc/AgentSessions/Shared/CLIBinaryPresence.swift)。

可迁移机制：

- CLI presence 与数据可用性分别判断；
- 用户路径覆盖优先，其次才是环境变量和默认目录；
- 启动期的 presence probe 只检查当前 `PATH` 和常见绝对路径，不启动 login shell、Homebrew 或 npm；
- 真正需要 Resume/执行时，再运行 `command -v`、`--version`、`--help` 做 capability probe；
- Claude 同时考虑自定义配置根和桌面端的独立数据位置；
- Codex 同时枚举活动会话与 `archived_sessions`，按日期目录做快速增量扫描；
- Pi 不只相信 `.jsonl` 扩展名，而是读取有限 header，确认首条对象为带 ID 的 `type: "session"`；
- 使用 `mtime + size` 判断候选变化，处理软链接去重，并在扫描上限触发时显式报告 drift。

### 3.2 AI Chat History Viewer

[AI Chat History Viewer](https://github.com/jhlee0409/claude-code-history-viewer) 在研究时固定于 commit `2e29912`。它为 Claude、Codex、Pi、Cursor、Cline、Continue、Gemini、Copilot、OpenCode、Goose、Aider 等 Agent 提供独立 Provider Scanner。

可迁移机制：

- 每个 Provider 拥有独立的 `detect / scan / load` 实现；
- 多个扫描器通过 blocking pool 并发执行，一个锁住的 SQLite 数据库或损坏来源不会串行拖住其他 Provider；
- Codex 同时支持普通 JSONL 和 Zstd 文件；压缩文件与同名普通文件同时存在时进行去重；
- Pi 从 session header 的 `cwd` 恢复真实项目路径，而不是反解有损的目录名；
- 数据源除了“全局已知根”外，还存在“项目局部 marker”和“编辑器 globalStorage”两种类别；
- SQLite、JSONL、压缩 JSONL 和目录树需要不同枚举/读取策略。

需要调整的地方：该项目用中央 Provider 枚举和大型分发 `switch` 连接所有实现。Oyster 应保留每个来源的隔离，但把声明信息放入版本化 Connector Manifest，避免 UI/Core 继续堆积 Provider 特例。

### 3.3 Vibe Kanban

[Vibe Kanban](https://github.com/BloopAI/vibe-kanban) 在研究时固定于 commit `4deb7ec`。它主要管理 Agent 执行而非导入历史，但其可执行文件解析有参考价值：先查显式路径和当前进程 `PATH`，找不到时再刷新 login-shell `PATH`。

这适合用户主动启动 Agent 的执行路径，不适合 Oyster 启动时的被动发现。login shell、包管理器和版本命令可能慢、阻塞或执行用户 shell 初始化代码；被动发现应保持纯文件系统检查，能力验证应延迟到用户明确操作之后。

### 3.4 上游产品先例

OpenAI 当前已经提供 [Import from another agent](https://learn.chatgpt.com/docs/import) 流程，按用户选择导入指令、设置、技能、插件、项目和最近聊天，且不修改原 Agent。这是产品层面的直接先例，验证了“先发现、展示类别与范围、用户选择、只读导入、导入后复核”的交互模型。

Oyster 不应照搬其“迁移到另一个 Harness”的目标。Oyster 的区别是长期保存跨 Harness 的来源身份、原始证据和增量游标，而不是把数据转换后交给某一个目标 Agent 所有。

## 4. 领域模型：不要问“装没装”

本节是长期概念模型。第一阶段只实现 `AgentSource / HistoryArtifact / SyncRun` 三个持久化对象，避免为尚未支持的多 Realm、多 Profile 和第三方 Connector 提前建模。

发现结果应表达以下对象：

```text
AgentFamily
  id                       # claude-code | pi | codex

AgentInstallation
  installation_id
  agent_family_id
  realm                    # macos-user | app | ide | wsl | container
  runtime_candidates[]     # 可执行文件或 App 证据，可为空
  state_roots[]            # 可能有多个状态根

DataSourceCandidate
  source_id
  installation_id
  kind                     # conversation | memory | instructions | archive
  root / locator
  contract_level           # documented | upstream_source | implementation_detail
  permission_state
  format_probe
  inventory
  evidence[]
  warnings[]

ProbeEvidence
  type                     # env | path | app_bundle | file_signature | user_override
  locator
  observed_at
  strength                 # weak | medium | strong
  detail_without_content
```

UI 可以从证据派生便于理解的状态，但底层不要只保存状态枚举：

| 展示状态 | 含义 |
| --- | --- |
| Runtime only | 找到可执行文件/App，尚未找到数据 |
| Data only | 找到可识别数据，Runtime 可能未安装或不在 PATH |
| Runtime + data | 两类证据都存在 |
| Needs permission | 找到候选位置，但 OS 或 Oyster 尚未获得读取授权 |
| Unsupported format | 路径正确，但 header/版本不受当前 Connector 支持 |
| Unreadable/corrupt | 权限、锁、损坏或 I/O 错误；不能伪装成“未安装” |

这样既能支持卸载后的历史导入，也能避免目录残留造成的“已安装”误报。

## 5. 数据分类

“聊天历史/记忆”必须拆成不同的数据类别，不能共用一个 importer：

| 类别 | 例子 | MVP 处理 |
| --- | --- | --- |
| Conversation | user/assistant 消息、工具调用、分支、compaction | MVP 必须导入 Raw Evidence；后续标准化为 Canonical Activity |
| Human-authored instructions | `CLAUDE.md`、`AGENTS.md`、rules、system prompt files | MVP 必须作为独立 Raw Evidence 导入；标记作用域与来源，不混入聊天时间线 |
| Agent-generated memory | Claude auto memory、Codex local memories | 不导入；它是 Agent 生成的派生结果，既不是原始事实，也无法可靠证明某个历史 turn 实际加载了哪个版本 |
| Prompt/skill/template | Pi prompts、Agent skills | 后续 setup importer；不属于本轮 Conversation MVP |
| Config | settings、模型、Hook/MCP 配置 | 默认只读取定位所需的非秘密字段；不进入知识库 |
| Credentials/secrets | `auth.json`、OAuth、API key、keychain | 永不导入，永不在发现日志中记录内容 |
| Index/cache | SQLite state、session index、UI cache | 只在枚举需要时只读使用，不作为第一份 Raw Evidence |

Conversation 与 Human Instruction 都保持上游原始字节和格式，不在导入时拼接、清洗或重序列化。Importer 允许进行确定性的 metadata/header 解析以建立 catalog，但解析结果必须引用 Raw Evidence，且不能替代原始文件。

自动 memory 明确排除。历史回填时读取到的当前 memory 文件无法证明它在某次模型调用时的内容或加载状态；未来如果实时 Connector 能在 turn 边界捕获精确 context snapshot，则 snapshot 中已经注入的 memory 片段属于该次 context evidence，而不是回头导入一个可变 memory 目录。

## 6. 探测阶段与授权边界

### Phase 0：被动候选发现

在用户未授权读取聊天前，仅允许：

- 读取 Oyster 自己保存的路径覆盖；
- 读取当前进程可见的非秘密环境变量值；
- 检查已知目录、文件或 App bundle 是否存在、类型是否正确；
- 读取目录本身的权限状态和粗粒度 metadata；
- 在当前 `PATH` 与静态常见位置寻找可执行文件，但不执行；
- 展示“发现候选来源，需要授权检查”的结果。

这一阶段不递归枚举会话、不读取 transcript header、不调用包管理器、不启动 login shell，也不读取 `auth.json`。

### Phase 1：用户授权后验证来源

用户选择某 Agent 或手工目录后，Connector 可以：

- 读取设置中用于定位数据根的 allowlisted 字段；
- 解析环境变量、`~` 和绝对路径，并做 canonicalization；
- 有界枚举候选文件的名称、大小、mtime；
- 每种候选格式抽取少量样本，最多读取预设 header budget；
- 只在内存中检查格式签名，不把样本文本写入日志或遥测；
- 返回格式版本、支持状态、数量、时间范围、总大小和风险提示。

格式抽样可能碰到聊天正文，因此必须发生在用户选择来源之后。若第一行就足以确认格式，应立即停止读取。

### Phase 2：确认范围后导入

用户确认项目、时间、会话和数据类别后才读取完整内容。Importer 必须只读上游数据，将原始副本写入 Oyster 自己的存储，不修改、移动、压缩或“修复”上游文件。

## 7. 路径解析规则

所有 Connector 使用相同的优先级：

1. 用户在 Oyster 中保存的显式路径；
2. 上游公开环境变量；
3. 上游 allowlisted 设置字段中的自定义路径；
4. 当前 OS/realm 的官方默认位置；
5. 经 Fixture 验证的兼容位置或社区启发式；
6. 用户手工选择目录。

每一步可以产生多个候选，不应“找到第一个就停止”。同一用户可能有多个 Profile、旧目录或 IDE/桌面端独立存储。候选 canonicalize 后按文件 ID/inode（可用时）和真实路径去重；软链接越出已授权根时必须重新请求授权。

不要递归扫描整个 Home。项目局部来源只能在以下边界中寻找：

- 用户选择的项目目录；
- 已导入 session header 明确声明的 `cwd`；
- 用户配置的代码根；
- 后续接入的 IDE workspace registry。

## 8. 第一批 Connector 规则

### 8.1 Claude Code

官方依据：[Manage sessions](https://code.claude.com/docs/en/sessions)、[Explore the .claude directory](https://code.claude.com/docs/en/claude-directory)、[How Claude remembers your project](https://code.claude.com/docs/en/memory)。

状态根解析：

```text
user override
→ CLAUDE_CONFIG_DIR
→ ~/.claude
→ verified compatibility roots / manually selected roots
```

| 制品 | 默认位置 | 说明 |
| --- | --- | --- |
| 完整会话 | `<claude-root>/projects/<project>/<session-id>.jsonl` | 官方记录位置；项目名由工作目录派生，不能仅凭目录名恢复真实路径 |
| Prompt history | `<claude-root>/history.jsonl` | 适合辅助发现/搜索，不等价于完整 transcript |
| Auto memory | `<claude-root>/projects/<project>/memory/` | 明确排除，不扫描、不导入 |
| 用户指令 | `<claude-root>/CLAUDE.md` | 人工维护的全局指令 |
| 项目指令 | `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/**/*.md` | 只在已知/已授权项目中发现 |

格式探针：

- 会话文件后缀为 `.jsonl`；
- 在有限行数内应出现可识别的 session/message 记录和 session ID；
- unknown record 必须保留，不能因为未识别就丢弃整个文件；
- `memory/` 下的 Markdown 必须排除，不能因为递归扫描指令而进入 Raw Evidence；
- 官方说明 transcript 可能包含工具读取到的凭证，整个来源按高敏数据处理。

兼容注意：社区工具还发现 Claude 桌面端 local-agent-mode 的独立 session root，以及类似 `.claude-*` 的备用配置根。这些只能作为 `implementation_detail` 候选，UI 必须展示实际路径和证据，不得静默合并到默认 Claude 来源。

### 8.2 Pi

官方依据：[Session File Format](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md)、[Pi README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)、[Settings](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md)。

状态根解析：

```text
user override
→ PI_CODING_AGENT_DIR
→ ~/.pi/agent
```

会话根解析：

```text
user override
→ PI_CODING_AGENT_SESSION_DIR
→ global settings.json 的 sessionDir
→ <pi-agent-root>/sessions
```

`--session-dir` 的优先级最高，但它只存在于某次进程参数中，无法通过静态磁盘发现可靠还原；对应目录只能由用户手工添加，或由未来的实时 Extension 主动注册。

| 制品 | 默认位置 | 说明 |
| --- | --- | --- |
| 会话 | `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl` | 官方版本化 JSONL，header 提供准确 `cwd` |
| 全局指令 | `~/.pi/agent/AGENTS.md` | Pi 也会加载目录层级中的 `AGENTS.md` 或 `CLAUDE.md` |
| 全局 System Prompt | `~/.pi/agent/SYSTEM.md`、`APPEND_SYSTEM.md` | 属于指令，不是自动记忆 |
| 项目指令 | 项目祖先/当前目录中的 `AGENTS.md` 或 `CLAUDE.md` | 只在已授权项目内寻找 |

格式探针：

- 首个非空 JSON 对象应为 `type: "session"`，并包含非空 `id`、`cwd` 和可识别 `version`；
- 消息与其他 entry 使用 `id / parentId` 组成树，不能按文件行号强行线性化；
- compaction/branch summary 是 Conversation 内的派生事件，不表示 Pi 拥有单独的自动记忆库；
- 路径编码可能有损，项目身份以 header `cwd` 和后续 Git identity 为准。

Runtime probe 对 `pi` 必须额外谨慎。被动阶段只记录候选路径；用户需要执行/Resume 时，才可用有超时的 `pi --version` 与 `pi --help` 确认其具备 Pi Coding Agent 的 session flags。

### 8.3 Codex

官方依据：[Environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)、[Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)、[Memories](https://learn.chatgpt.com/docs/customization/memories)，以及研究时固定在 commit `9fc715c` 的 [rollout constants](https://github.com/openai/codex/blob/9fc715c/codex-rs/rollout/src/lib.rs) 与 [session layout implementation](https://github.com/openai/codex/blob/9fc715c/codex-rs/rollout/src/list.rs)。

状态根解析：

```text
user override
→ CODEX_HOME（目录必须已存在）
→ ~/.codex
```

| 制品 | 默认位置 | 说明 |
| --- | --- | --- |
| Resume-grade session | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` | 官方说明 `CODEX_HOME` 包含 sessions；具体布局来自上游源码和当前实现 |
| Archived session | `$CODEX_HOME/archived_sessions/` | 上游源码/当前实现细节，需独立枚举 |
| History log | `$CODEX_HOME/history.jsonl` | 官方配置 `history.persistence` 控制；与 resume-grade rollout 分开探测和导入 |
| Local memories | `$CODEX_HOME/memories/` | 明确排除，不扫描、不导入 |
| 用户/项目指令 | `AGENTS.md` 与项目层级 `.codex/` 规则 | 人工维护的指导，不是聊天历史 |

格式探针：

- session 文件通常为 `rollout-*.jsonl`，归档也要扫描；
- 首个有效记录应包含 `session_meta` 和稳定 thread/session identity；
- 记录是事件流，至少要容纳 `event_msg`、`response_item`、工具/函数调用与结果，不能只抽 user/assistant 文本；
- 普通与压缩副本并存时按同一逻辑 session 去重，优先可直接读取的源；
- 单个坏行不应使整个 Provider 不可用，关键 metadata 损坏时则标为 partial/corrupt；
- `state_*.sqlite`、`session_index.jsonl` 可辅助枚举，但 rollout 是 MVP 的首选 Raw Evidence；
- `auth.json`、keychain、访问令牌始终排除。

需要在 Manifest 中明确：`CODEX_HOME` 是公开配置边界，`memories/` 是显式 excluded locator；rollout 的具体文件名和事件 Schema 仍可能演进，必须由 Connector 版本和 Fixture 管理。

## 9. Runtime 发现

Runtime 发现不是历史导入的前置条件，但可以帮助用户确认来源、显示版本，并在未来支持 Resume/执行。

被动候选顺序：

1. Oyster 用户指定的绝对路径；
2. 当前进程 `PATH` 中的普通文件；
3. macOS 常见用户级位置，如 `~/.local/bin`、包管理器常见 bin；
4. `/opt/homebrew/bin`、`/usr/local/bin` 等系统常见位置；
5. 已知 App bundle/IDE extension 的声明信息；
6. 项目本地 `node_modules/.bin`，仅在用户已授权的项目中。

被动检查必须确认：目标是普通文件或允许的软链接、具有可执行权限、canonical path 不越出允许边界。它不运行文件。

主动 capability probe 只在用户要求验证或执行时发生：

- 每条命令有严格超时、输出大小上限和环境变量 allowlist；
- 使用 argv，不经 shell 拼接；
- 先 `--version`，必要时再 `--help`；
- 不运行 `brew --prefix`、`npm root -g` 等慢且有副作用风险的命令作为启动依赖；
- probe 失败只降低 Runtime 证据，不影响已经确认的数据来源。

## 10. Discovery 与预览流程

```text
load connector manifests
        │
        v
passive path/app/runtime checks ──> candidate sources (no transcript reads)
        │
        v
user selects agent/root and grants read permission
        │
        v
resolve custom roots + canonicalize + dedupe
        │
        v
bounded inventory + sampled format probes (per connector, isolated)
        │
        v
import preview + warnings + unsupported/corrupt report
        │
        v
user confirms category/project/time/session scope
        │
        v
read-only import into Oyster-owned Raw Evidence
```

每个 Provider probe 在独立任务中运行，设置时间、文件数、目录深度、单文件 header 和总 I/O budget。结果聚合时保留每个来源的 error；一个 SQLite lock、权限错误或大目录不能阻塞其他来源。

预览至少展示：

```text
agent / realm / source kind
resolved root and why it was selected
contract level and detected format/version
permission state
session/instruction/file count and total bytes
oldest/newest timestamps when derivable
project count and unresolved project count
supported / partial / corrupt / unknown counts
conversation and human instruction items as separate categories
excluded sensitive paths
warnings and estimated import cost/time
```

## 11. Connector Manifest 与 Probe 接口

Manifest 声明静态能力与权限，代码负责路径解析和格式验证。示意：

```yaml
id: codex
version: 1
supported_os: [macos]
runtime:
  command_names: [codex]
  common_paths:
    - ~/.local/bin/codex
    - /opt/homebrew/bin/codex
    - /usr/local/bin/codex
state_roots:
  env: [CODEX_HOME]
  defaults: [~/.codex]
artifacts:
  - kind: conversation
    locator: sessions
    contract_level: upstream_source
  - kind: archive
    locator: archived_sessions
    contract_level: upstream_source
  - kind: human_instruction
    locator: AGENTS.md
    contract_level: documented
excluded:
  - auth.json
  - memories/**
permissions:
  discovery: metadata
  probe: bounded_read
  import: read
```

建议接口：

```text
passive_discover(context) -> Candidate[]
resolve(candidate, granted_scope) -> ResolvedSource[]
probe(source, budget) -> ProbeResult
inventory(source, budget) -> InventoryPage + cursor
preview(selection) -> ImportPreview
```

`probe` 不返回样本文本，只返回签名、版本、状态和脱敏错误；`inventory` 必须分页，不能要求一次把所有路径加载到内存。

## 12. 安全与可靠性要求

- 上游目录始终只读；Oyster 不修复、不归档、不重命名来源文件；
- 路径必须 canonicalize，并防止 `..`、软链接越界和替换竞态；
- 日志只记录 source ID、相对 locator、状态、计数和错误码，不记录消息正文；
- 完整绝对路径只保存在本地受控 catalog/UI，外发诊断默认脱敏用户名；
- 读取 SQLite 时使用只读模式；锁或 Schema 漂移只影响该来源；必要时在授权后创建 Oyster 自己的只读快照；
- 处理追加中的 JSONL 时允许损坏尾行，下次增量扫描重试；中间坏行保留 Raw Evidence 并报告 partial；
- 使用 path/file identity、size、mtime、可选 head/tail hash 建立增量 fingerprint；mtime 不是唯一身份；
- 扫描达到 budget 时返回 `truncated/drift_detected`，不能把部分结果显示成完整结果；
- 手工添加目录必须经过目标 Connector 的 signature probe，不能让用户选择任意目录后自动当成聊天导入；
- 发现结果和导入授权分开保存；“曾发现”不等于“持续授权读取”。

## 13. Borrow / Adapt / Reject

### Borrow

- Agent Sessions 的多信号证据、路径覆盖、data/runtime 分离、有限 header sniff、快速/完整扫描分层和 symlink 去重；
- AI Chat History Viewer 的每 Provider 隔离、并发扫描、SQLite 错误隔离、压缩副本去重；
- Pi 的版本化 header 与树形 session；
- OpenAI Import 的“分类预览—用户选择—不修改来源—导入后复核”流程。

### Adapt

- 把 Provider 特例封装成 Manifest + Connector，不把 path table 和中央 `switch` 扩散到 UI/Core；
- 启动时只做纯文件系统 presence，login shell/`--help` 延迟为主动 capability probe；
- content sniff 从自动启动扫描改为用户选中来源后的有界验证，以满足 Oyster 的隐私底线；
- 用证据列表和 contract level 替代单一 available/installed；
- 将 instructions 和 conversation 分开导入并保留各自 provenance；把 Agent 自动 memory 作为显式排除项。

### Reject

- 只调用 `which` 判断 Agent 是否存在；
- 目录存在就宣称格式受支持；
- 启动时递归扫描整个 Home 或所有代码目录；
- 默认执行 login shell、包管理器或未知同名命令；
- 为统一展示而线性化 Pi 分支或丢弃工具事件；
- 读取/复制认证文件；
- 一个 Provider 失败就中止全部发现；
- 在用户授权前读取 transcript 正文；
- 把上游路径或私有 JSON 字段当作永久协议。

## 14. MVP 实施顺序

本节描述完整 Discovery 子系统的演进顺序。可交付的第一阶段以[简化 MVP 规格](../product/local-agent-discovery-mvp.md)为准：先打通扫描、基础统计、Raw Evidence 同步和进度展示，再引入 Capability Manifest 与更复杂的证据模型。

### P0：Discovery Core

- `AgentFamily / AgentInstallation / DataSourceCandidate / ProbeEvidence` 数据模型；
- Connector registry 与版本化 Manifest；
- macOS path/env/app/runtime passive probe；
- 授权状态、路径 canonicalization、budget 和隔离执行器；
- 手工添加来源和用户路径覆盖；
- Discovery/Preview UI，不读取完整聊天。

### P1：三个第一方 Probe

- Claude：config root、projects transcript、human instructions，并显式排除 auto memory；
- Pi：agent root、session override、versioned JSONL header、instructions；
- Codex：`CODEX_HOME`、active/archive rollouts、human instructions，并显式排除 `memories/`；
- 每个 Connector 提供正常、旧版本、空目录、错误目录、权限拒绝、损坏 header、损坏尾行、大目录 Fixture。

### P2：Inventory 与导入预览

- 分页枚举与取消；
- session/project/time/size 统计；
- partial/unknown/corrupt 报告；
- 来源与类别选择；
- 保存导入计划，交给后续 History Importer。

## 15. 验收标准

发现正确性：

- CLI 不在 `PATH` 但历史存在时，显示 `Data only`，仍可进入预览；
- CLI 存在但没有历史时，显示 `Runtime only`；
- 默认目录与环境变量目录同时存在时，两者都列出并解释优先级，不静默丢弃；
- 同一目录经软链接或重复规则命中时只显示一个 source；
- 同名非目标 `pi` 不会因被动发现而被执行或认成可用 Runtime；
- 格式不匹配、权限拒绝和损坏分别展示，不合并成 Not found。

隐私与安全：

- 用户授权前没有 transcript 文件内容读取；
- `auth.json`、keychain、API key 不进入 candidate、日志、Fixture snapshot 或导入计划；
- probe 日志中不存在聊天正文和用户名绝对路径；
- 软链接越出授权根时停止并请求新的权限。

规模与恢复：

- 10 万个候选文件时发现可分页、可取消，不要求全部驻留内存；
- 一个锁住的 SQLite、超大 JSONL 或损坏 Provider 不阻塞其他 Provider；
- budget 截断被明确标记；
- 第二次扫描只重新探测新增或 fingerprint 变化的来源；
- 上游格式变化时返回 unknown/unsupported，而不是生成错误的“空会话”。

## 16. 可行性判断与后续决策

| 子问题 | 判断 | 原因 |
| --- | --- | --- |
| 发现默认位置中的三种 Agent 数据 | 高 | 官方路径明确，当前本地样本和多个开源项目已验证 |
| 发现所有自定义目录 | 中高 | 环境变量和持久设置可覆盖大部分；一次性 CLI 参数只能靠手工或未来插件注册 |
| 准确判断 Agent 可执行能力 | 中高 | 主动 `--version/--help` 可确认；桌面 PATH、同名命令和 App/IDE realm 增加复杂度 |
| 在不读正文时确认格式 | 中 | 只能确认候选路径；可靠签名需要用户授权后的有限 header read |
| 保真导入会话与人类指令 | 高 | 两类都是确定性的文件证据；保持异构原始格式并在后续分层处理 |
| 长期覆盖二十余种 Agent | 中高 | prior art 已证明可做；维护成本取决于 Connector 隔离、Fixture 和版本治理 |

建议下一步继续完善 **P0 Discovery Core + 三个 Connector 的 passive probe/probe/inventory**，产出真实的 Import Preview JSON 和 UI。预览必须稳定区分 Conversation、Human Instruction、Excluded Agent Memory、Config 和 Credentials，再开始完整 transcript Parser。这样最早验证的是 Oyster 的长期接入边界，而不是某一个 JSONL 格式的临时解析器。

## 17. 已落地的 MVP 架构

2026-07-22 已完成 Conversation + Human Instruction 来源的第一条可运行纵向切片。实现采用以下边界：

```text
Solid Renderer
  → typed contextBridge API
  → Electron IPC handlers
  → DiscoveryService
      → AgentHistoryAdapter registry
      → DiscoveryRepository
      → RawEvidenceStore
```

`DiscoveryService` 不依赖 Electron；Adapter 只负责路径定位、有限 header 验证和 artifact candidate 生成；统一 Service 负责统计、fingerprint、任务、取消、失败隔离和同步覆盖率。Renderer 不包含路径规则，也不把页面状态当作业务真相。

Bootstrap 阶段使用原子替换的 JSON repository 保存 `AgentSource / HistoryArtifact / SyncRun`，并兼容迁移旧的 `sessions` 集合。Raw Evidence 使用独立目录保存不可变 payload 与 manifest：payload 保持源文件扩展名和字节，manifest 记录 artifact kind、原始定位、fingerprint、SHA-256、大小和导入时间。后续切换 SQLite 和 content-addressed blob storage 时无需改变 UI/Adapter 契约。

当前实现覆盖 Conversation JSONL 与 Human Instruction Markdown。发现动作不会读取 transcript；用户点击扫描后才读取有限 header，并从 session header 的项目路径和各 Agent 的官方层级规则定位指令。点击导入后才完整复制文件。Claude/Codex 自动 memory、Config 和 Credentials 不进入扫描模式；测试明确验证 `memory/`、`memories/` 不会混入 Raw Evidence。
