import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type {
  AiBackendKind,
  AiConnection,
  AvailableModel,
  LlmBinding,
  ModelProtocol,
  ModelProviderId,
  ReasoningEffort,
  TestConnectionInput
} from '../../../shared/ai-backends'
import { createAiBackendsController } from '../ai-backends-controller'
import { Button, Icon } from '../ui'

const STATUS: Record<AiConnection['status'], { label: string; tone: string }> = {
  not_found: { label: '未安装', tone: 'warning' },
  needs_auth: { label: '需要登录', tone: 'warning' },
  authenticating: { label: '等待登录', tone: 'active' },
  unverified: { label: '未测试', tone: '' },
  ready: { label: '可用', tone: 'success' },
  unsupported: { label: '当前方式不支持', tone: 'warning' },
  unavailable: { label: '暂时不可用', tone: 'danger' }
}

function authenticationExpiry(value?: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function modelLabel(model: AvailableModel | undefined, fallback = '—'): string {
  if (!model) return fallback
  return model.displayName === model.id ? model.id : `${model.displayName} · ${model.id}`
}

function StatusBadge(props: { connection: AiConnection }) {
  const value = () => STATUS[props.connection.status]
  return (
    <span class={`status${value().tone ? ` status--${value().tone}` : ''}`}>
      <span class="status__dot" />{value().label}
    </span>
  )
}

export function CodingPlanAuthenticationState(props: {
  connection: AiConnection
  onCancel(): void
}) {
  return (
    <div class="ai-authentication-state" data-testid="coding-plan-authentication-state">
      <Show
        when={props.connection.authentication?.loginMethod === 'device_code'}
        fallback={(
          <>
            <strong>等待浏览器登录</strong>
            <p>请在系统浏览器中完成 ChatGPT 登录。若页面仍然报错，可以取消后改用设备码。</p>
          </>
        )}
      >
        <strong>使用设备码完成登录</strong>
        <p>请在浏览器中打开下面的验证地址并输入设备码；远程开发环境也可以在另一台设备上完成。</p>
        <div class="ai-device-code">
          <span>设备码</span>
          <code data-testid="coding-plan-device-code">
            {props.connection.authentication?.userCode || '正在申请…'}
          </code>
        </div>
        <Show when={props.connection.authentication?.verificationUri}>
          <div class="ai-device-verification-uri">
            <span>验证地址</span>
            <code>{props.connection.authentication?.verificationUri}</code>
          </div>
        </Show>
        <Show when={authenticationExpiry(props.connection.authentication?.expiresAt)}>
          {(expiresAt) => <p>设备码预计在 {expiresAt()} 失效。</p>}
        </Show>
      </Show>
      <div class="ai-authentication-state__actions">
        <Button
          variant="secondary"
          icon="stop"
          data-testid="coding-plan-cancel-login-button"
          onClick={props.onCancel}
        >取消登录</Button>
      </div>
    </div>
  )
}

function ApiConnectionCard(props: {
  connection: AiConnection
  busy?: string
  onTest(input: TestConnectionInput): void
  onRemove(): void
}) {
  const config = () => props.connection.modelConfig!
  const [modelId, setModelId] = createSignal('')
  const [reasoningEffort, setReasoningEffort] = createSignal<ReasoningEffort>()
  const models = createMemo<AvailableModel[]>(() => {
    if (props.connection.models.length > 0) return props.connection.models
    return [{
      id: config().model,
      displayName: config().model,
      reasoningEfforts: config().reasoningEfforts ?? []
    }]
  })
  const selectedModel = createMemo(() => {
    const preferred = modelId() || props.connection.defaultModelId || config().model
    return models().find((candidate) => candidate.id === preferred) ?? models()[0]
  })
  const selectedReasoningEffort = createMemo(() => {
    const selected = reasoningEffort()
    return selected && selectedModel()?.reasoningEfforts.includes(selected) ? selected : undefined
  })

  createEffect(() => {
    const available = models()
    const current = modelId()
    if (current && available.some((candidate) => candidate.id === current)) return
    setModelId(
      available.find((candidate) => candidate.id === props.connection.defaultModelId)?.id
        ?? available[0]?.id
        ?? ''
    )
    setReasoningEffort(undefined)
  })

  function chooseModel(value: string): void {
    setModelId(value)
    setReasoningEffort(undefined)
  }

  function testConnection(): void {
    const selected = selectedModel()
    if (!selected) return
    props.onTest({
      connectionId: props.connection.id,
      modelId: selected.id,
      reasoningEffort: selectedReasoningEffort()
    })
  }

  return (
    <article
      class="ai-connection-card"
      data-testid="model-connection-card"
      data-connection-id={props.connection.id}
    >
      <div class="ai-connection-card__header">
        <div class="agent-mark agent-mark--model">M</div>
        <div class="ai-connection-card__identity">
          <h3>{props.connection.displayName}</h3>
          <div class="path">{config().baseUrl}</div>
        </div>
        <StatusBadge connection={props.connection} />
      </div>
      <details class="ai-connection-card__details ui-disclosure">
        <summary>配置与额度测试</summary>
        <div class="ui-disclosure__content">
          <dl class="ai-connection-details">
            <div><dt>Backend</dt><dd>API</dd></div>
            <div><dt>Protocol</dt><dd>{config().protocol === 'openai_responses' ? 'Responses' : 'Chat Completions'}</dd></div>
            <div><dt>API Key</dt><dd>{config().hasApiKey ? '已保存到 Keychain' : '未配置'}</dd></div>
          </dl>
          <div class="ai-model-form__row">
            <label class="ai-field">
              <span>测试模型</span>
              <select
                data-testid="api-connection-model-select"
                value={selectedModel()?.id ?? ''}
                onChange={(event) => chooseModel(event.currentTarget.value)}
              >
                <For each={models()}>{(candidate) => (
                  <option value={candidate.id}>{modelLabel(candidate)}</option>
                )}</For>
              </select>
            </label>
            <label class="ai-field">
              <span>思考强度</span>
              <select
                data-testid="api-connection-reasoning-select"
                value={selectedReasoningEffort() ?? ''}
                disabled={!selectedModel()?.reasoningEfforts.length}
                onChange={(event) => setReasoningEffort(
                  event.currentTarget.value
                    ? event.currentTarget.value as ReasoningEffort
                    : undefined
                )}
              >
                <option value="">模型默认</option>
                <For each={selectedModel()?.reasoningEfforts ?? []}>{(effort) => (
                  <option value={effort}>{effort}</option>
                )}</For>
              </select>
            </label>
          </div>
          <p class="path" data-testid="api-connection-test-configuration">
            点击后将直接发起一条不含项目数据的测试调用，可能消耗 Provider API 额度；状态与结果会显示在本页。将使用 {modelLabel(selectedModel())}
            {selectedReasoningEffort() ? ` · ${selectedReasoningEffort()}` : ' · 模型默认思考强度'}
          </p>
          <Show when={props.connection.errorMessage}>
            <p class="ai-connection-error">{props.connection.errorMessage}</p>
          </Show>
          <div class="ai-connection-card__actions">
            <Button
              variant="danger"
              icon="trash"
              disabled={Boolean(props.busy)}
              onClick={props.onRemove}
            >删除</Button>
            <Button
              variant="secondary"
              icon="play"
              data-testid="api-connection-test-button"
              disabled={Boolean(props.busy) || !selectedModel()}
              onClick={testConnection}
            >{props.busy?.startsWith('test:') ? '测试中…' : '运行额度测试'}</Button>
          </div>
        </div>
      </details>
    </article>
  )
}

export function AiBackendsPage(props: { embedded?: boolean } = {}) {
  const controller = createAiBackendsController()
  const [backendKind, setBackendKind] = createSignal<AiBackendKind>('coding_plan')
  const [providerId, setProviderId] = createSignal<'openai_codex' | ModelProviderId>('openai_codex')
  const [baseUrl, setBaseUrl] = createSignal('http://localhost:11434/v1')
  const [protocol, setProtocol] = createSignal<ModelProtocol>('openai_responses')
  const [model, setModel] = createSignal('')
  const [apiKey, setApiKey] = createSignal('')
  const [availableModels, setAvailableModels] = createSignal<AvailableModel[]>([])
  const [codingPlanModelId, setCodingPlanModelId] = createSignal('')
  const [codingPlanReasoningEffort, setCodingPlanReasoningEffort] = createSignal<ReasoningEffort>()
  const [defaultConnectionId, setDefaultConnectionId] = createSignal('')
  const [defaultModelId, setDefaultModelId] = createSignal('')
  const [defaultReasoningEffort, setDefaultReasoningEffort] = createSignal<ReasoningEffort>()

  const codex = createMemo(() => controller.snapshot().connections.find(
    (connection) => connection.backendKind === 'coding_plan' && connection.providerId === 'openai_codex'
  ))
  const apiConnections = createMemo(() => controller.snapshot().connections.filter(
    (connection) => connection.backendKind === 'api'
  ))
  const selectedCodingPlanModel = createMemo(() => {
    const connection = codex()
    if (!connection) return undefined
    const preferred = codingPlanModelId() || connection.defaultModelId
    return connection.models.find((candidate) => candidate.id === preferred) ?? connection.models[0]
  })
  const selectedCodingPlanReasoningEffort = createMemo(() => {
    const selected = codingPlanReasoningEffort()
    return selected && selectedCodingPlanModel()?.reasoningEfforts.includes(selected)
      ? selected
      : undefined
  })
  const readyCount = createMemo(() => controller.snapshot().connections.filter((connection) => connection.status === 'ready').length)
  const defaultConnection = createMemo(() => controller.snapshot().connections.find(
    (connection) => connection.id === defaultConnectionId()
  ))
  const defaultModel = createMemo(() => defaultConnection()?.models.find(
    (candidate) => candidate.id === defaultModelId()
  ))
  const effectiveDefaultReasoning = createMemo(() => {
    const effort = defaultReasoningEffort()
    return effort && defaultModel()?.reasoningEfforts.includes(effort) ? effort : undefined
  })
  const defaultReasoningSupported = createMemo(() => {
    const effort = defaultReasoningEffort()
    return !effort || Boolean(defaultModel()?.reasoningEfforts.includes(effort))
  })
  const savedDefaultLlmValid = createMemo(() => {
    const binding = controller.snapshot().defaultLlm
    if (!binding) return false
    const connection = controller.snapshot().connections.find((candidate) => candidate.id === binding.connectionId)
    const selectedModel = connection?.models.find((candidate) => candidate.id === binding.modelId)
    return Boolean(
      selectedModel
      && (!binding.reasoningEffort || selectedModel.reasoningEfforts.includes(binding.reasoningEffort))
    )
  })

  let synchronizedDefaultLlm: string | undefined
  createEffect(() => {
    const binding = controller.snapshot().defaultLlm
    const revision = JSON.stringify(binding ?? null)
    if (revision === synchronizedDefaultLlm) return
    synchronizedDefaultLlm = revision
    setDefaultConnectionId(binding?.connectionId ?? '')
    setDefaultModelId(binding?.modelId ?? '')
    setDefaultReasoningEffort(binding?.reasoningEffort)
  })

  createEffect(() => {
    const connection = codex()
    if (!connection) return
    const current = codingPlanModelId()
    if (current && connection.models.some((candidate) => candidate.id === current)) return
    setCodingPlanModelId(
      connection.models.find((candidate) => candidate.id === connection.defaultModelId)?.id
        ?? connection.models[0]?.id
        ?? ''
    )
    setCodingPlanReasoningEffort(undefined)
  })

  function chooseBackend(value: AiBackendKind): void {
    setBackendKind(value)
    setProviderId(value === 'coding_plan' ? 'openai_codex' : 'openai')
    setAvailableModels([])
    setModel('')
  }

  function chooseProvider(value: 'openai_codex' | ModelProviderId): void {
    setProviderId(value)
    setAvailableModels([])
    setModel('')
  }

  async function discoverModels(): Promise<void> {
    if (providerId() === 'openai_codex') return
    const result = await controller.discoverModels({
      providerId: providerId() as ModelProviderId,
      baseUrl: providerId() === 'openai' ? 'https://api.openai.com/v1' : baseUrl(),
      apiKey: apiKey()
    })
    if (!result) return
    setAvailableModels(result.models)
    if (result.models.length && !result.models.some((candidate) => candidate.id === model())) {
      setModel(result.models[0].id)
    }
  }

  async function saveModel(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (providerId() === 'openai_codex') return
    const saved = await controller.saveModelConnection({
      providerId: providerId() as ModelProviderId,
      protocol: protocol(),
      baseUrl: providerId() === 'openai' ? 'https://api.openai.com/v1' : baseUrl(),
      model: model(),
      apiKey: apiKey()
    })
    if (saved) {
      setModel('')
      setApiKey('')
    }
  }

  function chooseCodingPlanModel(value: string): void {
    setCodingPlanModelId(value)
    setCodingPlanReasoningEffort(undefined)
  }

  function testCodingPlan(connection: AiConnection): void {
    const selected = selectedCodingPlanModel()
    if (!selected) return
    void controller.testConnection({
      connectionId: connection.id,
      modelId: selected.id,
      reasoningEffort: selectedCodingPlanReasoningEffort()
    })
  }

  function chooseDefaultConnection(connectionId: string): void {
    const connection = controller.snapshot().connections.find((candidate) => candidate.id === connectionId)
    setDefaultConnectionId(connection?.id ?? '')
    setDefaultModelId(
      connection?.models.find((candidate) => candidate.id === connection.defaultModelId)?.id
        ?? connection?.models[0]?.id
        ?? ''
    )
    setDefaultReasoningEffort(undefined)
  }

  function saveDefaultLlm(): void {
    const connection = defaultConnection()
    const selectedModel = defaultModel()
    if (!connection || !selectedModel) return
    const binding: LlmBinding = {
      connectionId: connection.id,
      modelId: selectedModel.id,
      ...(effectiveDefaultReasoning() ? { reasoningEffort: effectiveDefaultReasoning() } : {})
    }
    void controller.saveDefaultLlm(binding)
  }

  return (
    <>
      <Show when={!props.embedded}>
        <header class="page-header">
          <div>
            <h1>AI 后端</h1>
            <div class="page-summary">
              <span><strong>{readyCount()}</strong> 个可用连接</span>
              <span class="page-summary__separator">·</span>
              <span>{controller.snapshot().connections.length} 个已发现或已配置</span>
            </div>
          </div>
          <Button
            variant="secondary"
            icon="refresh"
            onClick={() => void controller.refresh()}
            disabled={Boolean(controller.busy())}
          >{controller.busy() === 'refresh' ? '检查中…' : '刷新状态'}</Button>
        </header>
      </Show>

      <Show when={controller.error()}>
        <div class="page-error"><Icon name="warning" />{controller.error()}</div>
      </Show>
      <Show when={controller.snapshot().configurationError}>
        <div class="page-error"><Icon name="warning" />{controller.snapshot().configurationError}</div>
      </Show>
      <Show when={controller.testResult()}>
        {(result) => (
          <div class="ai-test-result" data-testid="connection-test-result">
            <Icon name="check" />
            {controller.snapshot().connections.find((connection) => connection.id === result().connectionId)?.displayName || '连接'}
            测试成功（模型：{controller.testedConfiguration()?.modelId || '—'}
            {controller.testedConfiguration()?.reasoningEffort
              ? ` · ${controller.testedConfiguration()?.reasoningEffort}`
              : ' · 模型默认思考强度'}）：{result().output}
          </div>
        )}
      </Show>

      <section class="ai-runtime-panel" data-testid="default-llm-panel">
        <div class="ai-runtime-panel__header">
          <div>
            <h2>默认 LLM</h2>
            <p>Knowledge Maintainer 和新建 Chat Conversation 使用这里保存的模型；已有 Chat Conversation 保留创建时的模型。</p>
          </div>
          <Show when={controller.snapshot().defaultLlm} fallback={<span class="status status--warning"><span class="status__dot" />未配置</span>}>
            <span class={`status ${savedDefaultLlmValid() ? 'status--success' : 'status--warning'}`}><span class="status__dot" />{savedDefaultLlmValid() ? '已配置' : '配置失效'}</span>
          </Show>
        </div>
        <div class="ai-model-form__row">
          <label class="ai-field">
            <span>Connection</span>
            <select
              data-testid="default-llm-connection-select"
              value={defaultConnectionId()}
              disabled={Boolean(controller.busy())}
              onChange={(event) => chooseDefaultConnection(event.currentTarget.value)}
            >
              <option value="">选择 Connection</option>
              <For each={controller.snapshot().connections}>{(connection) => (
                <option
                  value={connection.id}
                  selected={connection.id === defaultConnectionId()}
                  disabled={connection.models.length === 0}
                >
                  {connection.displayName} · {STATUS[connection.status].label}
                </option>
              )}</For>
            </select>
          </label>
          <label class="ai-field">
            <span>Model</span>
            <select
              data-testid="default-llm-model-select"
              value={defaultModelId()}
              disabled={!defaultConnection() || Boolean(controller.busy())}
              onChange={(event) => {
                setDefaultModelId(event.currentTarget.value)
                setDefaultReasoningEffort(undefined)
              }}
            >
              <option value="">选择 Model</option>
              <For each={defaultConnection()?.models ?? []}>{(candidate) => (
                <option value={candidate.id} selected={candidate.id === defaultModelId()}>{modelLabel(candidate)}</option>
              )}</For>
            </select>
          </label>
          <label class="ai-field">
            <span>思考强度</span>
            <select
              data-testid="default-llm-reasoning-select"
              value={defaultReasoningEffort() ?? ''}
              disabled={Boolean(controller.busy()) || (!defaultModel()?.reasoningEfforts.length && !defaultReasoningEffort())}
              onChange={(event) => setDefaultReasoningEffort(
                event.currentTarget.value ? event.currentTarget.value as ReasoningEffort : undefined
              )}
            >
              <option value="">模型默认</option>
              <Show when={defaultReasoningEffort() && !defaultReasoningSupported()}>
                <option value={defaultReasoningEffort() ?? ''} selected disabled>{defaultReasoningEffort()} · 当前 Model 不支持</option>
              </Show>
              <For each={defaultModel()?.reasoningEfforts ?? []}>{(effort) => (
                <option value={effort} selected={effort === defaultReasoningEffort()}>{effort}</option>
              )}</For>
            </select>
          </label>
        </div>
        <p class="path" data-testid="default-llm-summary">
          {defaultConnection() && defaultModel()
            ? `${defaultConnection()!.displayName} · ${modelLabel(defaultModel())} · ${defaultReasoningSupported() ? (effectiveDefaultReasoning() ?? '模型默认思考强度') : `${defaultReasoningEffort()} · 当前 Model 不支持`}`
            : controller.snapshot().defaultLlm
              ? `已保存的默认 LLM 当前不可用：${controller.snapshot().defaultLlm!.connectionId} · ${controller.snapshot().defaultLlm!.modelId}`
              : '设置后，新的 Knowledge Processing Task、Agent Preview 与 Chat Conversation 将从这里取得模型配置。'}
        </p>
        <div class="ai-runtime-panel__actions">
          <Button
            variant="ghost"
            icon="trash"
            disabled={!controller.snapshot().defaultLlm || Boolean(controller.busy())}
            onClick={() => void controller.saveDefaultLlm(null)}
          >清除默认 LLM</Button>
          <Button
            variant="primary"
            icon="check"
            data-testid="save-default-llm"
            disabled={!defaultConnection() || !defaultModel() || !defaultReasoningSupported() || Boolean(controller.busy())}
            onClick={saveDefaultLlm}
          >{controller.busy() === 'save-default-llm' ? '保存中…' : '保存默认 LLM'}</Button>
        </div>
      </section>

      <details class="ai-builder ui-disclosure">
        <summary>
          <span class="ai-builder__summary">
            <strong>添加或连接 AI 后端</strong>
            <span>按需展开登录、模型与 API 配置。</span>
          </span>
        </summary>
        <div class="ai-builder__content ui-disclosure__content">
          <div class="ai-builder__selectors">
            <label class="ai-field">
              <span>执行方式</span>
              <select
                data-testid="backend-kind-select"
                value={backendKind()}
                onChange={(event) => chooseBackend(event.currentTarget.value as AiBackendKind)}
              >
                <option value="coding_plan">已有 Coding Plan</option>
                <option value="api">API</option>
              </select>
            </label>
            <label class="ai-field">
              <span>Provider</span>
              <select
                data-testid="provider-select"
                value={providerId()}
                onChange={(event) => chooseProvider(event.currentTarget.value as 'openai_codex' | ModelProviderId)}
              >
                <Show when={backendKind() === 'coding_plan'}>
                  <option value="openai_codex">OpenAI Codex</option>
                </Show>
                <Show when={backendKind() === 'api'}>
                  <option value="openai">OpenAI API</option>
                  <option value="openai_compatible">OpenAI-compatible</option>
                </Show>
              </select>
            </label>
          </div>

        <Show when={backendKind() === 'coding_plan' && codex()}>
          {(connection) => (
            <div class="ai-runtime-panel" data-testid="codex-runtime-card">
              <div class="ai-runtime-panel__header">
                <div>
                  <h2>OpenAI Codex Coding Plan</h2>
                  <p>通过 Oyster 独立 OAuth 使用已有订阅；测试会明确使用下方选中的模型与思考强度。</p>
                </div>
                <StatusBadge connection={connection()} />
              </div>
              <dl class="ai-runtime-details">
                <div><dt>Provider</dt><dd>OpenAI Codex</dd></div>
                <div><dt>本机 Codex 账号（仅发现）</dt><dd>{connection().accountLabel || '—'}</dd></div>
                <div><dt>本机 Plan（仅发现）</dt><dd>{connection().planType || '—'}</dd></div>
              </dl>
              <div class="ai-model-form__row">
                <label class="ai-field">
                  <span>测试模型</span>
                  <select
                    data-testid="coding-plan-model-select"
                    value={selectedCodingPlanModel()?.id ?? ''}
                    disabled={connection().models.length === 0}
                    onChange={(event) => chooseCodingPlanModel(event.currentTarget.value)}
                  >
                    <Show when={connection().models.length === 0}>
                      <option value="">暂无可用模型</option>
                    </Show>
                    <For each={connection().models}>{(candidate) => (
                      <option value={candidate.id}>{modelLabel(candidate)}</option>
                    )}</For>
                  </select>
                </label>
                <label class="ai-field">
                  <span>思考强度</span>
                  <select
                    data-testid="coding-plan-reasoning-select"
                    value={selectedCodingPlanReasoningEffort() ?? ''}
                    disabled={!selectedCodingPlanModel()?.reasoningEfforts.length}
                    onChange={(event) => setCodingPlanReasoningEffort(
                      event.currentTarget.value
                        ? event.currentTarget.value as ReasoningEffort
                        : undefined
                    )}
                  >
                    <option value="">模型默认</option>
                    <For each={selectedCodingPlanModel()?.reasoningEfforts ?? []}>{(effort) => (
                      <option value={effort}>{effort}</option>
                    )}</For>
                  </select>
                </label>
              </div>
              <p class="path" data-testid="coding-plan-test-configuration">
                点击后将直接发起一条不含项目数据的测试调用，可能消耗 Coding Plan 额度；状态与结果会显示在本页。将使用 {modelLabel(selectedCodingPlanModel(), '尚无可用模型')}
                {selectedCodingPlanReasoningEffort()
                  ? ` · ${selectedCodingPlanReasoningEffort()}`
                  : ' · 模型默认思考强度'}
              </p>
              <Show when={connection().errorMessage}>
                <p class="ai-connection-error">{connection().errorMessage}</p>
              </Show>
              <Show when={connection().status === 'authenticating'}>
                <CodingPlanAuthenticationState
                  connection={connection()}
                  onCancel={() => void controller.cancelConnect(connection().id)}
                />
              </Show>
              <div class="ai-runtime-panel__actions">
                <Show when={connection().status !== 'ready' && connection().status !== 'authenticating'}>
                  <Button
                    variant="primary"
                    icon="link"
                    disabled={Boolean(controller.busy()) || connection().status === 'not_found'}
                    data-testid="coding-plan-device-login-button"
                    onClick={() => void controller.connect(connection().id, 'device_code')}
                  >设备码登录（远程推荐）</Button>
                  <Button
                    variant="secondary"
                    icon="link"
                    disabled={Boolean(controller.busy()) || connection().status === 'not_found'}
                    data-testid="coding-plan-browser-login-button"
                    onClick={() => void controller.connect(connection().id, 'browser')}
                  >浏览器登录</Button>
                </Show>
                <Show when={connection().status === 'ready'}>
                  <Button
                    variant="secondary"
                    icon="play"
                    data-testid="coding-plan-test-button"
                    disabled={Boolean(controller.busy()) || !selectedCodingPlanModel()}
                    onClick={() => testCodingPlan(connection())}
                  >{controller.busy() === `test:${connection().id}` ? '测试中…' : '运行额度测试'}</Button>
                </Show>
              </div>
            </div>
          )}
        </Show>

        <Show when={backendKind() === 'api'}>
          <form class="ai-model-form" onSubmit={(event) => void saveModel(event)}>
            <Show when={providerId() === 'openai'}>
              <div class="ai-fixed-endpoint"><span>Base URL</span><code>https://api.openai.com/v1</code></div>
            </Show>
            <Show when={providerId() === 'openai_compatible'}>
              <label class="ai-field ai-field--wide">
                <span>Base URL</span>
                <input
                  value={baseUrl()}
                  onInput={(event) => {
                    setBaseUrl(event.currentTarget.value)
                    setAvailableModels([])
                  }}
                  required
                />
              </label>
            </Show>
            <label class="ai-field ai-field--wide">
              <span>API Key {providerId() === 'openai_compatible' ? '（本地端点可留空）' : ''}</span>
              <input
                type="password"
                autocomplete="off"
                value={apiKey()}
                onInput={(event) => {
                  setApiKey(event.currentTarget.value)
                  setAvailableModels([])
                }}
                required={providerId() === 'openai'}
                placeholder="仅保存到系统 Keychain"
              />
            </label>
            <div class="ai-model-form__actions">
              <Button
                type="button"
                variant="secondary"
                icon="refresh"
                data-testid="discover-models"
                disabled={Boolean(controller.busy()) || (providerId() === 'openai' && !apiKey().trim())}
                onClick={() => void discoverModels()}
              >{controller.busy() === 'discover-models' ? '正在获取…' : '获取可用模型'}</Button>
              <Show when={availableModels().length > 0}>
                <span class="path">已发现 {availableModels().length} 个模型</span>
              </Show>
            </div>
            <div class="ai-model-form__row">
              <label class="ai-field">
                <span>Protocol</span>
                <select value={protocol()} onChange={(event) => setProtocol(event.currentTarget.value as ModelProtocol)}>
                  <option value="openai_responses">Responses</option>
                  <option value="openai_chat_completions">Chat Completions</option>
                </select>
              </label>
              <label class="ai-field">
                <span>Model</span>
                <Show
                  when={availableModels().length > 0}
                  fallback={(
                    <input
                      data-testid="model-manual-input"
                      value={model()}
                      onInput={(event) => setModel(event.currentTarget.value)}
                      placeholder="输入 Model ID"
                      required
                    />
                  )}
                >
                  <select
                    data-testid="available-model-select"
                    value={availableModels().some((candidate) => candidate.id === model()) ? model() : '__manual__'}
                    onChange={(event) => setModel(event.currentTarget.value === '__manual__' ? '' : event.currentTarget.value)}
                  >
                    <For each={availableModels()}>{(candidate) => (
                      <option value={candidate.id}>{modelLabel(candidate)}</option>
                    )}</For>
                    <option value="__manual__">手动输入其他 Model ID…</option>
                  </select>
                  <Show when={!availableModels().some((candidate) => candidate.id === model())}>
                    <input
                      data-testid="model-manual-input"
                      value={model()}
                      onInput={(event) => setModel(event.currentTarget.value)}
                      placeholder="输入 Model ID"
                      required
                    />
                  </Show>
                </Show>
              </label>
            </div>
            <div class="ai-model-form__actions">
              <Button
                type="submit"
                variant="primary"
                icon="plus"
                disabled={Boolean(controller.busy())}
              >{controller.busy() === 'save-model' ? '保存中…' : '保存 API Connection'}</Button>
            </div>
          </form>
        </Show>
        </div>
      </details>

      <Show when={apiConnections().length > 0}>
        <section class="ai-connections" aria-label="已配置 API Connections">
          <div class="ai-section-heading"><h2>已配置的 API Connections</h2><span>{apiConnections().length}</span></div>
          <For each={apiConnections()}>{(connection) => (
            <ApiConnectionCard
              connection={connection}
              busy={controller.busy()?.endsWith(connection.id) ? controller.busy() : undefined}
              onTest={(input) => void controller.testConnection(input)}
              onRemove={() => void controller.removeConnection(connection.id)}
            />
          )}</For>
        </section>
      </Show>
    </>
  )
}
