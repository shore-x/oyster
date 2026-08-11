import type {
  SourceConversationSummary,
  SourceSnapshotRef
} from '../../shared/discovery'
import type { SourceSnapshotSelectionFailureReason } from '../../shared/knowledge-processing'
import type {
  DiscoveryService,
  SourceSnapshotEvidence
} from '../discovery/discovery-service'
import {
  SourceConversationRevisionChangedError,
  SourceConversationUnavailableError,
  SourceConversationUnreadableError
} from '../discovery/source-evidence-reader'

export interface SourceSnapshotMaterial {
  sourceConversation: SourceConversationSummary
  evidence: SourceSnapshotEvidence
  sourceRef: string
}

export class SourceSnapshotRejectedError extends Error {
  constructor(
    readonly reason: SourceSnapshotSelectionFailureReason,
    message: string
  ) {
    super(message)
    this.name = 'SourceSnapshotRejectedError'
  }
}

function selectionRejected(
  reason: SourceSnapshotSelectionFailureReason
): SourceSnapshotRejectedError {
  if (reason === 'changed') {
    return new SourceSnapshotRejectedError(
      reason,
      '所选来源对话已更新，请从刷新后的列表重新选择'
    )
  }
  if (reason === 'unreadable') {
    return new SourceSnapshotRejectedError(
      reason,
      '当前无法读取所选来源对话，请检查来源权限后刷新'
    )
  }
  return new SourceSnapshotRejectedError(
    reason,
    '所选来源对话已不可用，请刷新后重新选择'
  )
}

export function validateSourceSnapshot(input: SourceSnapshotRef): void {
  if (!input || typeof input !== 'object') throw new Error('来源快照选择无效')
  if (
    typeof input.sourceConversationId !== 'string'
    || !input.sourceConversationId
    || input.sourceConversationId.length > 256
  ) {
    throw new Error('来源对话 ID 无效')
  }
  if (!/^[a-f0-9]{64}$/i.test(input.sourceRevision)) {
    throw new Error('来源版本无效')
  }
}

export function sourceSnapshotRef(sourceConversationId: string, contentHash: string): string {
  return `raw:${sourceConversationId}@sha256:${contentHash.toLowerCase()}`
}

/** Resolves one exact external conversation revision before accepting a Knowledge Task. */
export async function loadSourceSnapshotMaterial(
  discovery: DiscoveryService,
  input: SourceSnapshotRef
): Promise<SourceSnapshotMaterial> {
  validateSourceSnapshot(input)
  const sourceConversation = discovery.listSourceConversations().find(
    (candidate) => candidate.sourceConversationId === input.sourceConversationId
  )
  if (!sourceConversation) throw selectionRejected('unavailable')
  if (sourceConversation.sourceRevision !== input.sourceRevision) {
    throw selectionRejected('changed')
  }

  let evidence: SourceSnapshotEvidence
  try {
    evidence = await discovery.readSourceSnapshot(input)
  } catch (error) {
    if (error instanceof SourceConversationUnavailableError) {
      throw selectionRejected('unavailable')
    }
    if (error instanceof SourceConversationRevisionChangedError) {
      throw selectionRejected('changed')
    }
    if (error instanceof SourceConversationUnreadableError) {
      throw selectionRejected('unreadable')
    }
    throw error
  }
  if (!evidence.rawEvidence.lines.some((line) => line.trim())) {
    throw new Error('所选来源快照没有可处理的 Observation 内容')
  }

  return {
    sourceConversation,
    evidence,
    sourceRef: sourceSnapshotRef(evidence.sourceConversationId, evidence.contentHash)
  }
}
