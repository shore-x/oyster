import {
  DEFAULT_EVIDENCE_READ_LIMIT,
  compareEvidenceLocations,
  evidenceReadCallHint,
  formatEvidenceLocation,
  readEvidencePage
} from '../observation/evidence-location'
import type { EvidenceLocation, RawEvidence, RawEvidenceSkillHint } from '../observation/model'

export interface EvidenceSegmentTodoPlan {
  todos: string[]
  segmentCount: number
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
 * Covers the complete Raw Evidence with deterministic pages that map one-to-one
 * to bounded read_evidence calls. The pages are ordinary initial Todos; no
 * evidence-specific completion state is introduced.
 */
export function planEvidenceSegmentTodos(evidence: RawEvidence): EvidenceSegmentTodoPlan {
  if (!evidence.lines.length || !evidence.lines.some((line) => line.trim())) {
    throw new Error('Raw Evidence 没有可处理内容')
  }
  const pages = []
  let next: EvidenceLocation | undefined = { line: 1, offset: 0 }
  while (next) {
    const page = readEvidencePage(evidence.lines, next, DEFAULT_EVIDENCE_READ_LIMIT)
    pages.push(page)
    next = page.next
  }

  return {
    segmentCount: pages.length,
    todos: pages.map((page, index) => {
      const hints = evidence.skillHints.filter((hint) => hintBelongsToSegment(
        hint,
        page.start,
        page.end
      ))
      return [
        `Inspect Raw Evidence segment ${index + 1} of ${pages.length}.`,
        `Read this exact bounded page with ${evidenceReadCallHint(page.start, page.appliedLimit)}.`,
        `Expected end (exclusive): ${formatEvidenceLocation(page.end)}.`,
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
