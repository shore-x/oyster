# Oyster Product Brief

> 状态：当前产品定位（source of truth）
>
> 日期：2026-07-22
>
> 决策记录：[ADR-0001：将 Oyster 定位为 Agent-Agnostic Knowledge Hub](../decisions/0001-agent-agnostic-knowledge-hub.md)

## 1. 一句话定位

Oyster 是一个独立于 Claude Code、Pi、Codex 等 Agent Harness 的、本地优先的跨 Agent、跨项目知识库维护中心：它持续收集异构 Agent 活动，保留原始出处，将其加工为可检查、可修订、可检索的知识，并按授权向第三方 Agent 提供搜索与上下文。

浏览器、内置 Agent 和任务执行能力可以成为 Oyster 的数据源或消费者，但不再定义产品身份。

## 2. 用户问题

用户同时使用多个 Agent，并在多个项目间工作时，知识被切碎在不同 Harness 的会话、项目目录和私有格式中：

- 同一问题可能在 Claude Code、Pi 和 Codex 中被重复调查；
- 已尝试方案、失败原因、架构决策和用户偏好难以跨会话复用；
- Agent 原生记忆通常绑定特定产品、账户、项目或会话；
- 历史对话虽存在本地文件中，却缺少统一搜索、关系、出处和生命周期管理；
- 把聊天记录直接向量化会丢失分支、工具调用、时间、项目和来源语义；
- 自动总结容易把推断写成事实，且难以追溯和纠错；
- 用户缺少一个能够查看“收集了什么、如何得出、向谁提供过”的独立控制面。

## 3. 产品承诺

Oyster 向用户提供四个核心能力：

1. **发现与接入**：发现本机 Agent 的可执行程序、应用、配置和数据目录，明确展示每个来源支持历史导入、实时采集或上下文输出中的哪些能力。
2. **保真收集**：批量导入已有聊天历史，并通过 Harness 插件或 Hook 在 turn/session 边界增量采集；原始记录不因统一模型而丢失。
3. **知识加工**：把异构记录转为带出处的事件、材料、结论、决策、问题、尝试和关系，支持搜索、修订、冲突与删除。
4. **安全供给**：通过本地 API 和 MCP 等开放边界向第三方 Agent 提供检索；未来可在用户授权、Scope 和 Token Budget 内生成并注入 Context Packet。

## 4. 产品身份与边界

Oyster 是：

- Agent-agnostic 的个人知识基础设施；
- 本地 Agent 活动的可检查数据层和控制面；
- 历史证据、标准化事件和派生知识的长期所有者；
- 跨项目、跨仓库路径和跨 Harness 的关系维护者；
- 可以调用 LLM、但不把 LLM 输出自动当作真相的知识加工系统；
- 未来可承载内置 Agent、浏览器和执行能力的平台。

Oyster 不是：

- 某个 Agent 的聊天客户端或历史记录查看器；
- 只提供向量搜索的 Memory MCP Server；
- 将全部聊天无差别上传云端的遥测系统；
- 默认把所有历史自动塞入每次 Prompt 的上下文注入器；
- 以替代 Chrome 为目标的浏览器；
- 首个版本就承担多用户数据湖、企业治理或自主 Agent 编排的平台。

“Data Lake”是用于说明分层和保真的产品类比，不代表 MVP 应引入 S3、Iceberg、Spark 或数据仓库式基础设施。单用户、本地优先阶段应以文件/对象存储加 SQLite 索引实现相同的所有权边界。

## 5. 核心领域分层

Oyster 必须把三个层次分开，避免把模型总结覆盖到原始事实之上：

| 层次 | 内容 | 规则 |
| --- | --- | --- |
| Raw Evidence | Harness 原始记录、来源 Locator、校验和、采集时间、格式版本 | 保真、追加式、可删除；不为统一 Schema 破坏原始数据 |
| Canonical Activity | Session、Turn、Message、Tool Call/Result、Compaction、Artifact 等标准化事件 | 可重建、版本化；始终引用 Raw Evidence |
| Derived Knowledge | 决策、事实、偏好、问题、尝试、结果、摘要、实体与关系 | 可修订、可冲突、带置信度和出处；不得伪装成原始事实 |

删除权高于追加式存储：用户删除来源时，系统先建立 Tombstone 并停止供给，随后物理清除 Raw Evidence、索引和所有派生数据。这里的“不可变”表示正常加工不覆写证据，不表示无限期保留。

## 6. MVP 用户流程

### 6.1 发现 Agent 和数据源

第一阶段功能与简化数据模型见[《本地 Agent 发现与历史同步 MVP》](local-agent-discovery-mvp.md)，长期设计见[《本机 Agent 发现与存量数据定位》](../architecture/agent-discovery-and-history-import.md)。发现分为未读取聊天正文的被动候选检查，以及用户授权后的格式验证与导入预览。

Oyster 启动后执行本地发现，并分别报告：

- Harness 是否可启动：PATH、常见安装位置、应用包或包管理器记录；
- 数据是否存在：已知配置、会话和归档目录；
- 历史导入能力：格式识别版本、会话数、时间范围和预计大小；
- 实时能力：Hook、Extension、Plugin 或文件增量监听；
- 输出能力：MCP、配置文件导出或 Harness 专用插件；
- 权限状态：未授权、只读、已启用实时采集或已断开。

“安装存在”和“数据存在”是两个不同结论。Agent 可能通过 GUI 启动、不在当前 PATH 中，但仍有可导入的数据。

### 6.2 首次历史导入

1. 用户选择 Claude Code、Pi 或 Codex 来源；
2. Oyster 预览将访问的目录、记录数量、项目范围和敏感信息风险；
3. 用户选择全部、按项目、按时间或按会话导入；
4. Connector 保存 Raw Evidence，并生成 Canonical Activity；
5. 导入可以中断和恢复，重复执行不产生重复记录；
6. UI 展示覆盖率、跳过项、格式错误和待处理敏感项；
7. 用户可以按 Agent、项目、会话、时间和事件类型浏览与全文搜索。

### 6.3 实时增量采集

用户显式安装或启用第一方 Connector 插件。插件在稳定生命周期边界通知 Oyster，例如 Turn Stop、Agent End、Compaction 或 Session End。通知仅包含来源 ID、Session ID、游标或 transcript locator；Oyster 通过带鉴权的本地 IPC 增量读取并去重，不在命令行参数中传递完整聊天正文。

MVP 的“实时”定义为 **turn 级近实时**，不是 token streaming。正常情况下，一个完成的 turn 应在数秒内可检索；插件离线或 Oyster 未运行时，下一次启动必须从历史文件补采。

### 6.4 构建和维护知识

用户可以对选定项目或会话运行知识加工：

- 确定项目、仓库、Topic 和 Session 的关系；
- 提取决策、需求、约束、问题、尝试、结果和用户明确偏好；
- 生成可检查的摘要、关键词、实体和关系；
- 将相互矛盾的 Claim 并列呈现，而不是静默覆盖；
- 从每个 Knowledge Item 回到原始消息、工具结果和来源文件；
- 接受、修改、拒绝、固定或删除派生知识；
- 在模型、Prompt 或算法升级后重新生成派生层，不重写 Raw Evidence。

### 6.5 检索和供给上下文

MVP 提供本地搜索 UI，以及只读优先的 MCP 能力：

- `search_knowledge`：按 query、project/topic、source agent、时间和知识类型检索；
- `get_knowledge`：读取一条知识及其出处、版本和置信状态；
- `get_evidence`：在权限允许时读取最小必要的原始证据；
- `build_context`：按目标、Scope 和 Token Budget 生成带引用的 Context Packet。

默认采用 Agent 主动查询的 Pull 模式。自动 Push 注入属于后续能力：它需要可解释的选择理由、严格的项目/身份 Scope、敏感信息过滤和用户可见的注入记录。

## 7. MVP 范围

### 必须完成

- macOS 上发现 Claude Code、Pi、Codex 的数据源；
- 三个第一方 Connector 的历史导入；
- 统一的 Connector Plugin API 与版本化 Capability Manifest；
- 三个 Harness 的 turn/session 级实时增量采集路径；
- Raw Evidence、Canonical Activity、Derived Knowledge 三层存储；
- 可恢复、幂等的导入游标和失败队列；
- 项目/会话浏览、全文搜索、基础筛选和出处跳转；
- 至少提取决策、问题、尝试、结果四类知识；
- 用户审查、纠正、删除和重新加工；
- 可替换的 LLM Provider 接口，以及至少一个可配置 Provider；本地模型支持不作为 MVP 硬依赖；
- 密钥进入系统钥匙串，不进入会话、日志和模型输入；
- 本地 MCP Server 提供检索与有预算的 Context Packet；
- 导入、加工、检索、供给和删除的审计记录。

### 明确不做

- 完整浏览器 Shell；
- 自主完成复杂任务的通用内置 Agent；
- 自动修改所有 Harness 的全局配置；
- token 级实时镜像；
- 在没有用户确认时导入所有本地聊天；
- 默认云同步或团队共享；
- 把派生知识自动写回 `AGENTS.md`、`CLAUDE.md` 等项目文件；
- 依赖某个向量数据库作为领域真相；
- 首版支持任意第三方 Connector 在主进程内执行。

## 8. Connector 契约

每个 Connector 通过 Manifest 声明能力，而不是假设所有 Harness 行为相同：

```text
id / version / supported_os
discover: executable | app | data_roots | config
history: enumerate | preview | import | resume
live: hook | extension | file_watch | unsupported
output: mcp | context_hook | file_export | unsupported
source_formats: names and supported version ranges
permissions: requested paths and operations
```

Connector 只拥有发现、读取、解析和来源游标。它可以产生 Raw Evidence 与 Canonical Activity，但不能直接创建最终 Knowledge Item，也不能绕过权限将数据发给 LLM。知识加工、Scope、审查、删除和供给由 Oyster Core 统一拥有。

MVP 只内置和签名第一方 Connector。未来第三方 Connector 必须在独立进程中运行，使用显式文件范围、本地网络范围和版本化协议；Harness 插件通常拥有与 Agent 相同的本机权限，安装前必须展示这一风险。

## 9. LLM 在产品中的职责

LLM 适合承担：

- 语义分段、分类、实体解析和关系候选；
- 决策/问题/尝试/结果提取；
- 去重候选、冲突提示、摘要和检索重排；
- 为一次查询构建带引用的 Context Packet；
- 未来驱动内置 Agent 进行受控知识维护。

LLM 不拥有事实真相。每个加工 Job 必须保存输入 Evidence ID、算法版本、Prompt 版本、模型/Provider、时间和输出；模型输出默认为“候选”或“推断”，只有用户明确内容或用户审查后的内容才可提高状态。

基础导入、浏览、全文搜索、删除和导出不得依赖在线 LLM 才能工作。

## 10. 安全与隐私底线

- 默认本地保存，任何远程模型处理都按 Provider 和 Scope 显式授权；
- 首次导入前预览目录、范围和风险，不后台扫描聊天正文后再征求同意；
- 原始聊天可能包含源码、凭证、个人信息和工具输出，按高敏数据处理；
- 日志仅记录 ID、状态和脱敏诊断，不记录正文、Prompt 或凭证；
- 远程加工前执行 Secret/PII 检测与可见的 Redaction；
- 数据库、对象和索引遵守最小文件权限；静态加密方案必须在实现前通过 Spike 确认；
- 搜索、MCP 和 Context Packet 都执行相同的 Scope 与敏感级别策略；
- Connector 读取权限和 Context Consumer 读取权限分开管理；
- 用户可查看某条知识何时被哪个 Agent 查询或注入；
- 删除必须级联到原始数据、索引、缓存、派生知识和待执行 Job。

## 11. 产品指标

### MVP 成功指标

- 发现准确率：测试机上的目标 Agent 数据源无漏报，误报可解释；
- 导入完整性：Fixture 中所有支持事件可追溯到原始行，重复导入零重复；
- 恢复能力：任意中断后可从游标恢复，文件追加、截断和移动有确定行为；
- 实时延迟：完成 turn 后正常路径数秒内可检索，离线后可补采；
- 知识质量：用户接受/轻微编辑率、错误 Claim 率和出处完整率可量化；
- 检索质量：在真实跨 Agent 问题集上测 Recall@k、引用正确率和 Token 成本；
- 用户价值：减少重新解释背景的次数和耗时，减少重复失败尝试；
- 隐私：Fixture 中的测试凭证不进入日志、远程请求或未授权 Context Packet。

## 12. 后续方向

在 MVP 证明收集完整性、知识质量和检索价值后，再依次考虑：

1. 更多 Harness、IDE、Issue Tracker、文档和浏览器来源；
2. SessionStart/UserPrompt 等生命周期的可审查 Context Push；
3. 项目规则文件的用户审查式导出，而非自动覆写；
4. 本地或远程同步、多设备和团队 Scope；
5. 内置知识维护 Agent，例如冲突清理、过期检查和关系建议；
6. 受控任务执行与 Agent Browser；
7. 基于历史失败的提醒或策略 Gate。

任何新增能力都必须继续服从两个判断：它是否提高知识的可复用性；它是否保持出处、权限和用户控制。
