export type FolderEntryKind = 'directory' | 'file' | 'symlink' | 'other'

interface FolderEntryBase {
  name: string
  /** Absolute filesystem path of this entry. */
  path: string
  kind: FolderEntryKind
}

export interface FolderDirectoryEntry extends FolderEntryBase {
  kind: 'directory'
  entries: FolderEntry[]
}

export interface FolderFileEntry extends FolderEntryBase {
  kind: 'file'
}

export interface FolderSymbolicLinkEntry extends FolderEntryBase {
  kind: 'symlink'
}

export interface FolderOtherEntry extends FolderEntryBase {
  kind: 'other'
}

export type FolderEntry =
  | FolderDirectoryEntry
  | FolderFileEntry
  | FolderSymbolicLinkEntry
  | FolderOtherEntry

export interface FolderSnapshot {
  /** Normalized absolute path of the browsed root directory. */
  path: string
  entries: FolderEntry[]
}

export interface FolderFile {
  /** Normalized absolute path of the read file. */
  path: string
  size: number
  /** Uninterpreted file bytes. */
  content: Uint8Array
}

export interface FolderBrowserApi {
  getDesignDocumentsPath(): Promise<string>
  browseFolder(folderPath: string): Promise<FolderSnapshot>
  readFile(filePath: string): Promise<FolderFile>
}
