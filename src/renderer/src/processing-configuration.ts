import type {
  AiBackendKind,
  AiConnectionStatus,
  AiProviderId,
  ReasoningEffort
} from '../../shared/ai-backends'
import type {
  ProcessingConnectionView,
  ProcessingRuntime,
  ProcessingStageView
} from '../../shared/knowledge-processing'

export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

const PROVIDER_LABELS: Record<AiProviderId, string> = {
  openai_codex: 'OpenAI Codex',
  openai: 'OpenAI',
  openai_compatible: 'OpenAI-compatible'
}

const BACKEND_LABELS: Record<AiBackendKind, string> = {
  coding_plan: 'Coding Plan',
  api: 'API'
}

const CONNECTION_STATUS_LABELS: Record<AiConnectionStatus, string> = {
  not_found: '未安装',
  needs_auth: '需要认证',
  authenticating: '认证中',
  unverified: '未测试',
  ready: '可用',
  unsupported: '不支持',
  unavailable: '暂时不可用'
}

export function providerLabel(providerId: AiProviderId): string {
  return PROVIDER_LABELS[providerId]
}

export function backendLabel(backendKind: AiBackendKind): string {
  return BACKEND_LABELS[backendKind]
}

export function connectionStatusLabel(status: AiConnectionStatus): string {
  return CONNECTION_STATUS_LABELS[status]
}

export function connectionCanAttemptRun(
  connection: ProcessingConnectionView | undefined
): boolean {
  if (!connection) return false
  // Health is advisory: an unchecked or previously failed connection may be retried by a real run.
  return connection.status === 'unverified'
    || connection.status === 'ready'
    || connection.status === 'unavailable'
}

export function runtimeLabel(runtime: ProcessingRuntime): string {
  return runtime === 'pi_agent_core' ? 'Pi Agent Core' : runtime
}

export function reasoningLabel(reasoningEffort?: ReasoningEffort): string {
  return reasoningEffort ? REASONING_LABELS[reasoningEffort] : '模型默认'
}

export function selectedStageModel(
  stage: ProcessingStageView | undefined,
  connection: ProcessingConnectionView | undefined
) {
  return connection?.models.find((model) => model.id === stage?.modelId)
}
