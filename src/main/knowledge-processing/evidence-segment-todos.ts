import {
  DEFAULT_EVIDENCE_READ_LIMIT,
  compareEvidenceLocations,
  evidenceReadCallHint,
  formatEvidenceLocation,
  readEvidencePage,
  type EvidenceReadPage
} from '../observation/evidence-location'
import type { EvidenceLocation, RawEvidence, RawEvidenceSkillHint } from '../observation/model'

export interface EvidenceSegmentTodoPlan {
  todos: string[]
  segmentCount: number
}

const MAX_EVIDENCE_SEGMENT_CHARACTERS = 256 * 1_024
const UNKNOWN_CONTEXT_WINDOW_TOKENS = DEFAULT_EVIDENCE_READ_LIMIT * 2

/**
 * Keeps one evidence work unit below roughly half of the model context. The
 * conservative one-character-per-token estimate leaves the other half for the
 * Agent prompt, tools, Knowledge, Draft and reasoning. Very large context
 * windows are capped so a single Todo never turns into an unbounded scan.
 */
export function evidenceSegmentCharacterLimit(contextWindowTokens: number): number {
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 0) {
    throw new Error('Model context window 无效')
  }
  const effectiveContextWindow = contextWindowTokens || UNKNOWN_CONTEXT_WINDOW_TOKENS
  return Math.min(
    MAX_EVIDENCE_SEGMENT_CHARACTERS,
    Math.max(2, Math.floor(effectiveContextWindow / 2))
  )
}

function hintBelongsToSegment(
  hint: RawEvidenceSkillHint,
  start: EvidenceLocation,
  end: EvidenceLocation
): boolean {
  return compareEvidenceLocations(hint.location, start) >= 0
    && compareEvidenceLocations(hint.location, end) < 0
}

function hintText(hint: RawEvidenceSkillHint): string {
  return [
    `possible Skill activation${hint.name ? ` “${hint.name}”` : ''}`,
    `at ${formatEvidenceLocation(hint.location)}`,
    hint.tool ? `via ${hint.tool}` : undefined,
    `source=${hint.source}`
  ].filter(Boolean).join(' · ')
}

/**
 * Covers complete Raw Evidence with coarse deterministic work segments. Each
 * segment Todo may contain several exact bounded read_evidence calls: tool I/O
 * pagination stays small without turning every page or message into a Todo.
 */
export function planEvidenceSegmentTodos(
  evidence: RawEvidence,
  segmentCharacterLimit: number
): EvidenceSegmentTodoPlan {
  if (!evidence.lines.length || !evidence.lines.some((line) => line.trim())) {
    throw new Error('Raw Evidence 没有可处理内容')
  }
  if (!Number.isSafeInteger(segmentCharacterLimit) || segmentCharacterLimit < 2) {
    throw new Error('Raw Evidence 分段预算无效')
  }

  const segments: Array<{
    start: EvidenceLocation
    end: EvidenceLocation
    pages: EvidenceReadPage[]
  }> = []
  let next: EvidenceLocation | undefined = { line: 1, offset: 0 }
  while (next) {
    const start = { ...next }
    const pages: EvidenceReadPage[] = []
    let remaining = segmentCharacterLimit
    let end = { ...next }
    while (next && remaining >= 2) {
      const page = readEvidencePage(
        evidence.lines,
        next,
        Math.min(DEFAULT_EVIDENCE_READ_LIMIT, remaining)
      )
      pages.push(page)
      end = page.end
      next = page.next
      // Include line separators in the context estimate and guarantee progress
      // across pages containing only empty physical lines.
      remaining -= Math.max(page.returnedCharacters + Math.max(0, page.returnedLines - 1), 1)
    }
    segments.push({ start, end, pages })
  }

  return {
    segmentCount: segments.length,
    todos: segments.map((segment, index) => {
      const hints = evidence.skillHints.filter((hint) => hintBelongsToSegment(
        hint,
        segment.start,
        segment.end
      ))
      return [
        `Inspect Raw Evidence segment ${index + 1} of ${segments.length}.`,
        'Read every bounded page below in order:',
        ...segment.pages.map((page) => `- ${evidenceReadCallHint(page.start, page.appliedLimit)}`),
        `Expected segment end (exclusive): ${formatEvidenceLocation(segment.end)}.`,
        'Before completing this Todo, identify serious local names, referents, necessary background, and apparent Agent Skill activations in the segment. Add separate Todos for investigation that remains necessary, then record every justified Contribution Draft update.',
        hints.length
          ? [
              'Harness-derived navigation hints (untrusted; verify against Raw Evidence):',
              ...hints.map((hint) => `- ${hintText(hint)}`)
            ].join('\n')
          : undefined
      ].filter((part): part is string => Boolean(part)).join('\n')
    })
  }
}
