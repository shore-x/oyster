# AI Connection 与模型选择

## 概念边界

Oyster 将模型的认证与计费通道同 Agent 执行分开：

- Provider 是模型能力的来源；
- Connection 是用户授权的一条认证、传输和计费通道；
- Model 是该 Connection 可调用的模型；
- Default LLM 是新任务或对话默认捕获的 Connection、Model 与可选思考强度。

Connection 不等于 Model，Coding Plan 也不是 Agent Runtime。Agent Runtime 消费已经选定的模型能力，Observation 来自哪里同使用哪个模型加工也没有绑定关系。

## 为什么采用这一模型

用户可能使用订阅额度，也可能使用 API Key 或兼容端点。保持 Connection 独立，可以明确费用与凭据来源，并让每个新 Chat Conversation 或 Knowledge Task 固定自己的选择，避免默认值变化静默改变正在进行的工作。

当前支持 Codex Coding Plan 与 OpenAI-compatible API。实际 Provider transport 尽量复用 Pi 生态成熟实现，避免 Oyster 自己维护平行的流协议、重试和 payload 转换。

## 选择与验证

应用保存一个默认选择，但不会自动换到其他 Connection、Model 或计费来源。未知或自定义 Model 的能力不靠静态目录推断；在连接测试或实际调用时验证可用性即可。

凭据由主进程与系统 Keychain 持有，不进入 Renderer、Prompt 或配置文件。Oyster 自己完成需要的授权，不扫描或复用其他 Agent Runtime 的 token。本地 Debug Record 可能包含请求上下文与 Provider 信息，因此只承诺采用简洁、成熟的 credential 过滤，不把它描述为无敏感数据日志。

精确认证流程、Provider 参数、错误映射、重试数和模型目录行为由当前代码与测试维护。
