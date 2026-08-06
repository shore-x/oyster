import { describe, expect, it } from 'vitest'
import {
  activitySegmentCharacterLimit,
  planActivityWork
} from '../src/main/knowledge-processing/activity-work-plan'
import type { CanonicalActivity } from '../src/main/observation/model'

function activity(contents: string[], attachmentAt?: number): CanonicalActivity {
  return {
    formatVersion: 'test-activity-v1',
    items: contents.map((content, index) => ({
      kind: attachmentAt === index ? 'attachment' : 'user_message',
      content,
      rawRanges: [{
        start: { line: index + 1, offset: 0 },
        end: { line: index + 1, offset: content.length }
      }],
      ...(attachmentAt === index ? { attachmentId: 'ATT000001' } : {})
    })),
    attachments: attachmentAt === undefined ? [] : [{
      id: 'ATT000001',
      mimeType: 'image/png',
      data: 'aW1hZ2U=',
      byteLength: 5,
      sha256: '0'.repeat(64),
      rawRange: {
        start: { line: attachmentAt + 1, offset: 0 },
        end: { line: attachmentAt + 1, offset: contents[attachmentAt].length }
      }
    }]
  }
}

describe('planActivityWork', () => {
  it('keeps complete activities together instead of filling character tails with fragments', () => {
    const plan = planActivityWork(activity(['a'.repeat(7), 'b'.repeat(7)]), [], 10)

    expect(plan.segmentCount).toBe(2)
    expect(plan.items[0]).toContain('read_activity({"activity":1,"offset":0,"limit":7})')
    expect(plan.items[0]).not.toContain('"activity":2')
    expect(plan.items[1]).toContain('read_activity({"activity":2,"offset":0,"limit":7})')
  })

  it('splits only an individually oversized activity and preserves its identity', () => {
    const plan = planActivityWork(activity(['x'.repeat(25)]), [], 10)

    expect(plan.segmentCount).toBe(3)
    expect(plan.items[0]).toContain('read_activity({"activity":1,"offset":0,"limit":10})')
    expect(plan.items[1]).toContain('read_activity({"activity":1,"offset":10,"limit":10})')
    expect(plan.items[2]).toContain('read_activity({"activity":1,"offset":20,"limit":5})')
  })

  it('can plan a final one-character activity page', () => {
    const plan = planActivityWork(activity(['x']), [], 2)

    expect(plan.segmentCount).toBe(1)
    expect(plan.items[0]).toContain('read_activity({"activity":1,"offset":0,"limit":1})')
  })

  it('does not place a segment boundary inside a Unicode surrogate pair', () => {
    const plan = planActivityWork(activity(['A😀B']), [], 2)

    expect(plan.segmentCount).toBe(3)
    expect(plan.items[0]).toContain('read_activity({"activity":1,"offset":0,"limit":1})')
    expect(plan.items[1]).toContain('read_activity({"activity":1,"offset":1,"limit":2})')
    expect(plan.items[2]).toContain('read_activity({"activity":1,"offset":3,"limit":1})')
  })

  it('binds attachment inspection and a Raw Evidence Skill hint to the related segment', () => {
    const plan = planActivityWork(activity(['message', 'attachment'], 1), [{
      name: 'imagegen',
      tool: 'Read',
      source: 'tool_call',
      location: { line: 2, offset: 0 }
    }], 100)

    expect(plan.items[0]).toContain('read_activity_attachment({"id":"ATT000001"})')
    expect(plan.items[0]).toContain('possible Skill activation “imagegen”')
    expect(plan.items[0]).toContain('read_evidence')
  })
})

describe('activitySegmentCharacterLimit', () => {
  it('uses half of the declared context with an upper bound', () => {
    expect(activitySegmentCharacterLimit(8_000)).toBe(4_000)
    expect(activitySegmentCharacterLimit(128_000)).toBe(64_000)
    expect(activitySegmentCharacterLimit(0)).toBe(16 * 1_024)
    expect(activitySegmentCharacterLimit(1_000_000)).toBe(256 * 1_024)
  })
})
