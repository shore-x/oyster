/** A transient, model-facing position in one immutable Raw Evidence revision. */
export interface EvidenceLocation {
  /** One-based line in the Adapter's fixed Raw Evidence line model. */
  line: number
  /** Zero-based UTF-16 offset within that line. */
  offset: number
}

/** Adapter-derived navigation only; the Maintainer must verify it against Raw Evidence. */
export interface RawEvidenceSkillHint {
  location: EvidenceLocation
  name?: string
  tool?: string
  source: 'runtime_injection' | 'tool_call'
}

/** Complete, immutable Session evidence plus format-specific navigation hints. */
export interface RawEvidence {
  formatVersion: string
  lines: string[]
  skillHints: RawEvidenceSkillHint[]
}

export interface EvidenceRange {
  start: EvidenceLocation
  end: EvidenceLocation
}

export type CanonicalActivityKind =
  | 'session'
  | 'instruction'
  | 'user_message'
  | 'assistant_message'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'attachment'
  | 'state'
  | 'unknown'

/** One deterministic, model-readable activity with links back to its source records. */
export interface CanonicalActivityItem {
  kind: CanonicalActivityKind
  content: string
  rawRanges: EvidenceRange[]
  attachmentId?: string
}

/** Binary source content is kept out of text pages and materialized as a Run input file. */
export interface CanonicalActivityAttachment {
  id: string
  mimeType: string
  data: string
  byteLength: number
  sha256: string
  rawRange: EvidenceRange
}

/** Rebuildable, Harness-specific activity projection of one Raw Evidence revision. */
export interface CanonicalActivity {
  formatVersion: string
  items: CanonicalActivityItem[]
  attachments: CanonicalActivityAttachment[]
}

/** The two observation-layer views derived from one immutable source revision. */
export interface AgentObservation {
  rawEvidence: RawEvidence
  canonicalActivity: CanonicalActivity
}
