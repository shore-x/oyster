# Agent-Agnostic Knowledge Hub 可行性分析

> 日期：2026-07-22
>
> 结论：**有条件可行，建议推进 MVP。** 历史导入、turn 级实时采集和 MCP 检索在 Claude Code、Pi、Codex 上均存在可实施路径；真正困难的部分不是“读到聊天”，而是格式演进、知识质量、安全删除、跨项目身份解析和上下文供给治理。
>
> 发现与存量数据定位的专项设计见[《本机 Agent 发现与存量数据定位》](agent-discovery-and-history-import.md)。
>
> 知识层次、关系与投影的后续设计见[《知识模型与协作式投影》](knowledge-model-and-projection.md)。

## 1. 研究问题

本分析回答：Oyster 是否可以成为独立于 Agent Harness 的本地知识中心，发现本机 Agent、导入既有会话、通过插件增量采集、从异构活动构建知识，并向第三方 Agent 提供搜索与未来的上下文注入？

成功标准：

- 不要求上游 Harness 提供统一历史 API；
- 不把上游私有格式固化为 Oyster 领域模型；
- 批量和实时路径最终进入同一幂等流水线；
- 原始证据、标准化活动和 LLM 派生知识可追溯；
- 基础产品本地可用，远程 LLM 是可配置增强；
- 输出侧至少覆盖 MCP-compatible Agent；
- 安全、删除和 Scope 是架构属性，不是后补 UI。

非目标：当前不决定具体 Embedding 模型、向量引擎、图数据库或内置 Agent Loop；也不把浏览器能力纳入 MVP。

## 2. 本地事实

2026-07-22 在当前开发机进行只读结构检查，未读取或记录聊天正文：

- Claude、Pi、Codex 的数据目录均存在，但三个 CLI 均不在当前 shell 的 `PATH` 中；
- Claude 存在全局 history JSONL 和项目 transcript JSONL，记录包含 session ID，项目 transcript 区分 user、assistant、attachment、permission mode、file history snapshot 等记录；
- Pi 会话是带 header 的 JSONL，消息和配置变化通过 `type` 区分，并使用 `id`/`parentId` 表达树形历史；
- Codex 本地 rollout JSONL 是事件流，观察到 session metadata、turn context、message、tool/function call、token count 等不同 payload；
- 三者都提供足够的稳定标识来实现幂等导入，但不存在可以无损映射三者的单一 `messages` 表。

由此得到两个直接约束：

1. 发现逻辑必须分别探测 executable/app、configuration 和 data roots；只运行 `which` 会漏掉真实来源。
2. Oyster 的 Canonical Activity 必须容纳消息之外的工具、分支、压缩、附件和运行上下文，并保留 provider-specific payload 引用。

本地文件观察只能证明当前版本可解析，不能替代上游公开契约。未被官方文档承诺的文件路径和字段必须标记为 reverse-engineered，并用 Fixture/版本探测保护。

## 3. 外部证据矩阵

| 来源 | 类型与权威性 | 可迁移机制 | 支持的判断 |
| --- | --- | --- | --- |
| [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) | Anthropic 官方、当前产品契约 | Hook 输入包含 `session_id`、`transcript_path`、`cwd`；覆盖 SessionStart、Stop、Compact、SessionEnd 等生命周期 | Claude 可用 Hook 通知 turn/session 变化并定位 transcript |
| [Pi Session Format](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md) | Pi 官方仓库文档 | JSONL、版本 header、`id`/`parentId` 树、SessionManager API、明确数据位置 | Pi 历史导入最接近公开稳定契约，必须保留分支 |
| [Pi Extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) | Pi 官方仓库文档 | session/turn/agent 生命周期事件，Extension API 可访问 SessionManager | Pi 可提供第一方 Extension 做 turn 级实时采集 |
| [Codex Hooks](https://learn.chatgpt.com/docs/hooks) | OpenAI 官方、当前产品契约 | 本地生命周期 command hooks；官方列出发送聊天到日志系统、自动总结持久记忆等用途 | Codex 可通过 Hook 做实时通知/加工触发 |
| [Codex Configuration Reference](https://developers.openai.com/codex/config-reference) | OpenAI 官方配置契约 | Hooks 事件表、history persistence、stdio/HTTP MCP server 配置 | Codex 同时具备采集 Hook 和作为 Oyster MCP Client 的路径 |
| [MCP Server Primitives](https://modelcontextprotocol.io/specification/2025-11-25/server/index) | MCP 官方当前规范 | Resources 由应用控制上下文，Tools 由模型调用，Prompts 由用户触发 | 输出侧优先采用搜索 Tools、可引用 Resources 和用户触发 Context Prompt |
| [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/) | CNCF 规范、Stable | source timestamp/observed timestamp、body、resource、scope、attributes、event name | Canonical Activity 可借鉴异构日志的保真映射原则，但不直接复制 OTel Schema |
| [W3C PROV Overview](https://www.w3.org/TR/prov-overview/) | W3C Provenance 标准 | Entity、Activity、Agent 及生成/归属关系 | Knowledge Item 应显式关联来源、加工活动和 Actor |
| [OpenMemory](https://mem0.ai/openmemory) / [Mem0 MCP](https://docs.mem0.ai/platform/mem0-mcp) | 成熟相邻产品与公开接口 | 跨 Agent MCP memory、capture/organize/deliver、add/search/update/delete tools | 市场需求已被验证；仅做 MCP 记忆 CRUD 不构成 Oyster 差异化 |
| [Letta Shared Memory Blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks) | 成熟 Agent Memory 产品 | 可将同一 Memory Block 附加给多个 Agent，并动态撤销 | 共享记忆和访问 Scope 可行，但 always-in-context 不适合大规模历史知识 |
| [PROJECTMEM](https://arxiv.org/abs/2606.12329) | 近期论文与开源实现；样本规模有限 | 追加式 typed event、确定性 projection、MCP、出处、失败前提醒 | Event-sourced local memory 是有效邻近方向；其自研究估计不能当作 Oyster 效果证明 |

## 4. Harness 集成可行性

### 4.1 能力矩阵

| Harness | 发现 | 历史导入 | 实时路径 | 输出/注入路径 | 主要风险 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | 常见数据根、配置、可执行文件或 App | transcript JSONL；部分字段属于实现细节 | 官方 Hooks 提供 session/transcript locator，适合 Stop/Compact/SessionEnd 通知 | MCP；SessionStart/UserPromptSubmit Hook 可在未来注入 | transcript Schema 不是完整稳定 API；Hook 配置修改需用户明确授权 |
| Pi | `~/.pi/agent`、settings、session roots、可执行文件 | 官方版本化 JSONL，保留树形分支 | 官方 Extension 事件与 SessionManager | MCP/Extension、自定义 Context/Tool | Extension 具备本机代码权限；Session 版本迁移要用 Fixture 固定 |
| Codex | `~/.codex`、App/CLI/config | 本地 rollout JSONL 可导入，但具体事件 Schema 应视为实现细节 | 官方 lifecycle command Hooks | 官方支持 stdio/HTTP MCP Client；Hook 可做 Context 流程 | 不同 Codex surface 的本地状态可能不同；App 私有 rollout 结构会演进 |

### 4.2 推荐的双路径设计

每个 Connector 同时实现两条可互相补偿的路径：

- **History Importer**：扫描或枚举会话，按文件身份、稳定 session ID、byte offset/record ID 和 checksum 建立游标；负责首次回填、离线补采和修复漏事件。
- **Live Bridge**：Harness Hook/Extension 只向 Oyster 发出 authenticated notification，携带最小 Locator 和游标；不把整段 transcript 复制进 Hook 参数。

两条路径都进入同一个幂等 Ingestion API。Live Bridge 不被视为数据真相；丢通知、Hook 超时或 Oyster 未启动时，History Importer 必须补齐。

不建议只使用文件系统 watcher。Watcher 可以作为辅助触发器，但无法稳定表达 session 结束、compaction、分支切换等语义，且在原子替换、App 沙箱、睡眠唤醒和大文件重写时容易漏报。

## 5. 推荐架构

```text
Claude Hook ─┐
Pi Extension ├─> Connector Host ─> Raw Evidence ─> Canonical Activity
Codex Hook ──┤         ^                 │                  │
History Scan ┘         └── cursor/retry ─┘                  v
                                                   Knowledge Pipeline
                                               classify/extract/link/review
                                                           │
                                                           v
                                            Collaborative Projection Update
                                                           │
                                      ┌────────────────────┴─────────────┐
                                      v                                  v
                              Search & Workbench                 Context Service
                              FTS / filters / views              MCP / local API
```

### 5.1 Connector Host

职责：发现、权限提示、插件生命周期、文件读取、格式识别、游标、重试和隔离。

关键不变量：

- Connector 只能访问 Manifest 声明且用户授权的路径；
- Connector 输出必须带 source installation、format version 和 observed timestamp；
- Connector 不直接调用远程 LLM，不直接写最终知识；
- 第一方 Connector 也运行在 Desktop Main 之外；
- 一个损坏来源不会阻塞其他来源的导入。

### 5.2 Raw Evidence Store

建议使用内容寻址对象或按来源切分的追加式 segment，SQLite 保存 catalog、游标和引用。每个 Evidence Envelope 至少包含：

```text
evidence_id
source_kind / source_installation_id / source_format_version
source_locator / source_session_id / source_record_id
source_timestamp / observed_timestamp
content_hash / byte_length
sensitivity / retention_state
raw_object_ref
```

Raw Evidence 的价值是可重跑和可审计。不要因为当前只需要文本就丢弃工具调用结构、附件引用或 provider-specific 字段。

### 5.3 Canonical Activity

Canonical Activity 是最小公共语义，不追求覆盖所有 provider 字段。建议顶层字段：

```text
event_id / kind / occurred_at / observed_at
source_agent / session_id / turn_id / parent_event_id
actor: user | assistant | tool | system | subagent
project_ref / workspace_ref
body_ref / artifact_refs
correlation: tool_call_id, branch_parent, trace_id
evidence_refs[]
provider_attributes
normalizer_version
```

`kind` 初始只覆盖 session、turn、message、tool call/result、compaction、artifact、context snapshot 和 error。未知记录作为 `provider_event` 保留，不为了“Schema 干净”丢弃。

### 5.4 Project Identity Resolver

仅用绝对 `cwd` 会把同一仓库的 clone、worktree 和重命名目录拆成多个项目。Resolver 应组合：

- Git remote 的规范化 identity；
- repository root 和 worktree 关系；
- Harness 自带 project/session metadata；
- 用户手工合并、拆分和 Topic 关系；
- 非 Git 目录的稳定 local identity。

自动推断只产生候选。跨项目关系是产品价值来源，也最容易发生错误合并，必须可解释和撤销。

### 5.5 Knowledge Pipeline

Pipeline 采用版本化 Job：

1. 确定新的或变化的 Canonical Activity 范围；
2. Secret/PII 分类和允许发送的字段裁剪；
3. 确定性分段和基础全文索引；
4. LLM/规则按当前 Attention/加工策略提取带出处的知识候选；Decision、Problem、Attempt、Outcome 只是可替换的早期视角；
5. 用 evidence refs 或已有知识建立派生链，并保留 project/topic、actor、valid time 等适用上下文；
6. 发现可能的重复、补充、修订或冲突，但不把这些模型判断固化为不可质疑的关系，也不静默覆盖；
7. 用户审查或按策略发布为可检索知识；首次按 Attention 初始化持久投影文档，后续以当前协作文档为输入形成新修订；
8. 记录 model、prompt、pipeline version 和成本；
9. 算法更新时只重建派生层。

`candidate`、`accepted`、`rejected`、`superseded`、`conflicting` 可以作为首轮评测的临时工作流词汇，但不是知识本体或“真/假”替代品。所有知识仍应展示证据、适用范围和派生链；在验证真实维护流程前，不把这些状态固定为长期 Schema。

### 5.6 Search 与 Context Service

首版使用 SQLite structured filters + FTS，语义 Embedding 作为可重建索引加入。不要在验证查询集之前引入图数据库或把向量 Top-k 当作唯一检索。

检索流程建议为：Scope filter → lexical/semantic candidates → provenance/freshness/conflict policy → optional rerank → token-budget assembly。

MCP 输出采用：

- Tool 完成 query、过滤和有界 Context 构建；
- Resource Link 指回稳定 Knowledge/Evidence URI；
- Prompt 只用于用户主动选择的工作流；
- 每次返回包含知识状态、时间、项目、来源 Agent 和引用；
- write/delete 工具与 read/search 工具分开授权，MVP 默认不向外暴露写工具。

## 6. 设计空间与取舍

### 方案 A：直接统一成消息表 + 向量库

优点是快；缺点是丢失工具、分支、压缩、附件和 provider 语义，派生摘要难以重建和纠错。该方案无法支撑 Oyster 的出处与治理差异化，拒绝。

### 方案 B：只提供 MCP Memory CRUD

与 Mem0/OpenMemory 路线接近，集成简单，但依赖 Agent 主动保存，无法完整回填已有历史，也不能解释未被 Agent 写入的失败和决策。可作为输出接口，不作为核心存储模型。

### 方案 C：观察 + 知识 + 投影三层、Connector 双路径

观察层内部继续区分 Raw Evidence 与 Canonical Activity。该方案成本高于 A/B，但能够吸收 Schema 演进、离线补采、重处理、出处、冲突、用户 Attention 和删除需求。推荐采用。

### 方案 D：直接成为新的 Agent Harness

内置 Agent 会让端到端演示更直接，但会把有限资源投入模型路由、工具执行、权限和 UI，与知识中心定位竞争。首版拒绝；未来只在知识维护或验证输出价值时引入薄 Agent Runtime。

## 7. Borrow / Adapt / Reject

### Borrow

- 借鉴 OpenTelemetry 的原始时间与观察时间分离、Resource/Scope 和 extensible attributes；
- 借鉴 W3C PROV 的 Evidence/Activity/Actor 思维；
- 借鉴 Pi 的版本化 Session 与分支保留；
- 使用 MCP 作为主输出协议；
- 借鉴 Event Sourcing 的原始记录可重放与派生投影。

### Adapt

- 不直接实现完整 OTel 或 PROV 标准，只保留适合个人 Agent 活动的最小语义；
- MCP 是消费边界，不是内部领域模型；
- Hook/Extension 是低延迟提示，不是唯一数据通道；
- “Data Lake”收敛为本地分层存储，不采用大数据基础设施；
- LLM Knowledge Extraction 输出候选理解，必须绑定 evidence/knowledge dependency 与 pipeline version；
- Markdown/Wiki 作为用户与 Agent 共同维护的投影文档，不作为唯一知识真相，也不被下层全量重建覆盖。

### Reject

- 把向量数据库作为事实存储；
- 只保存摘要而丢弃原始会话；
- 自动把检索结果注入所有 Agent；
- 用文件 watcher 替代 Harness 生命周期插件；
- 为统一 Schema 抹掉树形分支和工具调用；
- 将 Harness 内部路径和 JSON 字段宣布为永久公共协议；
- 在 Electron Main 内加载任意第三方 Connector。

## 8. 主要风险与缓解

| 风险 | 严重度 | 缓解方式 |
| --- | --- | --- |
| 上游私有格式变化 | 高 | format probe、版本范围、golden fixtures、unknown record 保留、Connector 独立发布 |
| 采集到凭证/敏感源码 | 高 | opt-in 范围、静态加密 Spike、最小权限、redaction、远程处理前预览、级联删除测试 |
| LLM 生成错误知识 | 高 | Evidence 强绑定、candidate 默认、冲突并存、用户审查、版本化重建 |
| 实时 Hook 丢失或阻塞 Agent | 高 | Hook 只发送短通知、严格超时、失败开放、历史补采、outbox/retry |
| 跨项目误合并 | 中高 | Git identity + 用户确认、候选关系、可撤销 merge、Scope filter |
| 数据规模导致索引/LLM 成本失控 | 中高 | 增量 Job、内容 hash、确定性预过滤、按需提取、预算与队列可见性 |
| 自动 Context 注入污染 Prompt | 高 | MVP pull-first、引用与选择理由、token budget、敏感过滤、注入日志、关闭开关 |
| 与 OpenMemory 等产品同质化 | 中高 | 聚焦历史回填、异构保真、跨项目关系、证据与知识治理，不以 Memory CRUD 为卖点 |
| Connector 插件供应链 | 高 | MVP 第一方签名、独立进程、能力 Manifest、安装风险提示、未来签名/审核机制 |
| 上游增加原生跨会话记忆 | 中 | Oyster 保持跨 Harness 所有权、可导出和出处；不要与单 Harness 的体验功能正面竞争 |

## 9. 分阶段验证

### Spike 1：格式与幂等性

- 为三种 Harness 采集脱敏 Fixture：正常会话、工具调用、分支/子 Agent、Compaction、损坏尾行；
- 实现只读 Enumerator 和 Parser；
- 验证重复导入、追加、截断、重命名和中断恢复；
- 输出字段覆盖率和 unknown record 报告。

通过标准：所有支持记录能回到原始行；重复运行零重复；未知记录不丢失。

### Spike 2：实时桥

- Claude Stop/SessionEnd Hook；
- Pi Extension 的 agent/session lifecycle；
- Codex Stop/Session Hook；
- 统一发送到带临时 token 的本地 socket；
- 测试 Oyster 未运行、Hook 超时、重复通知和断电补采。

通过标准：不显著拖慢 Harness；turn 在目标延迟内出现；任意漏通知可由 importer 补齐。

### Spike 3：知识与检索

- 从真实脱敏会话建立 50–100 个用户标注的目标查询与期望证据；Decision/Problem/Attempt/Outcome 可作为第一组 Attention 视角，但不限定全部样本；
- 比较 FTS、FTS + Embedding、可选 rerank；
- 记录 Claim 精确率、引用正确率、用户编辑率、Recall@k 和 Token 成本；
- 验证冲突、过期和跨项目误合并。

通过标准：先定义目标阈值再选模型/索引，不以 Demo 个例作为通过证据。

### Spike 4：安全与删除

- 使用假的 API key、私钥、个人信息和大段工具输出 Fixture；
- 覆盖日志、数据库、Raw object、索引、缓存、Job payload、MCP 和远程请求；
- 测试来源撤权、单会话删除、项目删除和全量删除。

通过标准：未授权 Surface 看不到正文；测试 Secret 不泄漏；删除后不存在可检索或可恢复副本。

## 10. 可行性结论

| 能力 | 判断 | 说明 |
| --- | --- | --- |
| 本地 Agent/数据源发现 | 高 | 常见位置和配置可探测；需区分安装与残留数据 |
| 三 Harness 历史导入 | 高（维护风险中高） | 当前格式均结构化；Pi 契约最清晰，Claude/Codex 需 Fixture 防漂移 |
| turn 级实时导入 | 高 | 三者均有 Hook/Extension 路径；必须有补采兜底 |
| 跨项目统一活动模型 | 中高 | 技术可行，但 identity merge 需要用户控制 |
| 自动构建可靠知识 | 中 | LLM 可提取候选，可靠性依赖出处、审查、评测和冲突模型 |
| 为第三方 Agent 提供搜索 | 高 | MCP 已被目标 Harness 支持，适合统一 Pull 接口 |
| 自动上下文注入 | 中 | 技术路径存在，产品与安全风险高，建议延后并保持可见/可关闭 |
| 内置 Agent 与浏览器 | 中 | 可复用未来架构，但与 MVP 价值验证无直接依赖 |

最终建议：推进方案 C，但先把“可重放导入 + 可追溯搜索”做成第一条完整纵向切片。不要先建设通用知识图谱、复杂多 Agent Runtime 或完整 Connector Marketplace。Oyster 的护城河应是长期积累的高质量、可治理、跨 Harness 证据和知识，而不是某个 Embedding 模型或某个 Agent 的插件 API。

## 11. 未决问题

- MVP 是否只支持 macOS，Windows/WSL 的 Agent 数据应如何发现与授权；
- 用户是否允许保存完整 Raw Evidence，还是需要按来源提供 metadata-only/redacted-only 模式；
- 静态加密采用数据库级、对象级还是两者组合，以及全文检索的权衡；
- Project、Topic、Workspace 的最小关系模型；
- 远程 LLM Provider 的默认关闭策略、Redaction UI 和成本预算；
- 哪些知识类型可以自动发布，哪些必须用户确认；
- Context Packet 的默认 Token Budget、引用格式和冲突呈现；
- Connector 更新如何与 Harness 自动更新解耦；
- 数据出口的写能力何时开放，以及第三方 Agent 写入的 Trust Level；
- 如何建立长期真实查询集，避免只优化合成 memory benchmark。
