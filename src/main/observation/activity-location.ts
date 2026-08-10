import type {
  CanonicalActivity,
  CanonicalActivityItem,
  EvidenceLocation
} from './model'
import { formatEvidenceLocation, splitsSurrogatePair } from './evidence-location'

export const DEFAULT_ACTIVITY_READ_LIMIT = 16 * 1_024
export const MAX_ACTIVITY_READ_LIMIT = 48 * 1_024
export const MAX_ACTIVITY_READ_ITEMS = 100

export interface ActivityLocation {
  /** One-based index in the deterministic Canonical Activity sequence. */
  activity: number
  /** Zero-based UTF-16 offset within that activity's readable content. */
  offset: number
}

export interface ActivityReadChunk {
  activity: number
  startOffset: number
  endOffset: number
  totalCharacters: number
  item: CanonicalActivityItem
  content: string
}

export interface ActivityReadPage {
  requestedStart: ActivityLocation
  start: ActivityLocation
  end: ActivityLocation
  next?: ActivityLocation
  eof: boolean
  chunks: ActivityReadChunk[]
  returnedCharacters: number
  returnedActivities: number
  requestedLimit: number
  appliedLimit: number
}

export function formatActivityLocation(location: ActivityLocation): string {
  return `A${String(location.activity).padStart(6, '0')}:C${location.offset}`
}

export function compareActivityLocations(left: ActivityLocation, right: ActivityLocation): number {
  if (left.activity !== right.activity) return left.activity - right.activity
  return left.offset - right.offset
}

function assertLocation(activity: CanonicalActivity, location: ActivityLocation): void {
  const item = activity.items[location.activity - 1]
  if (
    !Number.isSafeInteger(location.activity)
    || location.activity < 1
    || location.activity > activity.items.length
    || !Number.isSafeInteger(location.offset)
    || location.offset < 0
    || location.offset > (item?.content.length ?? -1)
    || splitsSurrogatePair(item.content, location.offset)
  ) {
    throw new Error('Canonical Activity Location 无效或切开了 Unicode 字符')
  }
}

function nextItemLocation(
  activity: CanonicalActivity,
  currentActivity: number
): ActivityLocation | undefined {
  return currentActivity < activity.items.length
    ? { activity: currentActivity + 1, offset: 0 }
    : undefined
}

export function readActivityPage(
  activity: CanonicalActivity,
  requestedStart: ActivityLocation,
  requestedLimit: number
): ActivityReadPage {
  if (!activity.items.length) throw new Error('Canonical Activity 没有可读取内容')
  assertLocation(activity, requestedStart)
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error('Canonical Activity page limit 必须是正整数')
  }

  const start = { ...requestedStart }
  let appliedLimit = Math.min(requestedLimit, MAX_ACTIVITY_READ_LIMIT)
  const startItem = activity.items[start.activity - 1]
  if (
    appliedLimit === 1
    && splitsSurrogatePair(startItem.content, start.offset + 1)
  ) appliedLimit = 2
  const chunks: ActivityReadChunk[] = []
  let current: ActivityLocation | undefined = { ...start }
  let remaining = appliedLimit
  let returnedCharacters = 0

  while (current && remaining > 0 && chunks.length < MAX_ACTIVITY_READ_ITEMS) {
    const item = activity.items[current.activity - 1]
    const available = item.content.length - current.offset
    if (available <= 0) {
      current = nextItemLocation(activity, current.activity)
      continue
    }

    let endOffset = current.offset + Math.min(available, remaining)
    if (splitsSurrogatePair(item.content, endOffset)) endOffset--
    if (endOffset === current.offset) break
    const content = item.content.slice(current.offset, endOffset)
    chunks.push({
      activity: current.activity,
      startOffset: current.offset,
      endOffset,
      totalCharacters: item.content.length,
      item,
      content
    })
    const consumed = endOffset - current.offset
    returnedCharacters += consumed
    remaining -= consumed

    current = endOffset < item.content.length
      ? { activity: current.activity, offset: endOffset }
      : nextItemLocation(activity, current.activity)
  }

  const eof = current === undefined
  const end = current ?? {
    activity: activity.items.length,
    offset: activity.items.at(-1)!.content.length
  }
  return {
    requestedStart: { ...requestedStart },
    start,
    end: { ...end },
    ...(current ? { next: { ...current } } : {}),
    eof,
    chunks,
    returnedCharacters,
    returnedActivities: chunks.length,
    requestedLimit,
    appliedLimit
  }
}

function rawSources(item: CanonicalActivityItem): string {
  const locations = item.rawRanges.map((range) => formatEvidenceLocation(range.start))
  return [...new Set(locations)].join(', ')
}

function formatActivityChunk(chunk: ActivityReadChunk): string {
  const continuation = chunk.startOffset === 0 && chunk.endOffset === chunk.totalCharacters
    ? ''
    : ` · content ${chunk.startOffset}-${chunk.endOffset} of ${chunk.totalCharacters}`
  return [
    `BEGIN_ACTIVITY ${formatActivityLocation({ activity: chunk.activity, offset: chunk.startOffset })} · ${chunk.item.kind}${continuation}`,
    `Raw source: ${rawSources(chunk.item)}`,
    chunk.content,
    'END_ACTIVITY'
  ].join('\n')
}

export function formatActivityReadPage(page: ActivityReadPage): string {
  return [
    `Requested start: ${formatActivityLocation(page.requestedStart)}`,
    `Returned range (end exclusive): ${formatActivityLocation(page.start)}-${formatActivityLocation(page.end)}`,
    `Returned activity characters: ${page.returnedCharacters}`,
    `Applied limit: ${page.appliedLimit}${page.requestedLimit === page.appliedLimit ? '' : ` (requested ${page.requestedLimit})`}`,
    `Next: ${page.next ? formatActivityLocation(page.next) : 'none (EOF)'}`,
    `EOF: ${page.eof ? 'true' : 'false'}`,
    ...page.chunks.map(formatActivityChunk)
  ].join('\n')
}

export function activityRawLines(item: CanonicalActivityItem): number[] {
  return [...new Set(item.rawRanges.map((range) => range.start.line))]
}

export function evidenceLocationAtLine(line: number): EvidenceLocation {
  return { line, offset: 0 }
}
