import type { AvailableSessionSummary } from '../../shared/discovery'
import type { RunKnowledgeMaintenanceInput } from '../../shared/knowledge-processing'
import type {
  AvailableSessionEvidence,
  DiscoveryService
} from '../discovery/discovery-service'

type SessionSelection = Pick<
  RunKnowledgeMaintenanceInput,
  'sourceRecordId' | 'expectedRevision'
>

export interface SessionMaterial {
  session: AvailableSessionSummary
  evidence: AvailableSessionEvidence
  sourceRef: string
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
      && candidate.revision === input.expectedRevision
  )
  if (!session) throw new Error('所选 Session 已失效或版本已变化，请重新扫描并选择')

  const evidence = await discovery.readAvailableSession({
    sourceRecordId: input.sourceRecordId,
    expectedRevision: input.expectedRevision
  })
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
