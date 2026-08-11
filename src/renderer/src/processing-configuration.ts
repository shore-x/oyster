import type {
  LlmBinding,
  AiBackendKind,
  AiConnectionStatus,
  AiProviderId,
  ReasoningEffort
} from '../../shared/ai-backends'
import type {
  AiConnectionView,
  KnowledgeAgentRuntimeKind
} from '../../shared/knowledge-processing'
import { uiText } from './i18n'

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

export function providerLabel(providerId: AiProviderId): string {
  return PROVIDER_LABELS[providerId]
}

export function backendLabel(backendKind: AiBackendKind): string {
  return BACKEND_LABELS[backendKind]
}

export function connectionStatusLabel(status: AiConnectionStatus): string {
  const labels: Record<AiConnectionStatus, string> = {
    not_found: uiText('未安装', 'Not installed'),
    needs_auth: uiText('需要认证', 'Authentication required'),
    authenticating: uiText('认证中', 'Authenticating'),
    unverified: uiText('未测试', 'Untested'),
    ready: uiText('可用', 'Available'),
    unsupported: uiText('不支持', 'Unsupported'),
    unavailable: uiText('暂时不可用', 'Temporarily unavailable')
  }
  return labels[status]
}

export function connectionCanInvokeAgent(
  connection: AiConnectionView | undefined
): boolean {
  if (!connection) return false
  // Health is advisory: an unchecked or previously failed connection may be retried.
  return connection.status === 'unverified'
    || connection.status === 'ready'
    || connection.status === 'unavailable'
}

export function runtimeLabel(runtime: KnowledgeAgentRuntimeKind): string {
  return runtime === 'pi_coding_agent' ? 'Pi Coding Agent SDK' : runtime
}

export function reasoningLabel(reasoningEffort?: ReasoningEffort): string {
  return reasoningEffort ? REASONING_LABELS[reasoningEffort] : uiText('模型默认', 'Model default')
}

export function selectedLlmModel(
  binding: LlmBinding | undefined,
  connection: AiConnectionView | undefined
) {
  return connection?.models.find((model) => model.id === binding?.modelId)
}
