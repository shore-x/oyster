import { describe, expect, it } from 'vitest'
import {
  formatActivityReadPage,
  readActivityPage
} from '../src/main/observation/activity-location'
import type { CanonicalActivity } from '../src/main/observation/model'

function activity(contents: string[]): CanonicalActivity {
  return {
    formatVersion: 'test-activity-v1',
    items: contents.map((content, index) => ({
      kind: index === 0 ? 'user_message' : 'tool_result',
      content,
      rawRanges: [{
        start: { line: index + 10, offset: 0 },
        end: { line: index + 10, offset: content.length }
      }]
    })),
    attachments: []
  }
}

describe('Canonical Activity reader', () => {
  it('returns readable activity blocks with Raw Evidence locators', () => {
    const page = readActivityPage(activity(['User asked for Oyster.', 'Tool returned a result.']), {
      activity: 1,
      offset: 0
    }, 100)
    const text = formatActivityReadPage(page)

    expect(text).toContain('BEGIN_ACTIVITY A000001:C0 · user_message')
    expect(text).toContain('Raw source: L000010:C0')
    expect(text).toContain('User asked for Oyster.')
    expect(text).toContain('BEGIN_ACTIVITY A000002:C0 · tool_result')
    expect(page.eof).toBe(true)
  })

  it('repeats activity identity when one long semantic item requires continuation pages', () => {
    const source = activity(['A'.repeat(20)])
    const first = readActivityPage(source, { activity: 1, offset: 0 }, 8)
    const second = readActivityPage(source, first.next!, 8)

    expect(first.next).toEqual({ activity: 1, offset: 8 })
    expect(formatActivityReadPage(first)).toContain('content 0-8 of 20')
    expect(formatActivityReadPage(second)).toContain('BEGIN_ACTIVITY A000001:C8')
  })

  it('does not split a Unicode surrogate pair', () => {
    const source = activity(['A😀B'])
    const first = readActivityPage(source, { activity: 1, offset: 0 }, 1)
    const second = readActivityPage(source, first.next!, 1)

    expect(first.next).toEqual({ activity: 1, offset: 1 })
    expect(second.chunks[0].content).toBe('😀')
  })
})
