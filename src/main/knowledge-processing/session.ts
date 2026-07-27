import type { AvailableSessionSummary } from '../../shared/discovery'
import type { RunSessionPreprocessorInput } from '../../shared/knowledge-processing'
import type {
  AvailableSessionEvidence,
  DiscoveryService
} from '../discovery/discovery-service'

export const MAX_SESSION_OBSERVATION_BYTES = 120_000

type SessionSelection = Pick<
  RunSessionPreprocessorInput,
  'artifactId' | 'expectedRevision'
>

export interface SessionMaterial {
  session: AvailableSessionSummary
  evidence: AvailableSessionEvidence
  sourceRef: string
}

export function validateSessionSelection(input: SessionSelection): void {
  if (!input || typeof input !== 'object') throw new Error('Session 选择无效')
  if (typeof input.artifactId !== 'string' || !input.artifactId || input.artifactId.length > 256) {
    throw new Error('Session artifact ID 无效')
  }
  if (!/^[a-f0-9]{64}$/i.test(input.expectedRevision)) {
    throw new Error('Session 内容版本无效')
  }
}

export function sessionSourceRef(artifactId: string, contentHash: string): string {
  return `raw:${artifactId}@sha256:${contentHash.toLowerCase()}`
}

/** Resolves and reads one selected external Session revision in the main process. */
export async function loadSessionMaterial(
  discovery: DiscoveryService,
  input: SessionSelection
): Promise<SessionMaterial> {
  validateSessionSelection(input)
  const session = discovery.listAvailableSessions().find(
    (candidate) => candidate.artifactId === input.artifactId
      && candidate.revision === input.expectedRevision
  )
  if (!session) throw new Error('所选 Session 已失效或版本已变化，请重新扫描并选择')

  const evidence = await discovery.readAvailableSession({
    artifactId: input.artifactId,
    expectedRevision: input.expectedRevision
  }, MAX_SESSION_OBSERVATION_BYTES)
  if (!evidence.content.trim()) throw new Error('所选 Session 没有可处理的 Observation 内容')

  return {
    session,
    evidence,
    sourceRef: sessionSourceRef(evidence.artifactId, evidence.contentHash)
  }
}
