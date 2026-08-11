import { createMemo, createSignal } from 'solid-js'
import type {
  FolderBrowserApi,
  FolderEntry,
  FolderFile,
  FolderSnapshot
} from '../../shared/folder-browser'
import { uiText } from './i18n'

export type FolderBrowserDocument =
  | {
      kind: 'markdown' | 'text'
      path: string
      size: number
      text: string
    }
  | {
      kind: 'unsupported'
      path: string
      size: number
      reason: 'invalid-utf8'
    }

export type FolderBrowserLinkPreview =
  | {
      kind: 'loading'
      target: string
      path?: string
    }
  | {
      kind: 'ready'
      target: string
      document: FolderBrowserDocument
    }
  | {
      kind: 'error'
      target: string
      path?: string
      message: string
    }

function api(): FolderBrowserApi {
  return (window.oyster as typeof window.oyster & { folderBrowser: FolderBrowserApi }).folderBrowser
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function firstFile(entries: readonly FolderEntry[]): FolderEntry | undefined {
  for (const entry of entries) {
    if (entry.kind === 'file') return entry
    if (entry.kind === 'directory') {
      const nested = firstFile(entry.entries)
      if (nested) return nested
    }
  }
  return undefined
}

function decodeTarget(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Resolves a Markdown file link lexically from the current document path. */
export function resolveFolderFileTargets(currentPath: string, target: string): string[] {
  const withoutFragment = target.split('#', 1)[0].trim()
  if (!withoutFragment) return []

  const separator = /^[a-z]:\\/iu.test(currentPath)
    || (currentPath.includes('\\') && !currentPath.includes('/'))
    ? '\\'
    : '/'
  const normalizedCurrent = currentPath.replaceAll(separator === '/' ? '\\' : '/', separator)
  const lastSeparator = normalizedCurrent.lastIndexOf(separator)
  const directory = lastSeparator >= 0 ? normalizedCurrent.slice(0, lastSeparator) : ''
  const relativeTarget = decodeTarget(withoutFragment).replace(/[\\/]/gu, separator)
  const combined = directory ? `${directory}${separator}${relativeTarget}` : relativeTarget

  let prefix: 'drive' | 'root' | 'unc' | 'relative' = 'relative'
  let drive = ''
  let remainder = combined
  if (separator === '\\' && combined.startsWith('\\\\')) {
    prefix = 'unc'
    remainder = combined.slice(2)
  } else if (separator === '\\' && /^[a-z]:/iu.test(combined)) {
    prefix = 'drive'
    drive = combined.slice(0, 2)
    remainder = combined.slice(2).replace(/^\\+/u, '')
  } else if (combined.startsWith(separator)) {
    prefix = 'root'
    remainder = combined.slice(1)
  }

  const parts: string[] = []
  for (const part of remainder.split(separator)) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop()
      else if (prefix === 'relative') parts.push(part)
      continue
    }
    parts.push(part)
  }

  const suffix = parts.join(separator)
  const resolved = prefix === 'drive'
    ? `${drive}${separator}${suffix}`
    : prefix === 'unc'
      ? `\\\\${suffix}`
      : prefix === 'root'
        ? `${separator}${suffix}`
        : suffix
  const basename = parts.at(-1) || ''
  return /\.[^./\\]+$/u.test(basename)
    ? [resolved]
    : [resolved, `${resolved}.md`]
}

export function decodeFolderFile(file: FolderFile): FolderBrowserDocument {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(file.content)
    return {
      kind: /\.md$/iu.test(file.path) ? 'markdown' : 'text',
      path: file.path,
      size: file.size,
      text
    }
  } catch {
    return {
      kind: 'unsupported',
      path: file.path,
      size: file.size,
      reason: 'invalid-utf8'
    }
  }
}

export function createFolderBrowserController() {
  const [snapshot, setSnapshot] = createSignal<FolderSnapshot>()
  const [selectedPath, setSelectedPath] = createSignal<string>()
  const [document, setDocument] = createSignal<FolderBrowserDocument>()
  const [loadingFolder, setLoadingFolder] = createSignal(false)
  const [loadingFile, setLoadingFile] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [linkPreview, setLinkPreview] = createSignal<FolderBrowserLinkPreview>()
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  let history: string[] = []
  let folderGeneration = 0
  let fileGeneration = 0
  let previewGeneration = 0

  const canGoBack = createMemo(() => historyIndex() > 0)
  const canGoForward = createMemo(() => (
    historyIndex() >= 0 && historyIndex() < history.length - 1
  ))

  function recordHistory(path: string): void {
    const currentIndex = historyIndex()
    if (currentIndex >= 0 && history[currentIndex] === path) return
    history = [...history.slice(0, currentIndex + 1), path]
    setHistoryIndex(history.length - 1)
  }

  async function readFirst(paths: readonly string[]): Promise<FolderFile> {
    if (!paths.length) throw new Error(uiText('链接目标为空', 'Link target is empty'))
    let lastError: unknown
    for (const path of paths) {
      try {
        return await api().readFile(path)
      } catch (cause) {
        lastError = cause
      }
    }
    throw lastError
  }

  async function openPaths(paths: readonly string[], record = true): Promise<boolean> {
    const generation = ++fileGeneration
    ++previewGeneration
    setLinkPreview(undefined)
    setLoadingFile(true)
    setError(undefined)
    try {
      const file = await readFirst(paths)
      if (generation !== fileGeneration) return false
      const nextDocument = decodeFolderFile(file)
      setSelectedPath(file.path)
      setDocument(nextDocument)
      if (record) recordHistory(file.path)
      return true
    } catch (cause) {
      if (generation === fileGeneration) setError(errorMessage(cause))
      return false
    } finally {
      if (generation === fileGeneration) setLoadingFile(false)
    }
  }

  async function openFile(path: string, record = true): Promise<boolean> {
    return openPaths([path], record)
  }

  async function openTarget(target: string): Promise<boolean> {
    const currentPath = selectedPath()
    if (!currentPath) {
      setError(uiText('请先选择当前 Markdown 文件', 'Select the current Markdown file first'))
      return false
    }
    return openPaths(resolveFolderFileTargets(currentPath, target))
  }

  async function previewTarget(target: string | undefined): Promise<void> {
    const generation = ++previewGeneration
    if (!target) {
      setLinkPreview(undefined)
      return
    }
    const currentPath = selectedPath()
    const paths = currentPath ? resolveFolderFileTargets(currentPath, target) : []
    setLinkPreview({ kind: 'loading', target, path: paths[0] })
    if (!currentPath || !paths.length) {
      setLinkPreview({
        kind: 'error',
        target,
        path: paths[0],
        message: currentPath
          ? uiText('链接目标为空', 'Link target is empty')
          : uiText('没有可用于解析链接的当前文件', 'No current file is available to resolve the link')
      })
      return
    }
    try {
      const file = await readFirst(paths)
      if (generation !== previewGeneration) return
      setLinkPreview({ kind: 'ready', target, document: decodeFolderFile(file) })
    } catch (cause) {
      if (generation !== previewGeneration) return
      setLinkPreview({
        kind: 'error',
        target,
        path: paths[0],
        message: errorMessage(cause)
      })
    }
  }

  async function selectEntry(entry: FolderEntry): Promise<boolean> {
    if (entry.kind !== 'file') return false
    return openFile(entry.path)
  }

  async function load(folderPath: string): Promise<void> {
    const generation = ++folderGeneration
    ++fileGeneration
    ++previewGeneration
    setLoadingFolder(true)
    setLoadingFile(false)
    setError(undefined)
    setLinkPreview(undefined)
    setSnapshot(undefined)
    setSelectedPath(undefined)
    setDocument(undefined)
    history = []
    setHistoryIndex(-1)
    try {
      const nextSnapshot = await api().browseFolder(folderPath)
      if (generation !== folderGeneration) return
      setSnapshot(nextSnapshot)
      const initialFile = firstFile(nextSnapshot.entries)
      if (initialFile) await openFile(initialFile.path)
    } catch (cause) {
      if (generation === folderGeneration) setError(errorMessage(cause))
    } finally {
      if (generation === folderGeneration) setLoadingFolder(false)
    }
  }

  async function navigateHistory(nextIndex: number): Promise<boolean> {
    const path = history[nextIndex]
    if (!path || nextIndex < 0 || nextIndex >= history.length) return false
    if (!await openPaths([path], false)) return false
    setHistoryIndex(nextIndex)
    return true
  }

  return {
    snapshot,
    selectedPath,
    document,
    loadingFolder,
    loadingFile,
    error,
    linkPreview,
    canGoBack,
    canGoForward,
    load,
    selectEntry,
    openFile,
    openTarget,
    previewTarget,
    goBack: () => navigateHistory(historyIndex() - 1),
    goForward: () => navigateHistory(historyIndex() + 1)
  }
}
