import {
  lstat,
  readFile as readFileBytes,
  readdir
} from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  FolderEntry,
  FolderEntryKind,
  FolderFile,
  FolderSnapshot
} from '../../shared/folder-browser'

function requiredAbsolutePath(value: unknown, field: 'folderPath' | 'filePath'): string {
  if (typeof value !== 'string' || !value) throw new Error(`${field} 必须是非空字符串`)
  if (!isAbsolute(value)) throw new Error(`${field} 必须是绝对路径`)
  return resolve(value)
}

function missingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function entryKind(entry: Dirent): FolderEntryKind {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (entry.isSymbolicLink()) return 'symlink'
  return 'other'
}

function compareNames(left: Dirent, right: Dirent): number {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

async function readDirectoryEntries(directoryPath: string): Promise<FolderEntry[]> {
  let directoryEntries: Dirent[]
  try {
    directoryEntries = await readdir(directoryPath, { withFileTypes: true })
  } catch (error) {
    if (missingPath(error)) {
      throw new Error(`浏览期间目录已不存在：${directoryPath}`, { cause: error })
    }
    throw new Error(`无法读取目录 ${directoryPath}：${errorMessage(error)}`, { cause: error })
  }

  const result: FolderEntry[] = []
  for (const entry of directoryEntries.sort(compareNames)) {
    const path = join(directoryPath, entry.name)
    const kind = entryKind(entry)
    if (kind === 'directory') {
      result.push({
        name: entry.name,
        path,
        kind,
        entries: await readDirectoryEntries(path)
      })
    } else {
      // Symbolic links are represented as leaf entries and are never traversed.
      result.push({ name: entry.name, path, kind })
    }
  }
  return result
}

/** Read-only browser over an explicitly supplied absolute filesystem path. */
export class FolderBrowserService {
  async resolveFolderPath(folderPath: string): Promise<string> {
    const path = requiredAbsolutePath(folderPath, 'folderPath')
    let details
    try {
      details = await lstat(path)
    } catch (error) {
      if (missingPath(error)) throw new Error(`Folder 不存在：${path}`, { cause: error })
      throw new Error(`无法读取 Folder ${path}：${errorMessage(error)}`, { cause: error })
    }
    if (!details.isDirectory()) throw new Error(`Folder 路径不是目录：${path}`)
    return path
  }

  async browseFolder(folderPath: string): Promise<FolderSnapshot> {
    const path = await this.resolveFolderPath(folderPath)

    return {
      path,
      entries: await readDirectoryEntries(path)
    }
  }

  async readFile(filePath: string): Promise<FolderFile> {
    const path = requiredAbsolutePath(filePath, 'filePath')
    let details
    try {
      details = await lstat(path)
    } catch (error) {
      if (missingPath(error)) throw new Error(`文件不存在：${path}`, { cause: error })
      throw new Error(`无法读取文件 ${path}：${errorMessage(error)}`, { cause: error })
    }
    if (!details.isFile()) throw new Error(`路径不是普通文件：${path}`)

    let content: Buffer
    try {
      content = await readFileBytes(path)
    } catch (error) {
      if (missingPath(error)) throw new Error(`文件已不存在：${path}`, { cause: error })
      throw new Error(`无法读取文件 ${path}：${errorMessage(error)}`, { cause: error })
    }
    return {
      path,
      size: content.byteLength,
      content: new Uint8Array(content)
    }
  }
}
