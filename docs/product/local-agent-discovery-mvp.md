# 本地 Agent 发现与历史同步 MVP

> 状态：第一阶段产品与实现规格
>
> 日期：2026-07-22
>
> 目标：发现本机 Claude Code、Pi、Codex，统计可导入历史，并把用户选择的历史同步到 Oyster Raw Evidence。暂不构建知识、不做实时监听。
>
> 详细路径与长期架构见[《本机 Agent 发现与存量数据定位》](../architecture/agent-discovery-and-history-import.md)。

## 1. MVP 最终应让用户完成什么

用户打开 Oyster 后，可以看到本机是否存在 Claude Code、Pi、Codex 的历史数据。对每个已发现来源，Oyster 展示：

- 数据目录；
- 历史文件总数和可识别 session 数；
- 历史文件总大小；
- 最早和最近 session 时间；
- 已同步、待同步和失败的 session 数；
- 已同步字节数和当前同步进度；
- 最近扫描、最近同步时间和错误信息。

用户可以选择一个来源，授权扫描，查看统计，然后开始同步。同步被取消、应用退出或部分失败后，再次执行不会重复导入已经同步且未变化的 session。

这个阶段的“同步完成”仅表示：上游历史已经只读导入 Oyster Raw Evidence，并建立最小 session catalog。标准化消息、知识提取、Embedding 和 MCP 不计入该进度。

## 2. 必须实现的最小功能

### 2.1 发现三个 Agent 来源

首版只支持 macOS 当前用户下的三个内置 Adapter：

| Agent | 默认历史根 | 首版覆盖 |
| --- | --- | --- |
| Claude Code | `($CLAUDE_CONFIG_DIR 或 ~/.claude)/projects` | 项目 transcript JSONL |
| Pi | `PI_CODING_AGENT_SESSION_DIR`、全局设置 `sessionDir` 或 `~/.pi/agent/sessions` | 版本化 session JSONL |
| Codex | `CODEX_HOME` 或 `~/.codex` | `sessions` 和 `archived_sessions` rollout |

发现数据目录比找到 CLI 更重要。CLI 不在 `PATH`、Agent 已卸载或只通过桌面应用使用时，只要历史数据存在，仍应允许扫描和同步。

每个 Agent 首版只保留一个用户选定的逻辑来源。Codex 的 active/archive 目录作为同一个来源的两个子目录，不拆成两个来源。用户可以手工修改数据根；多 Profile、多用户、WSL、容器和远程主机以后再支持。

### 2.2 扫描并统计历史

用户授权后，Adapter 递归枚举已知文件模式，读取文件 metadata 和最小必要 header，产出以下统计：

```text
file_count
session_count
total_bytes
oldest_session_at
latest_session_at
invalid_file_count
```

定义：

- `file_count`：符合该 Adapter 文件名/扩展名规则的候选历史文件数量；
- `session_count`：header 验证通过并按 `session_key` 去重后的会话数量；
- `total_bytes`：去重后、header 验证通过的 session 文件当前 `size` 之和；invalid 和重复副本不进入同步分母；
- `oldest/latest_session_at`：优先来自 session header，缺失时使用文件 mtime；
- `invalid_file_count`：扩展名符合但 header 无法识别的文件数量。

损坏尾行不影响 session 被统计；无法识别关键 header 的文件进入 invalid 计数，不中止整个来源扫描。Memory、Instructions、Config 和凭证不计入这一版的历史统计。

### 2.3 展示来源卡片

每个 Agent 一张卡片，最小展示：

```text
Claude Code                           History found
~/.claude/projects
1,248 sessions · 1,263 files · 3.6 GB
2025-02-03 — 2026-07-22
Synced 930 / 1,248 · 2.8 / 3.6 GB · 77%
Last scan: 2 minutes ago       [Rescan] [Sync] [Change path]
```

扫描过程中总量未知，使用不确定进度：

```text
Scanning… 607 sessions found · 1.4 GB
```

不要在扫描尚未完成时显示百分比。只有扫描完成、同步任务获得固定快照后才显示确定百分比。

### 2.4 同步 Raw Evidence

同步流程只做四件事：

1. 为当前扫描快照创建 Sync Run；
2. 逐个读取 pending/changed session；
3. 保存原始内容、来源定位和最小 session metadata；
4. 每个 session 成功提交后更新游标和任务计数。

同一时刻只允许一个来源执行一个同步任务。首版不需要并行导入、暂停、优先级和后台调度；需要支持取消。取消或崩溃后，已经成功提交的 session 保持 synced，其余 session 下次继续。

### 2.5 展示同步进度

同步 UI 至少显示：

```text
processed_files / total_files
processed_bytes / total_bytes
synced_sessions
failed_sessions
current_relative_path（可选，默认只显示文件名）
started_at
```

主百分比按字节计算：

```text
progress = processed_bytes / total_bytes
```

文件处理成功、失败或被跳过后都计入 `processed_files/processed_bytes`，否则一个失败文件会让进度永久无法到达 100%。完成状态同时展示结果，例如“1,243 已同步，5 失败”，而不是用 100% 隐藏失败。

### 2.6 重新扫描与增量判断

首版使用以下 fingerprint 判断 session 是否变化：

```text
session_key + size_bytes + modified_at
```

- 新 session：`pending`；
- fingerprint 未变化：保持 `synced`，不同步；
- 已同步 session 的 size/mtime 变化：重新标记为 `pending`；
- 上游文件暂时消失：标记 `missing`，不立即删除 Oyster 中已导入的数据；
- 用户明确删除数据属于后续删除流程，不由扫描自动完成。

内容 hash、inode/file ID、tail hash 和 byte-offset 增量属于后续优化。首版允许变化后的文件整 session 重新导入，通过 `session_key` 写入新的 Raw 版本并让 catalog 指向新版本，不覆写原始证据，避免实现复杂的文件追加恢复。

### 2.7 基础错误与重试

最小错误分类：

```text
permission_denied
path_not_found
unsupported_format
read_failed
import_failed
cancelled
```

来源级错误显示在 Agent 卡片上，session 级错误计入 failed 并保留一条脱敏错误信息。用户可以重新扫描或重试失败项。一个坏 session 不得中止剩余 session。

## 3. 简化数据模型

首版只需要三个持久化对象。长期架构中的 Installation、Realm、Probe Evidence、Capability Manifest 不直接落入第一版数据库。

### 3.1 AgentSource

每种 Agent 最多一条启用记录。

```text
id                    UUID
agent_type            claude | pi | codex
data_root             absolute path
executable_path       nullable absolute path
discovery_state       not_found | found | needs_permission | error
scan_state            not_scanned | scanning | ready | error
sync_state            not_started | syncing | partial | synced | error

file_count            integer
session_count         integer
total_bytes           integer
invalid_file_count    integer
oldest_session_at     nullable timestamp
latest_session_at     nullable timestamp

synced_session_count  integer
failed_session_count  integer
synced_bytes          integer

last_scanned_at       nullable timestamp
last_synced_at        nullable timestamp
last_error_code       nullable string
last_error_message    nullable string
created_at
updated_at
```

约束：

- `UNIQUE(agent_type)`；
- 所有统计字段默认 `0`；
- 百分比不落库，由 `synced_bytes / total_bytes` 派生；
- `synced_bytes` 是当前 fingerprint 仍为 synced 的 HistorySession 大小之和；文件变化并重新变为 pending 时需要从聚合值中移除；
- `sync_state=synced` 仅表示当前扫描快照没有 pending/failed，存在失败或待同步项时为 `partial`；
- 状态字段用于快速恢复 UI，真实计数可从 HistorySession/SyncRun 重建。

### 3.2 HistorySession

在目标三个 Agent 中，一个主要历史文件对应一个 session，首版据此建模。

```text
id                    UUID
source_id             AgentSource.id
session_key           provider session id；缺失时为稳定 path key
relative_path         不保存为 UI/日志外发的绝对路径
size_bytes            integer
modified_at           timestamp
session_at            nullable timestamp
project_hint          nullable string
fingerprint           size + modified_at 的序列化值
sync_state            pending | syncing | synced | failed | missing
raw_evidence_id       nullable UUID
last_error_code       nullable string
last_error_message    nullable string
synced_at             nullable timestamp
created_at
updated_at
```

约束：

- `UNIQUE(source_id, session_key)`；
- `session_key` 优先使用上游 header 的 session/thread ID；
- active/archive 中出现同一 Codex thread 时更新 `relative_path`，不新增 session；
- project 解析只保存一个可选 hint，不在本阶段解决跨 worktree/clone 的项目身份。

### 3.3 SyncRun

同时记录扫描和同步任务，供重启恢复与 UI 展示。

```text
id                    UUID
source_id             AgentSource.id
kind                  scan | sync
state                 queued | running | completed | partial | failed | cancelled | interrupted

total_files           integer
processed_files       integer
total_bytes           integer
processed_bytes       integer
synced_sessions       integer
failed_sessions       integer
current_relative_path nullable string

started_at            nullable timestamp
updated_at             timestamp
finished_at           nullable timestamp
error_code            nullable string
error_message         nullable string
```

规则：

- scan run 的 `total_*` 在枚举完成前可以为 `0`，UI 使用不确定进度；
- sync run 创建时冻结 `total_files/total_bytes`，之后用于稳定计算进度；
- SyncRun 的 `processed_bytes` 表示本次任务已经处理的工作量，AgentSource 的 `synced_bytes` 表示整个来源当前已经同步的覆盖量，两者不能混用；
- 应用启动时将遗留的 `running` 改为 `interrupted`；
- AgentSource 上的聚合计数在每个 session 提交后更新，避免进程崩溃时丢失全部进度。

## 4. 最小 Adapter 接口

首版不需要通用第三方插件协议，只在进程内注册三个内置 Adapter，并保持以下小接口：

```text
detect() -> DetectedPath?
scan(data_root) -> stream<SessionCandidate>
import(session_candidate) -> RawSession
```

`SessionCandidate` 只需要：

```text
session_key
relative_path
size_bytes
modified_at
session_at?
project_hint?
```

Adapter 负责文件模式和 header 差异；统计、任务、进度、错误、持久化和 UI 全部由统一的 Discovery/Sync Service 负责。这样不会为三个 Adapter 复制同步逻辑，未来也能把同一接口移入独立 Connector Host。

## 5. 最小产品流程

```text
应用启动
  → 检查三个默认/环境变量路径是否存在
  → 显示 Found / Not found / Needs permission

用户点击 Scan
  → 获取目录权限
  → 创建 scan run
  → 持续更新“已发现数量/大小”
  → 保存 HistorySession index 和 AgentSource 汇总
  → 显示可同步范围

用户点击 Sync
  → 对 pending/failed session 创建固定快照
  → 创建 sync run
  → 逐 session 导入 Raw Evidence 并更新进度
  → 显示 Synced / Partial / Error
```

手工路径入口只需要一个目录选择器；选择后必须经过对应 Adapter 的 header 验证。首版不需要让用户组合多个根或编辑高级规则。

## 6. 明确不做

这一阶段不实现：

- Claude/Codex 自动记忆和 `AGENTS.md`/`CLAUDE.md` 导入；
- 通用 Connector Manifest 或第三方插件加载；
- 实时文件监听、Hook 或 Agent Extension；
- WSL、容器、远程主机、多用户和多 Profile；
- 包管理器检测和自动安装 Agent；
- 消息级、turn 级或 byte-offset 级增量同步；
- 内容 hash、跨路径文件身份和复杂归档迁移；
- 项目身份合并、知识提取、Embedding 和 MCP；
- 多任务并行、暂停、优先级和带宽控制；
- 自动删除上游已消失的 session。

这些能力不会被数据模型永久阻断：`agent_type`、`session_key`、`raw_evidence_id` 和独立 SyncRun 已经留下扩展点。

## 7. 验收标准

功能：

- 能发现当前用户默认目录下的 Claude Code、Pi、Codex 历史；
- CLI 不存在但数据存在时仍可扫描；
- 扫描完成后，文件数、去重 session 数、总大小和时间范围正确；
- 同步期间展示文件、字节、session 成功/失败和百分比；
- 取消或重启后，已同步 session 不重复导入；
- 新增或变化的文件在重新扫描后变为 pending；
- 一个损坏文件只增加 invalid/failed，不阻塞其他文件；
- 用户修改路径后可以重新扫描，旧数据不会被自动删除。

安全：

- 未授权前不读取 transcript header 或正文；
- 上游目录始终只读；
- `auth.json`、Keychain、API key、settings 全文不进入 Raw Evidence；
- 日志不包含聊天正文，错误信息默认使用相对路径；
- 手工选择的错误目录不会被当成有效 Agent 历史。

性能目标先保持朴素：扫描 10,000 个 session 时 UI 不冻结、进度持续更新、任务可取消。更大规模的分页和索引优化根据真实用户数据再决定。

## 8. 建议实施顺序

1. SQLite migration：`agent_sources`、`history_sessions`、`sync_runs`；
2. 统一 Discovery/Sync Service 与任务状态恢复；
3. Claude Adapter 和来源卡片，打通第一条扫描—统计—同步纵向链路；
4. Pi Adapter；
5. Codex active/archive Adapter 与 thread 去重；
6. 取消、失败重试、应用重启恢复；
7. 使用脱敏 Fixture 验证统计、幂等和进度。

先用 Claude 完成整条闭环，再增加 Pi/Codex，比先写三个 Scanner、最后才补进度和持久化更容易验证真实产品体验。

## 9. 当前实现状态（2026-07-22）

第一条纵向切片已经落地，入口为 Electron 的“Agent 数据来源”页面：

- 已实现 Claude Code、Pi、Codex 的内置 Adapter；
- 用户点击“探测本机 Agent”后，会自动扫描所有已发现来源并刷新文件、会话和字节统计；来源卡片仍可单独重新扫描；
- 被动探测只做目录/权限/可执行文件检查，不执行 Agent、login shell 或包管理器；
- 扫描由用户按钮触发，递归读取 JSONL metadata 与最多 96 KB 的 header；
- 已实现来源统计、Codex active/archive 去重、增量 fingerprint、missing 标记；
- 已实现 Raw Evidence 只读复制、任务进度、取消、逐 session 失败隔离和未完成任务恢复；
- 已实现目录选择、重新扫描、增量导入及三类错误/空态 UI；
- Renderer 只依赖 preload 暴露的 typed API，不直接访问 Node、文件系统或持久化实现；
- 已用脱敏 Fixture 覆盖三个 Adapter，并有 Service 幂等测试和 Electron 截图烟雾测试。

当前持久化先使用原子写入的 JSON state repository，而不是 SQLite。它位于独立的 `DiscoveryRepository` 边界之后，不影响 Scanner、Importer 或 UI；这是为了先验证真实数据规模和状态变化，再决定 SQLite schema 与 migration。Raw Evidence 已单独按来源/session 写入不可变版本。

尚未进入本切片：SQLite、压缩 Codex rollout、十万文件分页/worker 隔离、memory/instructions、实时 Connector、知识提取和搜索服务。
