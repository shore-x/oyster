# 本地 Agent 发现与外部证据访问

> 状态：当前已落地的第一阶段产品与实现规格
>
> 日期：2026-08-09
>
> 范围：发现本机 Claude Code、Pi、Codex，登记 Source Conversation transcript 与人类指令，并由 Source Adapter 在需要时从原始位置只读访问。Canonical Activity、知识加工、实时 Connector 和 MCP 不属于本页所述的发现切片。

## 1. 结论

本地 Agent 历史是 Oyster 可以引用的外部观察，不是必须复制到 Oyster 内部的数据资产。发现阶段只建立轻量 catalog；当用户选择某条记录进行查看或知识加工时，主进程才通过对应 Source Adapter 从原始位置读取它。Source Conversation 身份与文件位置是两个不同概念：身份用于持续识别同一条逻辑对话，位置只是可失效、可重新发现的访问线索。

Discovery catalog 中的单个外部来源条目称为 **Source Record**。它负责标识和定位来源记录，不是 Artifact Domain 中由用户与 Agent 维护的 Artifact。

因此，当前只有一条历史访问路径：

```text
发现来源 -> 扫描并登记外部记录 -> 选择一条记录
         -> Source Adapter 定位并校验所选版本 -> 原地读取 -> 后续消费
```

正式知识加工与测试使用同一观察读取路径，发现层不为测试建立另一套来源副本。用户接受精确 `sourceRevision` 后形成 Source Snapshot，知识加工 Core 会在 `tasks/<taskId>/` 中物化该 Task 所需的固定输入视图；这属于 Task workspace，不属于 Discovery catalog 或 Source Adapter 的存储职责。后续如何持久化知识或隔离测试写入，不由发现层定义。

## 2. 当前能力

“Agent 数据来源”页面支持：

- 探测 Claude Code、Pi、Codex 的默认目录、环境变量目录和 CLI 路径；
- 手工选择自定义历史根目录；
- 在用户触发扫描后，有界读取 JSONL header，统计文件、Source Conversation、人类指令、字节数、时间范围和异常文件；
- Source Conversation 列表使用标题、项目、时间和原始记录大小帮助识别，不为展示消息条数额外读取正文；只有消费所选 Source Snapshot 时才从原始位置读取正文；
- Source Conversation 选择器可以显式刷新所有已配置的本机来源；刷新状态和可选列表由同一个 catalog snapshot 表达；
- 按三个 Agent 各自规则发现人类编写的指令，并明确排除 Agent 自动 memory；
- 为外部记录登记稳定身份、来源定位信息和轻量版本指纹，不复制聊天正文；
- 对 Codex `sessions` / `archived_sessions` 中的同一 thread 去重；
- 由主进程按需读取用户选中的单条 Source Conversation，并在接受 Source Snapshot 前校验它仍是所选版本。

发现完成只表示系统已经建立可选择的外部记录 catalog，不表示 Oyster 已经保存原始文件、生成 Canonical Activity 或知识。

## 3. 支持范围

| Agent | 历史根 | 当前可发现的外部证据 |
| --- | --- | --- |
| Claude Code | `($CLAUDE_CONFIG_DIR 或 ~/.claude)/projects` | transcript JSONL；用户/项目 `CLAUDE.md`、`CLAUDE.local.md` 和 `.claude/rules/**/*.md` |
| Pi | `PI_CODING_AGENT_SESSION_DIR`、全局 `sessionDir` 或 `~/.pi/agent/sessions` | session JSONL；`AGENTS.md`、`CLAUDE.md`、`SYSTEM.md`、`APPEND_SYSTEM.md` |
| Codex | `CODEX_HOME` 或 `~/.codex` | `sessions` 与 `archived_sessions` rollout；按官方优先级选择的 `AGENTS.override.md`、`AGENTS.md` 或 fallback 指令 |

发现数据目录和发现可执行程序是两个不同结论。即使 CLI 不在 `PATH`，只要历史数据仍可访问，用户就可以扫描并选择其中的记录。

当前每种 Agent 只维护一个逻辑来源；多 Profile、多用户、WSL、容器和远程主机尚未支持。

## 4. 发现与读取生命周期

### 4.1 探测

被动探测只检查候选路径、目录权限和可执行文件位置，不运行 Agent、login shell 或包管理器，也不读取 transcript 正文。

### 4.2 扫描与登记

扫描由用户触发。Adapter 递归枚举允许的文件模式，读取 metadata 和最多 96 KB 的必要 header，产生 conversation、human instruction 或 invalid 结果。

损坏尾行不会使整个来源失败；无法识别关键 header 的文件计入 invalid，一个坏文件不阻塞其他文件。指令发现只使用允许的文件名、transcript header 中的项目路径和少量受信配置，不递归搜索整个 Home。

catalog 保存稳定的 Source Record 身份、来源定位信息、文件大小和修改时间等轻量版本指纹。重新扫描在来源内构建完整结果后原子替换当前 catalog：记录变化时形成新的当前版本，已经消失的记录不再出现在可选列表中；扫描失败不会发布半完成列表。扫描能力属于各 Agent Adapter，因为只有 Adapter 理解对应 Harness 的身份与保存位置规则。扫描不会复制文件，也不会静默改变已经完成的加工所依据的 Observation revision。

### 4.3 按需读取

Renderer 只提交 catalog 中的稳定身份和用户所选择的版本标识，不提交绝对文件路径。主进程通过对应 Source Adapter 解析内部 locator，只读取被选择的记录，并确认它没有静默变化。成功读取后，系统才计算内容哈希，固定本次加工所依据的确定版本。

打开或切换 Source Conversation 不触发全量重新扫描。用户可以在选择器中显式刷新 Source Conversation catalog；该操作由 Discovery Service 重新探测并扫描所有已配置来源，等待扫描完成后发布一个完整 snapshot，Renderer 不编排逐来源扫描。当已登记的 locator 无法读取或版本不一致时，Discovery Service 仍只要求对应 Adapter 按稳定身份重新发现该 Source Conversation，并同步刷新 catalog：

- 如果只是保存位置迁移而版本未变，继续读取同一条证据；
- 如果 Source Conversation 比所选版本增长或发生其他内容变化，保留新的 catalog 版本，但拒绝用它替换用户已经选择的 Source Snapshot；
- 如果无法重新发现，视为来源已失效，并从当前可选 catalog 中移除。

这是读取失败后的单次恢复，不要求每次选择都重新扫描，也不要求统一服务理解 Codex、Claude Code 或 Pi 的目录结构。Renderer 保存稳定身份与精确 revision 的选择；catalog 刷新后仅在两者都未变化时保留选择，版本变化或记录消失都要求用户重新确认。单次处理的内容上限由消费方决定；发现层不为绕过该限制而预先加载全部历史。

## 5. 数据与安全边界

当前持久化内容是轻量 catalog，而不是聊天正文：

- 来源的发现、扫描和聚合状态；
- conversation 或 human instruction 的稳定身份、内部 locator 和版本指纹；
- 必要的脱敏错误与运行状态。

Source Adapter 负责各 Harness 的默认路径、有限 header 解析、Source Record 定位、版本检查和原地读取。统一 Discovery Service 负责 catalog、统计、状态和访问协调。Renderer 只通过 typed preload API 使用这些能力，不包含路径规则，也不获得原始绝对路径。Source Conversation 消费使用独立的 `get / refresh / subscribe` catalog 契约；来源管理 snapshot 不再通过版本号和第二次列表请求间接驱动选择器。

Raw Evidence 表示具有明确来源身份和版本身份、可由 Source Adapter 按需读取的上游材料。它保持上游格式，不在发现时统一 Schema，也不把人类指令拼入 transcript；它不是 Oyster 内部的文件副本。异构记录的确定性标准化将在 Canonical Activity 阶段完成。

上游目录始终只读。日志只记录 ID、状态、计数和脱敏错误，不记录聊天正文。项目指令的绝对源路径只保留在受信主进程的本地 catalog，不进入 Renderer、模型输入或遥测。

当前明确排除：

- Claude/Codex 等 Agent 自动生成的 memory；
- settings、凭证、API key 和 Keychain 内容；
- Skill、Prompt Template 和其他尚未纳入历史 `SourceRecord` 契约的文件；外部 Skill 由独立的[《外部 Agent Skill 发现与浏览 MVP》](skill-discovery-mvp.md)处理，不计入本页的 Source Conversation 或人类指令 catalog；
- 扫描时看到的“当前指令”作为某个历史 turn 的精确 context。

## 6. 可用性与出处

外部 Agent 拥有原始记录的生命周期。它可以修改、移动或删除记录，用户也可以撤回 Oyster 的读取权限。Oyster 不承诺外部 Raw Evidence 永久可展开，已创建 Task 中的固定输入副本也不能被当作新 Task 的可用来源。

当前知识加工验证会记录所使用的来源和版本，外部记录失效后尝试展开必须明确返回不可用，不能声称仍能核查原文，也不能改用当前相似记录。重新发现且版本一致的来源可以恢复读取；不同版本仍是不同证据。正式 Knowledge Statement 应可追溯到原始观察或输入知识，但长期追溯结构和 MVP 覆盖范围不由发现层决定。

这一取舍避免为大型 Agent 历史维护第二份数据，同时保留“这条知识当时依据了什么”的可解释性。

## 7. 持久化现状

生产模式只把 catalog 状态写入 Electron `userData/discovery-state.json`，不在 `userData` 下复制外部聊天记录。JSON repository 是当前 bootstrap 实现，已经隔离在 Discovery Repository 边界之后；是否切换 SQLite 或增加更复杂的分页索引，将根据真实数据规模决定。

## 8. 尚未进入当前切片

- Canonical Activity 与消息/工具级解析；
- Agent Turn / Source Conversation 级实时 Connector；
- 项目身份合并和跨项目关系；
- 自动调度可用外部证据进入 Knowledge Maintenance Agent 或面向 Artifact 的 Projection 活动；
- Embedding、知识搜索、MCP 和 Context Packet；
- 十万文件级分页、Worker 隔离和 byte-offset 增量读取；
- 第三方 Connector 加载协议。

这些能力的上层边界由 [Product Brief](product-brief.md) 和[知识加工、Projection 与 Artifact](../architecture/knowledge-model-and-projection.md)定义；当前发现层不提前决定知识 Schema 或 Agent 行为。

## 9. 验证

当前测试使用脱敏 Fixture 覆盖三个 Adapter、指令优先级、Codex active/archive 去重、损坏文件隔离、Source Conversation catalog 原子刷新、单条记录的确定版本读取，以及记录迁移、增长或消失后的恢复与拒绝行为。测试与正式链路通过同一个 Source Adapter 访问外部记录；Discovery 自身不建立 Raw Evidence 副本，Knowledge Processing Task 的文件化输入由上层 Core 另行负责。

仓库验证命令：

```bash
npm run typecheck
npm test
npm run build
npm run test:ui
```
