/** One bounded, model-readable unit that still points at its original raw text line. */
export interface ObservationUnit {
  /** One-based line in the unchanged raw Session file. */
  lineNumber: number
  /** Exact raw source text selected by this unit's character range. */
  content: string
  startCharacter: number
  endCharacter: number
  totalCharacters: number
  /**
   * Optional deterministic, bounded representation shown to the preprocessor.
   * The raw content and locator remain available to the Knowledge Maintenance Agent.
   */
  modelContent?: string
  /** Adapter-derived context that makes a split record understandable without defining a canonical schema. */
  recordContext?: string
}

export interface ObservationCharacterWindow {
  startCharacter: number
  endCharacter: number
  totalCharacters: number
}

/** A transient, model-facing position used to navigate one immutable Observation revision. */
export interface EvidenceLocation {
  /** One-based physical line in the unchanged raw source. */
  line: number
  /** Zero-based UTF-16 offset within that line. */
  offset: number
}

/**
 * An Agent-format-specific, deterministic preprocessing view of one raw Session revision.
 * `rawLines` retains the complete revision for later evidence reads; `units` may select
 * or compact only the material useful for building an Evidence Map.
 * Unit boundaries and representations never depend on the selected model.
 */
export interface ObservationView {
  formatVersion: string
  rawLines: string[]
  units: ObservationUnit[]
}
