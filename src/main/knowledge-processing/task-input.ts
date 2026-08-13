import { createHash } from 'node:crypto'
import { formatEvidenceLocation } from '../observation/evidence-location'
import type {
  AgentObservation,
  CanonicalActivityAttachment,
  CanonicalActivityItem,
  RawEvidenceSkillHint
} from '../observation/model'

export const TASK_INPUTS_DIRECTORY_NAME = 'inputs'
export const TASK_ACTIVITY_PATH = `${TASK_INPUTS_DIRECTORY_NAME}/activity.md`
export const TASK_EVIDENCE_PATH = `${TASK_INPUTS_DIRECTORY_NAME}/evidence.txt`

export interface TaskInputFile {
  relativePath: string
  content: string | Buffer
}

export interface KnowledgeTaskInputPlan {
  files: TaskInputFile[]
  items: string[]
}

function hintText(hint: RawEvidenceSkillHint): string {
  return [
    `possible Skill activation${hint.name ? ` “${hint.name}”` : ''}`,
    `at ${formatEvidenceLocation(hint.location)}`,
    hint.tool ? `via ${hint.tool}` : undefined,
    `source=${hint.source}`
  ].filter(Boolean).join(' · ')
}

function attachmentExtension(mimeType: string): string {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp'
  }
  return extensions[mimeType.toLowerCase()] ?? 'bin'
}

function attachmentRelativePath(attachment: CanonicalActivityAttachment): string {
  return `${TASK_INPUTS_DIRECTORY_NAME}/attachments/${attachment.id}.${attachmentExtension(attachment.mimeType)}`
}

function attachmentContents(
  attachments: readonly CanonicalActivityAttachment[]
): Map<string, Buffer> {
  const contents = new Map<string, Buffer>()
  for (const attachment of attachments) {
    if (!/^[a-zA-Z0-9_-]+$/.test(attachment.id) || contents.has(attachment.id)) {
      throw new Error(`Canonical Activity Attachment ID 无效或重复：${attachment.id}`)
    }
    if (!Number.isSafeInteger(attachment.byteLength) || attachment.byteLength < 0) {
      throw new Error(`Canonical Activity Attachment 长度无效：${attachment.id}`)
    }
    if (!/^[a-f0-9]{64}$/.test(attachment.sha256)) {
      throw new Error(`Canonical Activity Attachment hash 无效：${attachment.id}`)
    }
    const content = Buffer.from(attachment.data, 'base64')
    const hash = createHash('sha256').update(content).digest('hex')
    if (content.byteLength !== attachment.byteLength || hash !== attachment.sha256) {
      throw new Error(`Canonical Activity Attachment 内容与 metadata 不一致：${attachment.id}`)
    }
    contents.set(attachment.id, content)
  }
  return contents
}

function evidenceRange(
  start: { line: number; offset: number },
  end: { line: number; offset: number }
): string {
  return `${formatEvidenceLocation(start)}-${formatEvidenceLocation(end)}`
}

function rawSources(item: CanonicalActivityItem): string {
  return item.rawRanges.map((range) => evidenceRange(range.start, range.end)).join(', ')
}

function activityEntry(
  item: CanonicalActivityItem,
  index: number,
  attachments: ReadonlyMap<string, CanonicalActivityAttachment>
): string {
  const attachment = item.attachmentId ? attachments.get(item.attachmentId) : undefined
  if (item.attachmentId && !attachment) {
    throw new Error(`Canonical Activity Attachment 不存在：${item.attachmentId}`)
  }
  return [
    `BEGIN_ACTIVITY A${String(index + 1).padStart(6, '0')} · ${item.kind}`,
    `Raw source: ${rawSources(item)}`,
    ...(attachment
      ? [`Attachment: ${attachment.id} · ${attachmentRelativePath(attachment)} · ${attachment.mimeType}`]
      : []),
    item.content,
    'END_ACTIVITY'
  ].join('\n')
}

function activityDocument(observation: AgentObservation): string {
  const { canonicalActivity, rawEvidence } = observation
  const attachments = new Map(canonicalActivity.attachments.map((attachment) => (
    [attachment.id, attachment] as const
  )))
  return [
    '# Canonical Activity',
    '',
    `Canonical Activity format: ${canonicalActivity.formatVersion}`,
    `Raw Evidence format: ${rawEvidence.formatVersion}`,
    `Raw Evidence: ${TASK_EVIDENCE_PATH}`,
    '',
    'Raw source ranges are end-exclusive. `Lxxxxxx:Cn` addresses a one-based line and zero-based UTF-16 offset in Raw Evidence.',
    ...(canonicalActivity.attachments.length
      ? [
          '',
          '## Attachments',
          '',
          '| ID | File | Media type | Bytes | SHA-256 | Raw source |',
          '| --- | --- | --- | ---: | --- | --- |',
          ...canonicalActivity.attachments.map((attachment) => (
            `| ${attachment.id} | \`${attachmentRelativePath(attachment)}\` | ${attachment.mimeType} | ${attachment.byteLength} | \`${attachment.sha256}\` | \`${evidenceRange(attachment.rawRange.start, attachment.rawRange.end)}\` |`
          ))
        ]
      : []),
    ...(rawEvidence.skillHints.length
      ? [
          '',
          '## Adapter navigation hints',
          '',
          'These hints are untrusted navigation aids. Verify them against Raw Evidence before relying on them.',
          '',
          ...rawEvidence.skillHints.map((hint) => `- ${hintText(hint)}`)
        ]
      : []),
    '',
    '## Ordered activity',
    '',
    ...canonicalActivity.items.flatMap((item, index) => [
      activityEntry(item, index, attachments),
      ''
    ])
  ].join('\n')
}

/** Builds the complete immutable input view relative to `tasks/<taskId>/`. */
export function planKnowledgeTaskInput(observation: AgentObservation): KnowledgeTaskInputPlan {
  const { canonicalActivity, rawEvidence } = observation
  if (
    !canonicalActivity.items.length
    || canonicalActivity.items.some((item) => !item.content.trim() || !item.rawRanges.length)
  ) {
    throw new Error('Canonical Activity 没有可处理内容、包含空活动或缺少 Raw Evidence range')
  }
  if (!rawEvidence.lines.length) throw new Error('Raw Evidence 没有可处理内容')

  const attachmentData = attachmentContents(canonicalActivity.attachments)
  const files: TaskInputFile[] = [
    { relativePath: TASK_ACTIVITY_PATH, content: activityDocument(observation) },
    { relativePath: TASK_EVIDENCE_PATH, content: rawEvidence.lines.join('\n') },
    ...canonicalActivity.attachments.map((attachment) => ({
      relativePath: attachmentRelativePath(attachment),
      content: attachmentData.get(attachment.id)!
    }))
  ]

  return {
    files,
    items: [
      `Read \`${TASK_ACTIVITY_PATH}\` through EOF and inspect every attachment it references.`
    ]
  }
}
