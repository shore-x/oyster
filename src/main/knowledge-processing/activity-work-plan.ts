import {
  DEFAULT_ACTIVITY_READ_LIMIT,
  activityRawLines,
  activityReadCallHint,
  formatActivityLocation,
  readActivityPage,
  type ActivityLocation,
  type ActivityReadPage
} from '../observation/activity-location'
import {
  formatEvidenceLocation,
  splitsSurrogatePair
} from '../observation/evidence-location'
import type {
  CanonicalActivity,
  RawEvidenceSkillHint
} from '../observation/model'

export interface ActivityWorkPlan {
  items: string[]
  segmentCount: number
}

const MAX_ACTIVITY_SEGMENT_CHARACTERS = 256 * 1_024
const UNKNOWN_CONTEXT_WINDOW_TOKENS = DEFAULT_ACTIVITY_READ_LIMIT * 2

/** Reserves roughly half of the model context for prompt, tools, Knowledge and reasoning. */
export function activitySegmentCharacterLimit(contextWindowTokens: number): number {
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 0) {
    throw new Error('Model context window 无效')
  }
  const effectiveContextWindow = contextWindowTokens || UNKNOWN_CONTEXT_WINDOW_TOKENS
  return Math.min(
    MAX_ACTIVITY_SEGMENT_CHARACTERS,
    Math.max(2, Math.floor(effectiveContextWindow / 2))
  )
}

function hintText(hint: RawEvidenceSkillHint): string {
  return [
    `possible Skill activation${hint.name ? ` “${hint.name}”` : ''}`,
    `at ${formatEvidenceLocation(hint.location)}`,
    hint.tool ? `via ${hint.tool}` : undefined,
    `source=${hint.source}`
  ].filter(Boolean).join(' · ')
}

interface SegmentRange {
  start: ActivityLocation
  end: ActivityLocation
  characters: number
  itemIndexes: Set<number>
}

function nextLocation(
  activity: CanonicalActivity,
  location: ActivityLocation,
  characters: number
): ActivityLocation | undefined {
  const item = activity.items[location.activity - 1]
  const endOffset = location.offset + characters
  if (endOffset < item.content.length) {
    return { activity: location.activity, offset: endOffset }
  }
  return location.activity < activity.items.length
    ? { activity: location.activity + 1, offset: 0 }
    : undefined
}

/** Groups complete activities where possible; only one oversized activity may span segments. */
function segmentRanges(
  activity: CanonicalActivity,
  characterLimit: number
): SegmentRange[] {
  const segments: SegmentRange[] = []
  let next: ActivityLocation | undefined = { activity: 1, offset: 0 }

  while (next) {
    const start = { ...next }
    const itemIndexes = new Set<number>()
    let remaining = characterLimit
    let characters = 0
    let end = { ...next }

    while (next && remaining >= 2) {
      const item = activity.items[next.activity - 1]
      const available = item.content.length - next.offset
      if (available <= 0) {
        next = nextLocation(activity, next, 0)
        continue
      }

      // Do not split a new activity merely to fill the tail of an existing segment.
      if (characters > 0 && next.offset === 0 && available > remaining) break
      let consumed = Math.min(available, remaining)
      if (splitsSurrogatePair(item.content, next.offset + consumed)) consumed--
      if (consumed < 1) break
      itemIndexes.add(next.activity)
      characters += consumed
      remaining -= consumed
      const following = nextLocation(activity, next, consumed)
      end = following ?? {
        activity: activity.items.length,
        offset: activity.items.at(-1)!.content.length
      }
      next = following
    }

    if (characters < 1) throw new Error('Canonical Activity 分段无法取得进展')
    segments.push({ start, end, characters, itemIndexes })
  }
  return segments
}

function segmentPages(
  activity: CanonicalActivity,
  segment: SegmentRange
): ActivityReadPage[] {
  const pages: ActivityReadPage[] = []
  let next = { ...segment.start }
  let remaining = segment.characters
  while (remaining > 0) {
    const page = readActivityPage(
      activity,
      next,
      Math.min(DEFAULT_ACTIVITY_READ_LIMIT, remaining)
    )
    if (page.returnedCharacters < 1) throw new Error('Canonical Activity 分页无法取得进展')
    pages.push(page)
    remaining -= page.returnedCharacters
    if (remaining > 0) {
      if (!page.next) throw new Error('Canonical Activity 分页提前到达 EOF')
      next = page.next
    }
  }
  return pages
}

function segmentRawLines(activity: CanonicalActivity, segment: SegmentRange): Set<number> {
  return new Set([...segment.itemIndexes].flatMap((index) => (
    activityRawLines(activity.items[index - 1])
  )))
}

/**
 * Covers the complete Canonical Activity projection with activity-aware work segments.
 * Raw Evidence remains available for exact verification through source locators.
 */
export function planActivityWork(
  activity: CanonicalActivity,
  skillHints: readonly RawEvidenceSkillHint[],
  segmentCharacterLimit: number
): ActivityWorkPlan {
  if (!activity.items.length || activity.items.some((item) => !item.content.trim())) {
    throw new Error('Canonical Activity 没有可处理内容或包含空活动')
  }
  if (!Number.isSafeInteger(segmentCharacterLimit) || segmentCharacterLimit < 2) {
    throw new Error('Canonical Activity 分段预算无效')
  }

  const segments = segmentRanges(activity, segmentCharacterLimit)
  const assignedHints = new Set<number>()
  return {
    segmentCount: segments.length,
    items: segments.map((segment, index) => {
      const pages = segmentPages(activity, segment)
      const rawLines = segmentRawLines(activity, segment)
      const hints = skillHints.filter((hint, hintIndex) => {
        if (assignedHints.has(hintIndex) || !rawLines.has(hint.location.line)) return false
        assignedHints.add(hintIndex)
        return true
      })
      const attachmentIds = [...segment.itemIndexes].flatMap((itemIndex) => {
        const id = activity.items[itemIndex - 1].attachmentId
        return id ? [id] : []
      })
      return [
        `Inspect Canonical Activity segment ${index + 1} of ${segments.length}.`,
        'Read every bounded activity page below in order:',
        ...pages.map((page) => `- ${activityReadCallHint(page.start, page.appliedLimit)}`),
        attachmentIds.length
          ? [
              'Inspect the linked binary evidence:',
              ...attachmentIds.map((id) => `- read_activity_attachment({"id":"${id}"})`)
            ].join('\n')
          : undefined,
        `Expected segment end (exclusive): ${formatActivityLocation(segment.end)}.`,
        'Before completing this work item, identify serious local names, referents, necessary background, and apparent Agent Skill activations. Use each activity\'s Raw source locator with read_evidence only when exact source verification is needed. Add separate checklist items for investigation that remains necessary, then make every justified Knowledge or Artifact change.',
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
