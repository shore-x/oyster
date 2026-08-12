import { constants, type Stats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ArtifactSkillSummary } from '../../shared/artifacts'
import {
  skillMetadataFields,
  validateSkillMetadata
} from '../skills/skill-metadata'

const METADATA_HEAD_BYTES = 64 * 1024
export const MAX_MANAGED_SKILL_PREVIEW_BYTES = 2 * 1024 * 1024
const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW

export interface ArtifactSkillDocumentFile {
  documentPath: string
  content: string
  sizeBytes: number
  modifiedAt: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function missingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function invalidSkill(
  skillPath: string,
  issue: string,
  documentPath: string,
  fields: { name?: string; description?: string } = {}
): ArtifactSkillSummary {
  return {
    skillPath,
    documentPath,
    name: fields.name,
    description: fields.description,
    status: 'invalid',
    issue
  }
}

async function readDocumentHead(handle: FileHandle, details: Stats): Promise<string> {
  const bytesToRead = Math.min(details.size, METADATA_HEAD_BYTES)
  const buffer = Buffer.alloc(bytesToRead)
  const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
  // The bounded prefix can end midway through a UTF-8 sequence. Metadata parsing is
  // best-effort here; the on-demand full preview still requires valid UTF-8.
  return new TextDecoder('utf-8').decode(buffer.subarray(0, bytesRead))
}

async function openRegularDocument(documentPath: string): Promise<{
  handle: FileHandle
  details: Stats
}> {
  let handle: FileHandle
  try {
    handle = await open(documentPath, READ_ONLY_NO_FOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('SKILL.md 必须是普通文件')
    }
    throw error
  }
  try {
    const details = await handle.stat()
    if (!details.isFile()) throw new Error('SKILL.md 必须是普通文件')
    return { handle, details }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/**
 * Derives the Skill application view from one already-valid Artifact directory.
 * A root SKILL.md is the standard filesystem declaration of Skill intent.
 */
export async function inspectArtifactSkill(
  artifactPath: string
): Promise<ArtifactSkillSummary | undefined> {
  const skillPath = resolve(artifactPath)
  const documentPath = join(skillPath, 'SKILL.md')
  let documentDetails
  try {
    documentDetails = await lstat(documentPath)
  } catch (error) {
    if (missingPath(error)) return undefined
    return invalidSkill(skillPath, `无法读取 SKILL.md：${errorMessage(error)}`, documentPath)
  }

  if (!documentDetails.isFile() || documentDetails.isSymbolicLink()) {
    return invalidSkill(skillPath, 'SKILL.md 必须是普通文件', documentPath)
  }

  let opened
  try {
    opened = await openRegularDocument(documentPath)
    const fields = skillMetadataFields(await readDocumentHead(opened.handle, opened.details))
    try {
      const metadata = validateSkillMetadata(fields)
      return {
        skillPath,
        documentPath,
        name: metadata.name,
        description: metadata.description,
        status: 'ready'
      }
    } catch (error) {
      return invalidSkill(skillPath, errorMessage(error), documentPath, fields)
    }
  } catch (error) {
    return invalidSkill(
      skillPath,
      `无法读取 SKILL.md：${errorMessage(error)}`,
      documentPath
    )
  } finally {
    await opened?.handle.close()
  }
}

/** Reads the entry document without interpreting or executing any accompanying files. */
export async function readArtifactSkillDocument(
  artifactPath: string
): Promise<ArtifactSkillDocumentFile> {
  const documentPath = join(resolve(artifactPath), 'SKILL.md')
  let opened
  try {
    opened = await openRegularDocument(documentPath)
    if (opened.details.size > MAX_MANAGED_SKILL_PREVIEW_BYTES) {
      throw new Error('Skill 文档超过 2 MiB，无法在应用内预览')
    }
    const buffer = Buffer.alloc(opened.details.size)
    const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, 0)
    const content = new TextDecoder('utf-8', { fatal: true })
      .decode(buffer.subarray(0, bytesRead))
    return {
      documentPath,
      content,
      sizeBytes: opened.details.size,
      modifiedAt: opened.details.mtime.toISOString()
    }
  } catch (error) {
    if (missingPath(error)) throw new Error('Skill 文档已不存在')
    throw error
  } finally {
    await opened?.handle.close()
  }
}
