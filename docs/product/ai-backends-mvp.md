# AI Backend MVP

> 状态：当前实现规格
>
> 范围：支持 Codex Coding Plan 与 OpenAI-compatible API 的连接、认证、模型选择、思考强度和受控调用。

## 1. 核心模型

AI Backend 是 Oyster 获得模型调用能力的边界。MVP 只区分两种计费与认证通道：

- **Coding Plan**：使用用户已有的订阅额度；
- **API**：使用用户配置的 Provider API 账户或自定义端点。

四个概念保持独立：

- **Provider** 表示能力来源；
- **Connection** 表示认证、传输与计费通道；
- **Model** 表示该 Connection 当前可调用的具体模型；
- **Stage Configuration** 表示某个处理阶段明确选择的 Connection、Model 和可选思考强度。

Connection 不等于 Model。同一个 Connection 可以暴露多个 Model，Observation Preprocessor 与 Knowledge Maintenance Agent 可以分别选择不同组合。Direct Model Call 或 Pi Agent Core 是阶段的执行 Runtime，不是另一类 Backend。

Agent 数据来源与 AI Connection 也是两个独立概念。不建立 Subscription 领域对象；套餐和账号信息只是认证后显示的 Connection 上下文。

## 2. MVP 支持范围

| Backend | Provider | 认证 | 模型目录 |
| --- | --- | --- | --- |
| Coding Plan | OpenAI Codex | Oyster 发起 OAuth，结构化凭据保存在系统 Keychain | Pi Provider 提供的 Codex 模型目录 |
| API | OpenAI | API Key 保存在系统 Keychain | 标准 `GET /models` |
| API | OpenAI-compatible | 可选 API Key；自定义 Base URL 与协议 | 标准 `GET /models`，不支持时可手填 Model ID |

Oyster 可以通过官方 Codex App Server发现本机 Runtime、账号和 Plan，帮助用户识别已有订阅；发现结果不授予调用权限。实际模型调用使用 Oyster 自己完成的 OAuth，不读取、复制或复用 Codex Runtime 的 token。

API 模型发现结果和 Coding Plan 模型目录是可重建的运行时索引，不是新的权威配置。API Connection 仍保存一个默认 Model，阶段配置保存实际选择的 Model ID；刷新后若 Model 已不可用，界面会明确显示配置失效，不会静默替换。

## 3. UI 与选择规则

设置页先选择 Coding Plan 或 API，再展示与其兼容的 Provider，不提供任意笛卡尔组合。每条 Connection 都展示：

- Backend、Provider、认证状态与计费上下文；
- API Endpoint / Protocol，或 Coding Plan 的 Account / Plan；
- 当前可用 Model；
- 测试实际使用的 Model 与思考强度。

知识加工的每个阶段独立保存 Connection、Model、可选思考强度和 Prompt 覆盖。界面必须同时展示阶段 Runtime，避免把 Pi Agent Core 与 Backend 混为一谈。

只有模型明确声明支持的思考强度才可选择；“模型默认”不发送额外参数。系统不猜测未知或自定义模型的能力。测试与正式运行都只使用用户明确选择的组合，不自动选择或回退到其他 Connection、Model 或计费来源。

## 4. 执行与安全边界

主进程负责本机发现、OAuth、Keychain、模型目录与实际调用；Renderer 只通过 typed preload API 获得脱敏状态。OAuth URL 由主进程直接交给系统浏览器，token 不经过 Renderer。API Key 首次输入时只经受信 IPC 用于发现或保存，之后不进入配置文件、日志、Prompt、Agent transcript 或 IPC 返回。

Coding Plan 的直接生成和 Pi Agent Core 都复用同一个已选 Model 与 Pi model stream，因此不会为了使用订阅再嵌套一个外部 Coding Agent loop。角色能够读取的 Observation、Knowledge 与工具仍由 Oyster 当前运行授予，与 Backend 类型无关。

自定义远程 URL 默认必须使用 HTTPS；只有用户显式填写的 localhost 端点可以使用 HTTP。模型请求固定到所选端点，拒绝重定向，并限制超时、响应大小和调用次数。连接失效只影响该 Connection；应用可以继续启动，也不会自动切换计费来源。

## 5. 当前不做

- Claude Pro/Max 或消费者 Gemini 订阅复用；
- 扫描、导入或读取第三方 Runtime 凭据；
- 任意 OAuth Provider 与任意自定义 Header；
- 自动选择或自动回退 Backend / Model；
- 持久化一份不可重建的全局模型目录；
- 完整用量与账单管理。
