/** One bounded, model-readable unit that still points at its original raw text line. */
export interface ObservationUnit {
  /** One-based line in the unchanged raw Session file. */
  lineNumber: number
  /** Raw source text for this bounded unit. */
  content: string
  startCharacter: number
  endCharacter: number
  totalCharacters: number
  /** Adapter-derived context that makes a split record understandable without defining a canonical schema. */
  recordContext?: string
}

export interface ObservationCharacterWindow {
  startCharacter: number
  endCharacter: number
  totalCharacters: number
}

/**
 * An Agent-format-specific view of one raw Session revision.
 * Unit boundaries are deterministic for the format version and never depend on the selected model.
 */
export interface ObservationView {
  formatVersion: string
  rawLines: string[]
  units: ObservationUnit[]
}
