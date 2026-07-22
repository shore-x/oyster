# Oyster 新仓库产品与工程交接

> 状态：历史交接输入，保留用于解释项目来源，不再是当前产品定位的唯一 source of truth。
>
> 2026-07-22 起，Oyster 已进一步收敛为独立于 Agent Harness 的跨 Agent、跨项目知识库维护中心。当前定位见 [Product Brief](./product-brief.md)，技术可行性与集成边界见 [Agent Knowledge Hub 可行性分析](../architecture/agent-knowledge-hub-feasibility.md)。如本文与上述正式文档冲突，以上述正式文档为准。

> 文档性质：新项目的历史起始契约与工程交接说明
>
> 适用对象：新仓库中的产品设计者、架构设计者与开发 Agent
>
> 与旧仓库的关系：本文记录新仓库 `oyster` 的起始契约；旧仓库 `oyster-browser` 保留为只读学习资料和实现证据库。
>
> 旧仓库本地路径：`/Users/xiezhengxiao/repo/oyster-browser`

## 1. 执行摘要

本项目已经在独立的新仓库中启动。不要继续把旧仓库 `oyster-browser` 演化为新产品，也不要删除旧仓库。

新的 Oyster 不是一款以替代 Chrome 为目标的独立浏览器，而是一个独立的 **Context Workbench（上下文工作台）**。它负责：

- 统一管理跨项目、跨网页和跨个人兴趣的上下文；
- 让用户与 Agent 的讨论能够延续，而不必在每个新会话中重新解释背景；
- 管理 Oyster Agent 自己的身份、会话和权限；
- 把 Chrome、Agent Browser、文件系统、代码仓库和其他信息源组合成可协作的工作界面；
- 在需要时提供可审查、可介入的 Agent 操作过程，但不把“完整浏览器外壳”当作产品主体。

新项目的默认技术路线仍然是 **TypeScript + Electron**。Electron 在这里是桌面工作台、可信本地运行时和按需浏览器容器，不再承担复刻 Chrome 产品能力的任务。是否改用 Tauri、Rust 或其他技术，应由明确的性能指标和产品边界触发，不应仅因为“看起来更轻量”而提前增加多语言和多运行时复杂度。

一句话定位：

> Oyster 是一个理解“我正在做什么”的个人 AI 协作工作台；浏览器是它最重要的上下文来源和执行工具之一，但不是它的产品身份。

## 2. 为什么重新定位

### 2.1 最初的浏览器假设

旧仓库最初将 Oyster 定位为浏览器，主要基于以下假设：

- 浏览器是用户大量知识工作的发生地，适合作为 AI 的工作界面；
- 自己控制浏览器可以获得更完整的页面状态和视觉信息；
- 内置 Agent 可以突破普通扩展的能力边界，更可靠地理解页面并执行操作；
- 将 LLM、知识库和浏览行为结合，可能比独立聊天应用更自然。

这些假设推动了旧仓库对浏览器外壳、标签页、页面感知、视觉定位和浏览器 Agent 的大量投入。

### 2.2 被开发实践修正的部分

实际开发表明，“AI 应当与日常工作结合”并不等于“必须重新实现一款浏览器”：

- 暂停使用视觉小模型后，独立浏览器与普通浏览器 Agent/扩展的差异明显缩小；
- 标签页、地址栏、书签、历史记录、下载、兼容性和浏览器安全等基础能力成本很高，却不是 Oyster 的核心价值；
- 用户已经拥有成熟的 Chrome 使用习惯、登录状态和扩展生态，强制迁移会增加阻力；
- Codex 等应用已经证明，桌面 App 可以把浏览器作为工具使用；真正未被解决的问题是跨任务上下文连续性，而不是缺少另一个浏览器窗口。

因此，新项目不再以“更好的 AI 浏览器”为主要问题定义。

### 2.3 仍然成立的核心洞察

最初方向中有一个更重要的判断仍然成立：常规 AI 应用通常按会话、仓库或显式项目组织上下文，难以理解用户横跨多个工作项目、网页阅读和个人兴趣的长期活动。

用户的真实痛点包括：

- 临时想与 AI 讨论一件事时，需要重新解释大量背景；
- 某篇网页、一次讨论、一个代码仓库和一个长期关注主题之间的关系没有被持续保存；
- AI 能完成高强度的局部任务，却不一定知道这些任务为什么重要、属于哪个方向；
- 不同 Agent 或会话重复收集相同背景，用户承担上下文搬运工作；
- 浏览器中的阅读、标注和收藏与本地开发活动彼此割裂。

新 Oyster 要解决的是这些对象之间的连续性。它应把用户正在做的事情视为持续演化的工作与知识网络，而不是一组互不相干的聊天记录。

## 3. 新产品定义

### 3.1 产品承诺

Oyster 应帮助用户做到三件事：

1. **随手带入上下文**：在 Chrome、文件、仓库或 Oyster 内部，把当前材料快速加入正确的主题或讨论。
2. **持续理解工作方向**：保存来源、讨论、结论、待办和关系，让后续 Agent 可以在授权范围内恢复背景。
3. **委托具有独立身份的 Agent**：Agent 可以使用自己的账户和浏览器状态执行任务，并在需要用户介入时提供可控的接管界面。

### 3.2 产品边界

Oyster 是：

- 独立桌面 App；
- 个人上下文与长期记忆的管理者；
- 用户、Agent、浏览器和本地工作之间的协调层；
- Agent 身份、权限、运行记录和人工介入的所有者；
- 多种信息源的聚合与协作界面。

Oyster 不是：

- Chrome 的完整替代品；
- 另一套标签页、地址栏、书签、历史记录和下载管理器；
- 只在网页上悬浮一个聊天框的浏览器扩展；
- 把所有用户活动无差别记录下来的监控工具；
- 为了展示 Agent 操作而实现的远程桌面或页面投影系统；
- 仅按代码仓库划分上下文的开发工具。

### 3.3 浏览器在产品中的角色

浏览器能力分为两个清晰角色：

| 角色 | 默认载体 | 所有者 | 用途 |
| --- | --- | --- | --- |
| User Browser | 用户已有的 Chrome | 用户 | 正常浏览、阅读、选择、标注，以及显式发送上下文 |
| Agent Browser | Oyster 管理的浏览器 Profile | Oyster | 使用 Agent 身份登录、读取页面和执行受控任务 |

二者不共享隐式控制权。Chrome 扩展连接 User Browser；独立的 Browser Runtime 管理 Agent Browser。它们可以把内容送入同一个 Context Store，但 cookie、会话和操作归属必须保持隔离。

未来可以增强 Oyster 内部的浏览能力，甚至在产品验证后发展更完整的浏览器外壳，但这不是新仓库的起点，也不能反过来污染核心领域模型。

## 4. 核心用户流程

### 4.1 从 Chrome 捕获上下文

用户在 Chrome 中通过快捷键、右键菜单、选中文本后的动作或扩展面板，显式执行以下操作之一：

- 将当前页面加入 Oyster；
- 将选中文本、页面标题、URL 和用户备注加入现有主题；
- 创建一个新讨论并附带当前上下文；
- 把内容标记为待读、参考资料、证据或待处理事项；
- 直接向指定 Agent 提问。

扩展只采集完成该动作所需的数据。默认不持续上传完整浏览历史，不依赖“自动记录一切”才能建立记忆。

### 4.2 在 Oyster 中延续讨论

用户打开某个 Topic、Workspace 或 Conversation 时，Oyster 应构建一份可检查的 Context Packet。用户能够知道：

- 当前 Agent 看到了哪些来源；
- 每条内容来自哪里、何时加入、由谁加入；
- 哪些是原始材料，哪些是 AI 总结或推断；
- 为什么某段记忆被检索进本次对话；
- 如何移除、固定或更正上下文。

Context Packet 是一次运行的输入投影，不是新的真相来源。原始来源、用户记录和持久化知识仍由各自的数据所有者管理。

### 4.3 委托 Agent 使用独立身份执行任务

当任务需要登录网站时，Oyster 选择或创建一个 Agent Identity，并将它绑定到一个隔离的 Browser Profile。任务通常可以在后台或非前台窗口中执行，Workbench 只展示：

- 当前目标和步骤；
- 正在使用的身份；
- 关键操作与权限状态；
- 结果、失败原因和可追溯记录；
- 是否需要用户介入。

### 4.4 用户介入与归还控制权

验证码、Passkey、OAuth、风控确认或高风险操作可能需要用户介入。首选流程是：

1. Agent 暂停，不再向页面发送输入；
2. Oyster 在 App 内显示同一个 Agent Browser 页面；
3. 用户完成必要操作；
4. 用户显式将控制权交还给 Agent；
5. Oyster 重新检查页面状态，再继续执行。

如果目标网站与 Electron/Chromium 不兼容，可以使用 Oyster 管理的独立 Chrome 实例作为兼容性后端。该实例使用 Oyster 专属 `user-data-dir`，不能复用用户日常 Chrome Profile。

首个版本不把 Agent 页面投影到用户已经打开的 Chrome 标签页。该机制会引入会话归属、双向输入同步、页面安全语义和故障恢复等复杂问题，却没有证明是高频刚需。

## 5. 身份、权限与安全不变量

“Oyster 必须拥有独立身份体系”是产品底线，不是可选增强。

### 5.1 身份对象

至少需要区分：

- **User Identity**：用户本人及其对 Oyster 的授权；
- **Agent Identity**：由 Oyster 管理、可被任务选择的独立身份；
- **Browser Profile**：cookie、local storage、缓存和浏览器会话的物理容器；
- **Credential Reference**：指向系统钥匙串或其他安全存储的引用；
- **Actor**：实际发起某次操作的主体，例如 User、Agent 或 System。

身份不应被简化为一个 cookie 目录。身份还包括权限、用途、来源、生命周期和审计归属。

### 5.2 必须保持的不变量

- Agent Profile 的 cookie 和站点存储不得泄漏到用户日常 Chrome；
- 一个活跃 Profile 在同一时间只由一个 Browser Runtime 所有；
- 不在 Electron 与 Chrome 之间临时复制 cookie 来“迁移”活跃会话；
- 每个外部操作都能追溯到 User、Agent 或 System；
- 用户接管页面时，Agent 必须暂停；恢复时必须显式交还控制权；
- 凭证正文不进入普通日志、Context Packet、模型提示或同步数据；
- 高风险操作需要独立设计权限、确认、审计与恢复契约；
- 身份删除、登出和 Profile 清理必须有明确且可验证的生命周期。

### 5.3 身份实现原则

优先让 Browser Profile 保留真实的站点登录状态，让系统钥匙串保存应用需要直接使用的密钥或令牌。不要建设一个自制密码管理器，也不要默认让模型看到原始凭证。

## 6. 上下文与知识模型

新仓库开始时不要立刻固化一个庞大的“万能知识图谱”。先围绕真实流程建立最小模型，并保持以下概念分离：

| 概念 | 职责 | 典型生命周期 |
| --- | --- | --- |
| Source | 可追溯的原始材料或外部引用 | 随捕获创建，可更新或失效 |
| Capture | 一次显式采集动作及当时快照 | 不可变或追加修订 |
| Topic / Workspace | 用户持续关注的方向或工作范围 | 长期存在、可重组 |
| Conversation | 用户与 Agent 的协作过程 | 多轮、可关联多个 Topic |
| Knowledge Item | 从来源与讨论中沉淀的可复用结论 | 可修订，必须保留出处 |
| Agent Run | 一次有目标、有输入和结果的执行 | 有限生命周期、可审计 |
| Context Packet | 为某次对话或运行组装的输入投影 | 临时生成，不作为主存储 |

这里的名称是起始词汇，不是不可修改的数据 Schema。新项目应通过具体流程验证是否需要区分 Project、Topic 和 Workspace，避免只为未来可能性增加平行概念。

上下文系统必须优先保证：

- provenance：信息可追溯；
- inspectability：用户能检查本次提供给 Agent 的内容；
- controllability：用户能添加、移除、固定和更正；
- scope：不同身份、主题和任务有明确边界；
- redaction：敏感信息在进入模型和日志前被处理；
- durability：数据在本地可靠保存并可导出；
- replaceable retrieval：检索算法可以替换，不成为领域模型的一部分。

## 7. 建议的系统架构

### 7.1 逻辑结构

```text
Chrome Extension ───────┐
Local Files / Repos ────┼──> Context Ingestion ──> Context Store
Other Connectors ───────┘             │                 │
                                      │                 v
                                      └────────> Context Builder
                                                        │
Workbench UI <──typed IPC── Desktop Shell <──protocol── Agent Runtime
      │                                                 │
      └── intervention / review                         v
                                               Browser Runtime
                                             ├─ Embedded Chromium
                                             └─ Managed Chrome fallback

Identity Store ──> Agent Runtime / Browser Runtime
Audit & Trace  <── all external actions and Agent runs
```

### 7.2 所有权划分

| 模块 | 唯一职责 | 不应拥有 |
| --- | --- | --- |
| Desktop Shell | App 生命周期、窗口、安全策略、更新、IPC 装配 | 业务规则、检索算法、Agent 循环 |
| Workbench UI | 呈现与用户交互 | 数据真相、原始凭证、Browser Profile |
| Context Store | 持久化来源、关系、讨论与知识 | UI 状态、浏览器控制 |
| Context Builder | 为一次运行构建可解释输入 | 持久化主数据、隐式无限采集 |
| Agent Runtime | 计划、工具调用、运行状态与中断恢复 | Electron 窗口对象、具体浏览器实现 |
| Identity Store | 身份元数据、权限与安全引用 | 页面自动化逻辑、普通上下文正文 |
| Browser Runtime | Profile 生命周期、页面读取与操作、介入会话 | 产品项目模型、长期知识 |
| Extension Bridge | 与 Chrome 扩展建立本地可信通道 | Agent 身份 Profile、核心数据库所有权 |
| Audit & Trace | 结构化记录操作、结果、Actor 和脱敏证据 | 业务决策、凭证正文 |

### 7.3 Browser Runtime 接口边界

领域层只能依赖稳定的能力接口，例如：

- create/open/close session；
- navigate and read；
- act with an explicit actor and permission context；
- capture evidence；
- request/cancel intervention；
- pause/resume/terminate；
- report profile and runtime health。

领域代码不应直接持有 Electron `BrowserWindow`、`WebContents`、CDP Client 或 Playwright Page。这样才能在 Embedded Chromium 与 Managed Chrome 之间切换，而不复制 Agent 业务逻辑。

## 8. 技术选型建议

### 8.1 默认选择：TypeScript + Electron

新项目继续使用 TypeScript 和 Electron 是合理的，但前提是重新划分职责：

- Electron Main 只处理桌面生命周期、安全与进程装配；
- Agent Runtime、Context Store、索引和扩展桥运行在 Utility Process 或 Worker 中；
- 同步数据库和重型文件操作不阻塞 Main；
- Renderer 只加载可信的本地 Workbench UI，并通过窄的 typed bridge 调用能力；
- Agent Browser 按需创建，不在应用启动时常驻大量页面；
- 所有 Electron 特有能力都被限制在 adapter 层。

这条路线的优势是：团队可以复用现有 TypeScript 经验；Chrome 扩展、桌面协议和共享类型可以使用同一语言；需要用户介入时也可以在 App 内复用同一个 Chromium Session。

### 8.2 前端框架

SolidJS 可以继续使用，尤其在已有经验和组件习惯的情况下。React 只有在组件生态、招聘或团队协作收益明确时才值得切换。前端框架不是本次重定位的关键架构决策，不应消耗最初迭代的主要精力。

### 8.3 何时考虑 Tauri

只有同时出现以下条件时，才重新评估 Tauri：

- 已经决定不提供 App 内同 Session 的页面介入；
- Agent 浏览始终由独立 Managed Chrome 承担；
- 安装包、空闲内存或启动时间存在可量化且 Electron 无法达到的硬指标；
- 团队愿意长期维护 Rust command、Node/Python sidecar 与系统 WebView 的组合。

否则，“Tauri UI + Node Agent + Managed Chrome”通常只是把一个运行时拆成三套运行时，不一定带来整体轻量化。

### 8.4 何时引入其他语言

首个版本不应因为 Agent 逻辑复杂就默认使用 Rust 或 Python。复杂业务逻辑更需要清晰边界和状态模型，而不是另一种语言。

- Rust：仅在性能剖析证明索引、OCR、媒体处理、本地推理或沙箱边界需要时引入；
- Python：仅作为实验性模型/数据 Worker，使用版本化协议隔离；
- 核心领域、IPC 协议、扩展和 UI：默认保持 TypeScript。

### 8.5 数据层

SQLite 适合本地优先的结构化目录、关系和运行记录，但必须放在 Repository 边界后。正文或大对象可以采用文件存储，SQLite 保存索引和元数据。具体 Driver 应在新仓库创建小型 Spike 后决定，不要把实验性 API 直接暴露为领域契约。

## 9. 建议的新仓库结构

起始结构可以是：

```text
apps/
  desktop/             # Electron shell and Workbench UI
  extension/           # Chrome extension
packages/
  domain/              # product concepts, policies, state machines
  protocol/            # versioned IPC and extension messages
  context-store/       # persistence and repositories
  agent-runtime/       # runs, tools, interruption and recovery
  browser-runtime/     # embedded/managed browser adapters
  identity/            # identity metadata, profile policy, credential refs
  observability/       # audit, trace and redaction
tests/
  fixtures/
  evals/
docs/
  product/
  architecture/
  decisions/
  migration/
```

这不是要求在第一天创建十几个空 Package。只有当模块确实拥有独立生命周期、不变量和测试边界时才拆包；小型实现可以先在同一 Package 内以清晰目录存在。

## 10. MVP 与实施顺序

### Phase 0：建立新仓库契约

- 写明产品承诺、非目标和核心词汇；
- 建立架构边界、身份安全不变量和最小测试注册表；
- 记录目标平台与最低性能预算；
- 为旧仓库记录固定 commit/tag，建立 migration ledger；
- 搭建最小 Electron App、typed IPC 和本地持久化测试。

### Phase 1：Context Workbench 纵向切片

完成一个可以端到端使用的最小流程：

1. 用户创建 Topic；
2. 添加一个 URL、文本或本地文件来源；
3. 与 Agent 讨论；
4. 检查本次 Context Packet 及出处；
5. 保存结论并在新会话中恢复；
6. 导出相关数据。

本阶段先证明“减少重复解释背景”这一产品价值，不依赖完整浏览器自动化。

### Phase 2：Chrome 扩展

- 显式捕获当前页面、选区、标题、URL 和备注；
- 快捷键/右键菜单发送到既有 Topic 或新讨论；
- 显示本次将发送什么，并提供权限反馈；
- 建立本地配对、鉴权、断线重连和协议版本检查；
- 不默认持续采集浏览历史。

### Phase 3：Agent Runtime

- 实现可中断、可恢复、可审计的 Run；
- 工具调用必须携带 Actor、Scope 和 Permission Context；
- 结果关联原始来源和运行证据；
- 将浏览器执行隐藏在 Browser Runtime 接口后。

### Phase 4：Agent Identity 与浏览器介入

- 创建、选择、停用和删除 Agent Identity；
- 管理隔离 Browser Profile；
- 默认后台执行，Workbench 展示状态与关键证据；
- 在 App 内打开同 Session 页面供用户接管；
- 对不兼容站点提供 Managed Chrome fallback；
- 验证接管互斥、交还控制、凭证脱敏和 Profile 清理。

## 11. 首个版本明确不做

- 完整浏览器 Shell；
- Chrome 标签页/地址栏/书签/历史记录/下载功能的复刻；
- 把 Agent 页面实时投影进用户现有 Chrome 标签页；
- 视觉小模型驱动的通用页面理解；
- 默认记录用户的全部浏览行为；
- 无确认的高风险自主操作；
- 为未来可能出现的多租户、云同步或多 Agent 群体预建复杂平台；
- 一次性迁移旧仓库的全部数据、文档、测试和 UI。

## 12. 如何参考旧仓库

### 12.1 参考原则

旧仓库是 prior art，不是新项目依赖项：

- 不把旧仓库作为 Git submodule、运行时依赖或共享源码目录；
- 不假设旧仓库文档仍代表新产品决策；
- 不为了兼容旧数据形状而污染新项目的永久契约；
- 不按目录整体复制；先写新契约，再按具体问题提取最小机制；
- 参考旧功能时同时检查设计文档、实现和测试；三者不一致时，只把它当作待分析的历史事实；
- 每次迁移都在新仓库记录来源 commit、采用部分、舍弃部分和验证证据。

本文已经作为新仓库的 bootstrap reference。当前链接指向同级目录中的本地旧仓库；在旧仓库建立固定 commit/tag 或移动归档位置后，应同步更新这些引用。新项目一旦形成自己的正式产品与架构文档，应以新仓库文档为唯一 source of truth。

### 12.2 推荐阅读地图

| 新项目关注点 | 旧仓库文档 | 旧仓库实现线索 | 应吸收什么 | 不应照搬什么 |
| --- | --- | --- | --- | --- |
| 历史产品假设 | [Product Design](../../../oyster-browser/docs/design-vault/current/product-design.md)、[System Architecture](../../../oyster-browser/docs/design-vault/current/system-architecture.md) | `../oyster-browser/src/main/app/create-main-window.ts`、`../oyster-browser/src/main/internal-pages/` | 理解浏览器优先方向为何形成 | 把浏览器外壳继续当产品主体 |
| Agent 身份 | [Agent Principles](../../../oyster-browser/docs/design-vault/current/agent-principles.md)、[Browser Core](../../../oyster-browser/docs/design-vault/current/browser-core.md) | `../oyster-browser/src/main/services/browser-core-service.ts`、`../oyster-browser/src/main/services/tab-service.ts` | 身份隔离、Profile 所有权、审计思想 | 让身份生命周期依附于 Tab 实现 |
| Context 组装 | [Agent Runtime](../../../oyster-browser/docs/design-vault/current/agent-runtime.md)、[Agent Implementation](../../../oyster-browser/docs/design-vault/current/agent-implementation.md) | `../oyster-browser/src/main/services/agent-context-builder.ts` | 显式 Context 构建、来源与脱敏经验 | 把页面运行时状态直接当长期知识模型 |
| Agent 协作与变更审查 | [Agent Overview](../../../oyster-browser/docs/design-vault/current/agent-overview.md) | `../oyster-browser/src/main/services/agent-edit-proposal-service.ts` | Proposal、审查、重新校验的思想 | 复制庞大的浏览器耦合 Agent Loop |
| Knowledge / Read Later | [Knowledge](../../../oyster-browser/docs/design-vault/current/knowledge.md)、[Read Later Capture](../../../oyster-browser/docs/design-vault/current/read-later-capture.md) | `../oyster-browser/src/main/services/oyster-database-service.ts` 及 Read Later 相关服务 | Data、Knowledge、Feed 的区分；采集与出处 | 复制混合多个领域的大型数据库 Service |
| 页面提取与评测 | [Page Perception](../../../oyster-browser/docs/design-vault/current/perception.md) 及其 Evidence 子文档 | 旧仓库的页面感知、提取和 eval 相关服务/fixture | 真实网页案例、失败样本、评测方法 | 整体迁移视觉感知管线或实验模型 |
| 测试治理 | [Testing](../../../oyster-browser/docs/design-vault/current/testing.md) | `../oyster-browser/tests/test-matrix.json`、`../oyster-browser/scripts/run-tests.mjs` | 注册式测试、证据路径和分层 Gate | 携带所有浏览器 Shell 专用回归测试 |
| UI 经验 | [UI Design Standards](../../../oyster-browser/docs/design-vault/current/ui-design-standards.md) | 旧仓库的 Renderer 与 Design Hub 相关组件 | 已验证的协作界面细节和可读性经验 | Chrome 风格 Shell 及其结构约束 |

### 12.3 值得优先提取的资产

可优先研究，但仍需重新验证：

- `../oyster-browser/src/main/services/agent-context-builder.ts` 中相对独立的 Context 构建与预算思想；
- `../oyster-browser/src/main/services/agent-edit-proposal-service.ts` 中 Proposal、校验和 Apply 边界；
- trace redaction、审计和运行证据相关逻辑；
- Read Later 的来源记录、提取结果和真实页面 fixture；
- 与身份/Profile 隔离有关的故障案例和测试；
- `../oyster-browser/tests/test-matrix.json` 与统一 runner 的治理方法。

### 12.4 应优先重写的部分

- Agent Run 状态机与工具权限上下文；
- Context Store 与 Repository 边界；
- 身份、Profile 和 Credential Reference 模型；
- Browser Runtime adapter；
- Chrome 扩展与桌面 App 的本地协议；
- Main/Worker/Renderer 的进程边界；
- 数据导出、删除、恢复和审计契约。

### 12.5 不应迁移的部分

- 浏览器 Shell 及其标签页、地址栏、书签、历史记录和下载 UI；
- Chrome 导入与成为默认浏览器相关能力；
- 视觉小模型与页面定位实验的完整实现；
- 为旧浏览器架构服务的大型 Service 和兼容分支；
- 运行时 Design Hub 本身；新仓库应保留文档治理思想，但不必把设计文档做成产品内页面；
- 仅用于旧架构的 debug/eval 面板和测试矩阵条目。

## 13. 迁移协议

任何从旧仓库复用的内容都应经过以下步骤：

1. 在新仓库先写清楚要解决的问题、所有者、不变量和验收标准；
2. 固定旧仓库来源 commit，并找到对应设计、实现和测试；
3. 将旧行为整理为最小 fixture 或 characterization test；
4. 列出旧实现的 Electron、数据库、全局状态和浏览器 Shell 依赖；
5. 只提取符合新边界的最小算法、类型或测试数据；
6. 根据新领域模型重写 adapter，不复制兼容层；
7. 用新项目的测试验证行为、性能和安全不变量；
8. 在 migration ledger 记录 Adopt、Adapt、Reject 结论和删除路径。

推荐的 ledger 字段：

```text
Source commit/path
Problem being solved
Decision: Adopt | Adapt | Reject
Imported behavior/data
Intentionally omitted behavior
New owner and lifecycle
Verification command/evidence
Temporary compatibility and removal condition
```

## 14. 新仓库必须先建立的文档与 Gate

新项目开始编码前，至少创建：

- `AGENTS.md`：短小、稳定的仓库原则；
- `docs/product/product-brief.md`：定位、目标用户、承诺、核心流程和非目标；
- `docs/architecture/system.md`：进程、模块、所有者和接口；
- `docs/architecture/context-and-data.md`：数据真相、投影、出处与生命周期；
- `docs/architecture/identity-and-security.md`：身份、Profile、凭证、权限和介入不变量；
- `docs/decisions/`：记录会长期影响系统的 ADR；
- `docs/migration/old-repo-ledger.md`：旧仓库资产采纳记录；
- 一个注册式测试入口：列出单元、契约、集成、E2E 和安全 Gate；
- 一个可以本地运行的最小 smoke profile。

每个新增概念都必须能够回答：谁拥有它、何时创建和销毁、什么是不变量、如何验证。回答不了时，不要先把它做成新的抽象、模式、Registry 或 Policy 对象。

## 15. 新仓库启动完成的定义

完成 Bootstrap/MVP 不能只以“窗口能打开”判断。至少应满足：

- 产品文档明确声明 Oyster 不是独立浏览器；
- Workbench 可以创建 Topic、加入来源并开始对话；
- 一次对话能展示可检查的 Context Packet 与 provenance；
- 关闭并重启 App 后，讨论与来源可恢复；
- Chrome 扩展可以通过用户显式动作发送页面或选区；
- 扩展协议有版本、鉴权和断线失败状态；
- 至少一个 Agent Identity 能绑定隔离 Profile 完成低风险网页任务；
- 用户可以在 App 内接管同一页面，且接管期间 Agent 不操作；
- Agent 与用户 Chrome 的 cookie 隔离有自动化证据；
- 日志、模型输入和导出数据中的敏感字段有脱敏测试；
- 所有核心测试通过统一入口运行，并输出可定位的报告；
- 新仓库不在运行时依赖旧仓库。

## 16. 需要在实践中继续回答的问题

以下问题不应阻塞新仓库创建，但应通过 Spike 或真实用户流程尽早收敛：

- 首发是否只支持 macOS，何时支持 Windows/Linux；
- “轻量”对应的硬指标：安装体积、冷启动、空闲内存还是后台耗电；
- Topic、Project 与 Workspace 是否真的需要成为三个独立概念；
- Agent Browser 首选 Embedded Chromium 还是 Managed Chrome，哪些网站必须走 fallback；
- Chrome 扩展默认权限、按站点授权和捕获预览如何设计；
- 长期记忆的形成由用户显式确认、自动建议还是规则驱动；
- 哪些数据只保留本地，未来云同步的加密和身份边界是什么；
- 旧仓库的用户数据是否需要导入，以及导入是否值得承担兼容成本；
- 如何用真实任务衡量“减少用户重复解释背景”，而不只衡量模型回答质量。

这些问题的答案可能改变实现，但不能改变两条底线：Oyster 拥有统一上下文的责任；Oyster 拥有独立 Agent 身份的责任。

## 17. 给新项目开发 Agent 的起始指令

在新仓库工作时按以下顺序进行：

1. 先阅读本文并把它转化为新仓库的正式 Product Brief；
2. 明确哪些内容是已决定事项，哪些仍是待验证假设；
3. 建立最小领域词汇、数据所有权和安全不变量；
4. 先实现 Phase 1 的 Context Workbench 纵向切片；
5. 只有遇到具体问题时才回到旧仓库查找 prior art；
6. 复用前执行迁移协议，不做目录级复制；
7. 任何让产品重新滑向“完整浏览器”的重大设计，先说明用户价值、成本和替代方案，再请求确认；
8. 每个阶段以可运行流程、注册测试和具体证据结束。

最重要的判断标准不是“复用了多少旧代码”，而是新仓库是否用更少、更清楚的概念，真正降低了用户与 AI 协作时搬运上下文的成本。
