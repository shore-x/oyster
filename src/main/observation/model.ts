/** A transient, model-facing position in one immutable Raw Evidence revision. */
export interface EvidenceLocation {
  /** One-based physical line in the unchanged source. */
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
