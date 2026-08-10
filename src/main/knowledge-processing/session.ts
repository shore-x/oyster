import type { AvailableSessionSummary } from '../../shared/discovery'
import type {
  RunKnowledgeMaintenanceInput,
  SessionSelectionFailureReason
} from '../../shared/knowledge-processing'
import type {
  AvailableSessionEvidence,
  DiscoveryService
} from '../discovery/discovery-service'
import {
  SourceSessionRevisionChangedError,
  SourceSessionUnavailableError,
  SourceSessionUnreadableError
} from '../discovery/source-evidence-reader'

type SessionSelection = Pick<
  RunKnowledgeMaintenanceInput,
  'sourceRecordId' | 'expectedRevision'
>

export interface SessionMaterial {
  session: AvailableSessionSummary
  evidence: AvailableSessionEvidence
  sourceRef: string
}

export class SessionSelectionRejectedError extends Error {
  constructor(
    readonly reason: SessionSelectionFailureReason,
    message: string
  ) {
    super(message)
    this.name = 'SessionSelectionRejectedError'
  }
}

function selectionRejected(
  reason: SessionSelectionFailureReason
): SessionSelectionRejectedError {
  if (reason === 'changed') {
    return new SessionSelectionRejectedError(
      reason,
      '所选 Session 已更新，请从刷新后的列表重新选择'
    )
  }
  if (reason === 'unreadable') {
    return new SessionSelectionRejectedError(
      reason,
      '当前无法读取所选 Session，请检查来源权限后刷新本机 Session'
    )
  }
  return new SessionSelectionRejectedError(
    reason,
    '所选 Session 已不可用，请刷新本机 Session 后重新选择'
  )
}

export function validateSessionSelection(input: SessionSelection): void {
  if (!input || typeof input !== 'object') throw new Error('Session 选择无效')
  if (
    typeof input.sourceRecordId !== 'string'
    || !input.sourceRecordId
    || input.sourceRecordId.length > 256
  ) {
    throw new Error('Session source record ID 无效')
  }
  if (!/^[a-f0-9]{64}$/i.test(input.expectedRevision)) {
    throw new Error('Session 内容版本无效')
  }
}

export function sessionSourceRef(sourceRecordId: string, contentHash: string): string {
  return `raw:${sourceRecordId}@sha256:${contentHash.toLowerCase()}`
}

/** Resolves and reads one selected external Session revision in the main process. */
export async function loadSessionMaterial(
  discovery: DiscoveryService,
  input: SessionSelection
): Promise<SessionMaterial> {
  validateSessionSelection(input)
  const session = discovery.listAvailableSessions().find(
    (candidate) => candidate.sourceRecordId === input.sourceRecordId
  )
  if (!session) throw selectionRejected('unavailable')
  if (session.revision !== input.expectedRevision) throw selectionRejected('changed')

  let evidence: AvailableSessionEvidence
  try {
    evidence = await discovery.readAvailableSession({
      sourceRecordId: input.sourceRecordId,
      expectedRevision: input.expectedRevision
    })
  } catch (error) {
    if (error instanceof SourceSessionUnavailableError) throw selectionRejected('unavailable')
    if (error instanceof SourceSessionRevisionChangedError) throw selectionRejected('changed')
    if (error instanceof SourceSessionUnreadableError) throw selectionRejected('unreadable')
    throw error
  }
  if (
    !evidence.rawEvidence.lines.some((line) => line.trim())
  ) {
    throw new Error('所选 Session 没有可处理的 Observation 内容')
  }

  return {
    session,
    evidence,
    sourceRef: sessionSourceRef(evidence.sourceRecordId, evidence.contentHash)
  }
}
