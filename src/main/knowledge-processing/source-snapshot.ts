import type {
  SourceConversationSelection,
  SourceConversationSummary
} from '../../shared/discovery'
import type {
  SourceSnapshotSelectionFailureReason,
  StartKnowledgeTaskInput
} from '../../shared/knowledge-processing'
import type {
  DiscoveryService,
  SourceSnapshotEvidence
} from '../discovery/discovery-service'
import {
  SourceConversationChangedError,
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
      '所选来源对话在读取期间持续变化，请稍后重试'
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

export function validateSourceConversationSelection(input: unknown): void {
  if (!input || typeof input !== 'object') throw new Error('来源对话选择无效')
  const selection = input as Partial<SourceConversationSelection>
  if (
    typeof selection.sourceConversationId !== 'string'
    || !selection.sourceConversationId
    || selection.sourceConversationId.length > 256
  ) {
    throw new Error('来源对话 ID 无效')
  }
}

/** Projects a runtime value onto the current public Source Conversation selection. */
export function normalizeSourceConversationSelection(
  input: unknown
): SourceConversationSelection {
  validateSourceConversationSelection(input)
  return {
    sourceConversationId: (input as SourceConversationSelection).sourceConversationId
  }
}

/** Projects accepted Task input onto the current persisted definition. */
export function normalizeStartKnowledgeTaskInput(input: unknown): StartKnowledgeTaskInput {
  const selection = normalizeSourceConversationSelection(input)
  const attention = (input as Partial<StartKnowledgeTaskInput>).attention
  if (attention !== undefined && typeof attention !== 'string') {
    throw new Error('补充关注内容格式无效')
  }
  return {
    ...selection,
    ...(attention === undefined ? {} : { attention })
  }
}

/** Removes legacy catalog-only fields from the current Source Conversation read model. */
export function normalizeSourceConversationSummary(
  sourceConversation: SourceConversationSummary
): SourceConversationSummary {
  return {
    sourceConversationId: sourceConversation.sourceConversationId,
    sourceId: sourceConversation.sourceId,
    agentType: sourceConversation.agentType,
    sourceDisplayName: sourceConversation.sourceDisplayName,
    providerConversationId: sourceConversation.providerConversationId,
    ...(sourceConversation.title === undefined ? {} : { title: sourceConversation.title }),
    ...(sourceConversation.projectPath === undefined
      ? {}
      : { projectPath: sourceConversation.projectPath }),
    ...(sourceConversation.startedAt === undefined
      ? {}
      : { startedAt: sourceConversation.startedAt }),
    ...(sourceConversation.endedAt === undefined ? {} : { endedAt: sourceConversation.endedAt }),
    ...(sourceConversation.updatedAt === undefined
      ? {}
      : { updatedAt: sourceConversation.updatedAt }),
    sizeBytes: sourceConversation.sizeBytes
  }
}

export function sourceSnapshotRef(sourceConversationId: string, contentHash: string): string {
  return `raw:${sourceConversationId}@sha256:${contentHash.toLowerCase()}`
}

/** Reads the selected conversation's current bytes and gives them an immutable content reference. */
export async function loadSourceSnapshotMaterial(
  discovery: DiscoveryService,
  input: SourceConversationSelection
): Promise<SourceSnapshotMaterial> {
  validateSourceConversationSelection(input)

  let evidence: SourceSnapshotEvidence
  try {
    evidence = await discovery.readSourceSnapshot(input)
  } catch (error) {
    if (error instanceof SourceConversationUnavailableError) {
      throw selectionRejected('unavailable')
    }
    if (error instanceof SourceConversationChangedError) {
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
  const sourceConversation = discovery.listSourceConversations().find(
    (candidate) => candidate.sourceConversationId === evidence.sourceConversationId
  )
  if (!sourceConversation) throw selectionRejected('unavailable')

  return {
    sourceConversation: normalizeSourceConversationSummary(sourceConversation),
    evidence,
    sourceRef: sourceSnapshotRef(evidence.sourceConversationId, evidence.contentHash)
  }
}
