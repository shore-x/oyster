import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { planKnowledgeTaskInput } from '../src/main/knowledge-processing/task-input'
import type {
  AgentObservation,
  CanonicalActivityAttachment
} from '../src/main/observation/model'

function attachment(
  id: string,
  mimeType: string,
  content: string,
  line: number
): CanonicalActivityAttachment {
  return {
    id,
    mimeType,
    data: Buffer.from(content).toString('base64'),
    byteLength: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    rawRange: {
      start: { line, offset: 0 },
      end: { line, offset: content.length }
    }
  }
}

function observation(): AgentObservation {
  return {
    rawEvidence: {
      formatVersion: 'test-raw-v1',
      lines: ['first raw line', '', 'third raw line'],
      skillHints: [{
        name: 'imagegen',
        tool: 'Read',
        source: 'tool_call',
        location: { line: 2, offset: 0 }
      }]
    },
    canonicalActivity: {
      formatVersion: 'test-activity-v1',
      items: [{
        kind: 'user_message',
        content: 'First activity',
        rawRanges: [{
          start: { line: 1, offset: 2 },
          end: { line: 2, offset: 0 }
        }]
      }, {
        kind: 'attachment',
        content: 'Attached document',
        rawRanges: [{
          start: { line: 3, offset: 1 },
          end: { line: 3, offset: 12 }
        }],
        attachmentId: 'ATT000001'
      }],
      attachments: [
        attachment('ATT000001', 'application/pdf', 'document', 3),
        attachment('ATT000002', 'application/x-custom', 'sidecar', 1)
      ]
    }
  }
}

describe('Knowledge Task input plan', () => {
  it('materializes one Activity document and exact Raw Evidence without indexes or pages', () => {
    const input = observation()
    const value = planKnowledgeTaskInput(input)

    expect(value.files.map((file) => file.relativePath)).toEqual([
      'inputs/activity.md',
      'inputs/evidence.txt',
      'inputs/attachments/ATT000001.bin',
      'inputs/attachments/ATT000002.bin'
    ])
    expect(value.files.find((file) => file.relativePath === 'inputs/evidence.txt')?.content)
      .toBe(input.rawEvidence.lines.join('\n'))
    expect(value.files.some((file) => /README|INDEX|segment|page-/.test(file.relativePath)))
      .toBe(false)
    expect(value.items).toEqual([
      'Read `inputs/activity.md` through EOF and inspect every attachment it references.'
    ])
  })

  it('keeps ordered activities, complete Raw Evidence ranges, formats and navigation hints', () => {
    const value = planKnowledgeTaskInput(observation())
    const activity = String(
      value.files.find((file) => file.relativePath === 'inputs/activity.md')?.content
    )

    expect(activity).toContain('Canonical Activity format: test-activity-v1')
    expect(activity).toContain('Raw Evidence format: test-raw-v1')
    expect(activity).toContain('Raw Evidence: inputs/evidence.txt')
    expect(activity).toContain('Raw source: L000001:C2-L000002:C0')
    expect(activity).toContain('Raw source: L000003:C1-L000003:C12')
    expect(activity.indexOf('First activity')).toBeLessThan(activity.indexOf('Attached document'))
    expect(activity).toContain('possible Skill activation “imagegen” · at L000002:C0 · via Read')
    expect(activity).toContain('untrusted navigation aids')
  })

  it('lists and materializes every attachment, including unreferenced non-image sidecars', () => {
    const value = planKnowledgeTaskInput(observation())
    const activity = String(
      value.files.find((file) => file.relativePath === 'inputs/activity.md')?.content
    )
    const pdf = value.files.find((file) => file.relativePath.endsWith('ATT000001.bin'))
    const custom = value.files.find((file) => file.relativePath.endsWith('ATT000002.bin'))

    expect(activity).toContain('`inputs/attachments/ATT000001.bin` | application/pdf')
    expect(activity).toContain('`inputs/attachments/ATT000002.bin` | application/x-custom')
    expect(activity).toContain('Attachment: ATT000001 · inputs/attachments/ATT000001.bin')
    expect(Buffer.from(pdf!.content).toString()).toBe('document')
    expect(Buffer.from(custom!.content).toString()).toBe('sidecar')
  })

  it('rejects attachment bytes that do not match their metadata', () => {
    const input = observation()
    input.canonicalActivity.attachments[0].sha256 = '0'.repeat(64)

    expect(() => planKnowledgeTaskInput(input)).toThrow('内容与 metadata 不一致')
  })
})
