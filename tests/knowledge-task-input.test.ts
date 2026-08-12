import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  activitySegmentCharacterLimit,
  planKnowledgeTaskInput
} from '../src/main/knowledge-processing/task-input'
import type { AgentObservation } from '../src/main/observation/model'

function observation(contents: string[], attachmentAt?: number): AgentObservation {
  const lines = contents.map((content) => JSON.stringify({ content }))
  return {
    rawEvidence: {
      formatVersion: 'test-raw-v1',
      lines,
      skillHints: attachmentAt === undefined ? [] : [{
        name: 'imagegen',
        tool: 'Read',
        source: 'tool_call',
        location: { line: attachmentAt + 1, offset: 0 }
      }]
    },
    canonicalActivity: {
      formatVersion: 'test-activity-v1',
      items: contents.map((content, index) => ({
        kind: attachmentAt === index ? 'attachment' : 'user_message',
        content,
        rawRanges: [{
          start: { line: index + 1, offset: 0 },
          end: { line: index + 1, offset: lines[index].length }
        }],
        ...(attachmentAt === index ? { attachmentId: 'ATT000001' } : {})
      })),
      attachments: attachmentAt === undefined ? [] : [{
        id: 'ATT000001',
        mimeType: 'image/png',
        data: Buffer.from('image').toString('base64'),
        byteLength: 5,
        sha256: createHash('sha256').update('image').digest('hex'),
        rawRange: {
          start: { line: attachmentAt + 1, offset: 0 },
          end: { line: attachmentAt + 1, offset: lines[attachmentAt].length }
        }
      }]
    }
  }
}

function plan(contents: string[], limit: number, attachmentAt?: number) {
  return planKnowledgeTaskInput(
    observation(contents, attachmentAt),
    'raw:test@sha256:fixture',
    limit
  )
}

describe('Knowledge Task worktree plan', () => {
  it('writes bounded Activity files and keeps complete activities together', () => {
    const value = plan(['a'.repeat(7), 'b'.repeat(7)], 10)

    expect(value.activitySegmentCount).toBe(2)
    expect(value.items[0]).toContain('inputs/activity/segment-000001-page-000001.md')
    expect(value.items[0]).not.toContain('segment-000002')
    expect(value.items[1]).toContain('inputs/activity/segment-000002-page-000001.md')
    expect(value.files.find((file) => file.relativePath.includes('segment-000001'))?.content)
      .toContain('a'.repeat(7))
  })

  it('splits an oversized activity without breaking its identity or Unicode characters', () => {
    const oversized = plan(['A😀B'.repeat(10)], 5)

    expect(oversized.activitySegmentCount).toBeGreaterThan(1)
    const activityFiles = oversized.files.filter((file) => file.relativePath.includes('/activity/'))
    expect(activityFiles).toHaveLength(oversized.activitySegmentCount)
    expect(activityFiles.every((file) => String(file.content).includes('BEGIN_ACTIVITY A000001')))
      .toBe(true)
    expect(activityFiles.map((file) => String(file.content)).join('')).not.toContain('�')
  })

  it('materializes Raw Evidence pages, an index, and real attachment bytes', () => {
    const value = plan(['message', 'attachment'], 100, 1)
    const attachment = value.files.find((file) => file.relativePath.endsWith('ATT000001.png'))
    const evidenceIndex = value.files.find((file) => file.relativePath.endsWith('evidence/INDEX.md'))

    expect(value.items[0]).toContain('inputs/attachments/ATT000001.png')
    expect(value.items[0]).toContain('possible Skill activation “imagegen”')
    expect(value.items[0]).toContain('inputs/evidence/INDEX.md')
    expect(value.items[0]).not.toContain('read_activity')
    expect(value.items[0]).not.toContain('read_evidence')
    expect(Buffer.isBuffer(attachment?.content)).toBe(true)
    expect(Buffer.from(attachment!.content).toString()).toBe('image')
    expect(evidenceIndex?.content).toContain('L000001:C0')
  })

  it('creates a self-describing input guide inside this Task only', () => {
    const value = plan(['message'], 100)
    const guide = value.files.find((file) => file.relativePath === 'inputs/README.md')

    expect(guide?.content).toContain('raw:test@sha256:fixture')
    expect(guide?.content).toContain('fixed input view materialized when this Knowledge Processing Task is accepted')
    expect(guide?.content).toContain('exact external content bytes successfully read')
    expect(guide?.content).not.toContain('external source revision')
    expect(value.files.every((file) => !file.relativePath.startsWith('/'))).toBe(true)
  })

  it('rejects attachment bytes that do not match their metadata', () => {
    const input = observation(['attachment'], 0)
    input.canonicalActivity.attachments[0].sha256 = '0'.repeat(64)

    expect(() => planKnowledgeTaskInput(input, 'raw:test', 100))
      .toThrow('内容与 metadata 不一致')
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
