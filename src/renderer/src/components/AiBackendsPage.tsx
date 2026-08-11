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
import { appLanguage, uiText } from '../i18n'

function statusView(status: AiConnection['status']): { label: string; tone: string } {
  return {
    not_found: { label: uiText('未安装', 'Not installed'), tone: 'warning' },
    needs_auth: { label: uiText('需要登录', 'Login required'), tone: 'warning' },
    authenticating: { label: uiText('等待登录', 'Waiting for login'), tone: 'active' },
    unverified: { label: uiText('未测试', 'Untested'), tone: '' },
    ready: { label: uiText('可用', 'Available'), tone: 'success' },
    unsupported: { label: uiText('当前方式不支持', 'Unsupported by this method'), tone: 'warning' },
    unavailable: { label: uiText('暂时不可用', 'Temporarily unavailable'), tone: 'danger' }
  }[status]
}

function authenticationExpiry(value?: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return new Intl.DateTimeFormat(appLanguage(), {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function modelLabel(model: AvailableModel | undefined, fallback = '—'): string {
  if (!model) return fallback
  return model.displayName === model.id ? model.id : `${model.displayName} · ${model.id}`
}

function StatusBadge(props: { connection: AiConnection }) {
  const value = () => statusView(props.connection.status)
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
            <strong>{uiText('等待浏览器登录', 'Waiting for Browser Login')}</strong>
            <p>{uiText(
              '请在系统浏览器中完成 ChatGPT 登录。若页面仍然报错，可以取消后改用设备码。',
              'Complete ChatGPT login in your system browser. If the page still reports an error, cancel and use a device code instead.'
            )}</p>
          </>
        )}
      >
        <strong>{uiText('使用设备码完成登录', 'Complete Login with a Device Code')}</strong>
        <p>{uiText(
          '请在浏览器中打开下面的验证地址并输入设备码；远程开发环境也可以在另一台设备上完成。',
          'Open the verification URL in a browser and enter the device code. Remote environments can complete this on another device.'
        )}</p>
        <div class="ai-device-code">
          <span>{uiText('设备码', 'Device Code')}</span>
          <code data-testid="coding-plan-device-code">
            {props.connection.authentication?.userCode || uiText('正在申请…', 'Requesting…')}
          </code>
        </div>
        <Show when={props.connection.authentication?.verificationUri}>
          <div class="ai-device-verification-uri">
            <span>{uiText('验证地址', 'Verification URL')}</span>
            <code>{props.connection.authentication?.verificationUri}</code>
          </div>
        </Show>
        <Show when={authenticationExpiry(props.connection.authentication?.expiresAt)}>
          {(expiresAt) => <p>{uiText('设备码预计在', 'The device code is expected to expire at')} {expiresAt()}.</p>}
        </Show>
      </Show>
      <div class="ai-authentication-state__actions">
        <Button
          variant="secondary"
          icon="stop"
          data-testid="coding-plan-cancel-login-button"
          onClick={props.onCancel}
        >{uiText('取消登录', 'Cancel Login')}</Button>
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
        <summary>{uiText('配置与额度测试', 'Configuration and Quota Test')}</summary>
        <div class="ui-disclosure__content">
          <dl class="ai-connection-details">
            <div><dt>Backend</dt><dd>API</dd></div>
            <div><dt>Protocol</dt><dd>{config().protocol === 'openai_responses' ? 'Responses' : 'Chat Completions'}</dd></div>
            <div><dt>API Key</dt><dd>{config().hasApiKey ? uiText('已保存到 Keychain', 'Saved to Keychain') : uiText('未配置', 'Not configured')}</dd></div>
          </dl>
          <div class="ai-model-form__row">
            <label class="ai-field">
              <span>{uiText('测试模型', 'Test Model')}</span>
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
              <span>{uiText('思考强度', 'Reasoning Effort')}</span>
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
                <option value="">{uiText('模型默认', 'Model default')}</option>
                <For each={selectedModel()?.reasoningEfforts ?? []}>{(effort) => (
                  <option value={effort}>{effort}</option>
                )}</For>
              </select>
            </label>
          </div>
          <p class="path" data-testid="api-connection-test-configuration">
            {uiText(
              '点击后将直接发起一条不含项目数据的测试调用，可能消耗 Provider API 额度；状态与结果会显示在本页。将使用',
              'This directly sends a test call without project data and may consume Provider API quota. Status and results appear on this page. It will use'
            )} {modelLabel(selectedModel())}
            {selectedReasoningEffort() ? ` · ${selectedReasoningEffort()}` : ` · ${uiText('模型默认思考强度', 'model-default reasoning effort')}`}
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
            >{uiText('删除', 'Delete')}</Button>
            <Button
              variant="secondary"
              icon="play"
              data-testid="api-connection-test-button"
              disabled={Boolean(props.busy) || !selectedModel()}
              onClick={testConnection}
            >{props.busy?.startsWith('test:') ? uiText('测试中…', 'Testing…') : uiText('运行额度测试', 'Run Quota Test')}</Button>
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
            <h1>{uiText('AI 后端', 'AI Backends')}</h1>
            <div class="page-summary">
              <span><strong>{readyCount()}</strong> {uiText('个可用连接', 'available connections')}</span>
              <span class="page-summary__separator">·</span>
              <span>{controller.snapshot().connections.length} {uiText('个已发现或已配置', 'discovered or configured')}</span>
            </div>
          </div>
          <Button
            variant="secondary"
            icon="refresh"
            onClick={() => void controller.refresh()}
            disabled={Boolean(controller.busy())}
          >{controller.busy() === 'refresh' ? uiText('检查中…', 'Checking…') : uiText('刷新状态', 'Refresh Status')}</Button>
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
            {controller.snapshot().connections.find((connection) => connection.id === result().connectionId)?.displayName || uiText('连接', 'Connection')}
            {' '}{uiText('测试成功（模型：', 'test succeeded (model: ')}{controller.testedConfiguration()?.modelId || '—'}
            {controller.testedConfiguration()?.reasoningEffort
              ? ` · ${controller.testedConfiguration()?.reasoningEffort}`
              : ` · ${uiText('模型默认思考强度', 'model-default reasoning effort')}`}{uiText('）：', '): ')}{result().output}
          </div>
        )}
      </Show>

      <section class="ai-runtime-panel" data-testid="default-llm-panel">
        <div class="ai-runtime-panel__header">
          <div>
            <h2>{uiText('默认 LLM', 'Default LLM')}</h2>
            <p>{uiText(
              'Knowledge Maintainer 和新建 Chat Conversation 使用这里保存的模型；已有 Chat Conversation 保留创建时的模型。',
              'Knowledge Maintainer and new Chat Conversations use the model saved here; existing Chat Conversations keep the model selected at creation.'
            )}</p>
          </div>
          <Show when={controller.snapshot().defaultLlm} fallback={<span class="status status--warning"><span class="status__dot" />{uiText('未配置', 'Not configured')}</span>}>
            <span class={`status ${savedDefaultLlmValid() ? 'status--success' : 'status--warning'}`}><span class="status__dot" />{savedDefaultLlmValid() ? uiText('已配置', 'Configured') : uiText('配置失效', 'Invalid configuration')}</span>
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
              <option value="">{uiText('选择 Connection', 'Select Connection')}</option>
              <For each={controller.snapshot().connections}>{(connection) => (
                <option
                  value={connection.id}
                  selected={connection.id === defaultConnectionId()}
                  disabled={connection.models.length === 0}
                >
                  {connection.displayName} · {statusView(connection.status).label}
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
              <option value="">{uiText('选择 Model', 'Select Model')}</option>
              <For each={defaultConnection()?.models ?? []}>{(candidate) => (
                <option value={candidate.id} selected={candidate.id === defaultModelId()}>{modelLabel(candidate)}</option>
              )}</For>
            </select>
          </label>
          <label class="ai-field">
            <span>{uiText('思考强度', 'Reasoning Effort')}</span>
            <select
              data-testid="default-llm-reasoning-select"
              value={defaultReasoningEffort() ?? ''}
              disabled={Boolean(controller.busy()) || (!defaultModel()?.reasoningEfforts.length && !defaultReasoningEffort())}
              onChange={(event) => setDefaultReasoningEffort(
                event.currentTarget.value ? event.currentTarget.value as ReasoningEffort : undefined
              )}
            >
              <option value="">{uiText('模型默认', 'Model default')}</option>
              <Show when={defaultReasoningEffort() && !defaultReasoningSupported()}>
                <option value={defaultReasoningEffort() ?? ''} selected disabled>{defaultReasoningEffort()} · {uiText('当前 Model 不支持', 'unsupported by current Model')}</option>
              </Show>
              <For each={defaultModel()?.reasoningEfforts ?? []}>{(effort) => (
                <option value={effort} selected={effort === defaultReasoningEffort()}>{effort}</option>
              )}</For>
            </select>
          </label>
        </div>
        <p class="path" data-testid="default-llm-summary">
          {defaultConnection() && defaultModel()
            ? `${defaultConnection()!.displayName} · ${modelLabel(defaultModel())} · ${defaultReasoningSupported() ? (effectiveDefaultReasoning() ?? uiText('模型默认思考强度', 'model-default reasoning effort')) : `${defaultReasoningEffort()} · ${uiText('当前 Model 不支持', 'unsupported by current Model')}`}`
            : controller.snapshot().defaultLlm
              ? `${uiText('已保存的默认 LLM 当前不可用：', 'The saved default LLM is currently unavailable: ')}${controller.snapshot().defaultLlm!.connectionId} · ${controller.snapshot().defaultLlm!.modelId}`
              : uiText(
                '设置后，新的 Knowledge Processing Task、Agent Preview 与 Chat Conversation 将从这里取得模型配置。',
                'New Knowledge Processing Tasks, Agent Previews, and Chat Conversations use this model configuration.'
              )}
        </p>
        <div class="ai-runtime-panel__actions">
          <Button
            variant="ghost"
            icon="trash"
            disabled={!controller.snapshot().defaultLlm || Boolean(controller.busy())}
            onClick={() => void controller.saveDefaultLlm(null)}
          >{uiText('清除默认 LLM', 'Clear Default LLM')}</Button>
          <Button
            variant="primary"
            icon="check"
            data-testid="save-default-llm"
            disabled={!defaultConnection() || !defaultModel() || !defaultReasoningSupported() || Boolean(controller.busy())}
            onClick={saveDefaultLlm}
          >{controller.busy() === 'save-default-llm' ? uiText('保存中…', 'Saving…') : uiText('保存默认 LLM', 'Save Default LLM')}</Button>
        </div>
      </section>

      <details class="ai-builder ui-disclosure">
        <summary>
          <span class="ai-builder__summary">
            <strong>{uiText('添加或连接 AI 后端', 'Add or Connect an AI Backend')}</strong>
            <span>{uiText('按需展开登录、模型与 API 配置。', 'Expand when needed to configure login, models, and APIs.')}</span>
          </span>
        </summary>
        <div class="ai-builder__content ui-disclosure__content">
          <div class="ai-builder__selectors">
            <label class="ai-field">
              <span>{uiText('执行方式', 'Execution Method')}</span>
              <select
                data-testid="backend-kind-select"
                value={backendKind()}
                onChange={(event) => chooseBackend(event.currentTarget.value as AiBackendKind)}
              >
                <option value="coding_plan">{uiText('已有 Coding Plan', 'Existing Coding Plan')}</option>
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
                  <p>{uiText(
                    '通过 Oyster 独立 OAuth 使用已有订阅；测试会明确使用下方选中的模型与思考强度。',
                    'Use an existing subscription through Oyster’s independent OAuth; tests explicitly use the model and reasoning effort selected below.'
                  )}</p>
                </div>
                <StatusBadge connection={connection()} />
              </div>
              <dl class="ai-runtime-details">
                <div><dt>Provider</dt><dd>OpenAI Codex</dd></div>
                <div><dt>{uiText('本机 Codex 账号（仅发现）', 'Local Codex Account (Discovery Only)')}</dt><dd>{connection().accountLabel || '—'}</dd></div>
                <div><dt>{uiText('本机 Plan（仅发现）', 'Local Plan (Discovery Only)')}</dt><dd>{connection().planType || '—'}</dd></div>
              </dl>
              <div class="ai-model-form__row">
                <label class="ai-field">
                  <span>{uiText('测试模型', 'Test Model')}</span>
                  <select
                    data-testid="coding-plan-model-select"
                    value={selectedCodingPlanModel()?.id ?? ''}
                    disabled={connection().models.length === 0}
                    onChange={(event) => chooseCodingPlanModel(event.currentTarget.value)}
                  >
                    <Show when={connection().models.length === 0}>
                      <option value="">{uiText('暂无可用模型', 'No model available')}</option>
                    </Show>
                    <For each={connection().models}>{(candidate) => (
                      <option value={candidate.id}>{modelLabel(candidate)}</option>
                    )}</For>
                  </select>
                </label>
                <label class="ai-field">
                  <span>{uiText('思考强度', 'Reasoning Effort')}</span>
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
                    <option value="">{uiText('模型默认', 'Model default')}</option>
                    <For each={selectedCodingPlanModel()?.reasoningEfforts ?? []}>{(effort) => (
                      <option value={effort}>{effort}</option>
                    )}</For>
                  </select>
                </label>
              </div>
              <p class="path" data-testid="coding-plan-test-configuration">
                {uiText(
                  '点击后将直接发起一条不含项目数据的测试调用，可能消耗 Coding Plan 额度；状态与结果会显示在本页。将使用',
                  'This directly sends a test call without project data and may consume Coding Plan quota. Status and results appear on this page. It will use'
                )} {modelLabel(selectedCodingPlanModel(), uiText('尚无可用模型', 'no available model'))}
                {selectedCodingPlanReasoningEffort()
                  ? ` · ${selectedCodingPlanReasoningEffort()}`
                  : ` · ${uiText('模型默认思考强度', 'model-default reasoning effort')}`}
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
                  >{uiText('设备码登录（远程推荐）', 'Device Code Login (Recommended for Remote)')}</Button>
                  <Button
                    variant="secondary"
                    icon="link"
                    disabled={Boolean(controller.busy()) || connection().status === 'not_found'}
                    data-testid="coding-plan-browser-login-button"
                    onClick={() => void controller.connect(connection().id, 'browser')}
                  >{uiText('浏览器登录', 'Browser Login')}</Button>
                </Show>
                <Show when={connection().status === 'ready'}>
                  <Button
                    variant="secondary"
                    icon="play"
                    data-testid="coding-plan-test-button"
                    disabled={Boolean(controller.busy()) || !selectedCodingPlanModel()}
                    onClick={() => testCodingPlan(connection())}
                  >{controller.busy() === `test:${connection().id}` ? uiText('测试中…', 'Testing…') : uiText('运行额度测试', 'Run Quota Test')}</Button>
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
              <span>API Key {providerId() === 'openai_compatible' ? uiText('（本地端点可留空）', '(optional for local endpoints)') : ''}</span>
              <input
                type="password"
                autocomplete="off"
                value={apiKey()}
                onInput={(event) => {
                  setApiKey(event.currentTarget.value)
                  setAvailableModels([])
                }}
                required={providerId() === 'openai'}
                placeholder={uiText('仅保存到系统 Keychain', 'Saved only to the system Keychain')}
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
              >{controller.busy() === 'discover-models' ? uiText('正在获取…', 'Fetching…') : uiText('获取可用模型', 'Fetch Available Models')}</Button>
              <Show when={availableModels().length > 0}>
                <span class="path">{uiText('已发现', 'Found')} {availableModels().length} {uiText('个模型', 'models')}</span>
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
                      placeholder={uiText('输入 Model ID', 'Enter Model ID')}
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
                    <option value="__manual__">{uiText('手动输入其他 Model ID…', 'Enter another Model ID manually…')}</option>
                  </select>
                  <Show when={!availableModels().some((candidate) => candidate.id === model())}>
                    <input
                      data-testid="model-manual-input"
                      value={model()}
                      onInput={(event) => setModel(event.currentTarget.value)}
                      placeholder={uiText('输入 Model ID', 'Enter Model ID')}
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
              >{controller.busy() === 'save-model' ? uiText('保存中…', 'Saving…') : uiText('保存 API Connection', 'Save API Connection')}</Button>
            </div>
          </form>
        </Show>
        </div>
      </details>

      <Show when={apiConnections().length > 0}>
        <section class="ai-connections" aria-label={uiText('已配置 API Connections', 'Configured API Connections')}>
          <div class="ai-section-heading"><h2>{uiText('已配置的 API Connections', 'Configured API Connections')}</h2><span>{apiConnections().length}</span></div>
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
