import { createSignal } from 'solid-js'
import type {
  KnowledgeBrowseResult,
  KnowledgeStatement
} from '../../shared/knowledge'

const EMPTY_RESULT: KnowledgeBrowseResult = { statements: [], total: 0 }

export function createKnowledgeController() {
  const [result, setResult] = createSignal<KnowledgeBrowseResult>(EMPTY_RESULT)
  const [selectedTitle, setSelectedTitle] = createSignal<string>()
  const [statement, setStatement] = createSignal<KnowledgeStatement>()
  const [loading, setLoading] = createSignal(false)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [clearing, setClearing] = createSignal(false)
  const [clearResult, setClearResult] = createSignal<{ deletedStatementCount: number }>()
  const [error, setError] = createSignal<string>()
  let browseGeneration = 0
  let readGeneration = 0

  const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

  async function select(title: string | undefined): Promise<void> {
    const generation = ++readGeneration
    setSelectedTitle(title)
    if (!title) {
      setStatement(undefined)
      return
    }
    try {
      const selected = await window.oyster.knowledge.read(title)
      if (generation === readGeneration && selectedTitle() === title) setStatement(selected)
    } catch (cause) {
      if (generation === readGeneration) setError(errorMessage(cause))
    }
  }

  async function browse(query = '', append = false): Promise<void> {
    const generation = ++browseGeneration
    try {
      if (append) setLoadingMore(true)
      else setLoading(true)
      setError(undefined)
      const current = result()
      const next = await window.oyster.knowledge.browse({
        query: query.trim() || undefined,
        limit: 100,
        offset: append ? current.nextOffset : 0
      })
      if (generation !== browseGeneration) return
      const combined = append
        ? { ...next, statements: [...current.statements, ...next.statements] }
        : next
      setResult(combined)
      const currentTitle = selectedTitle()
      const nextTitle = currentTitle && combined.statements.some((item) => item.title === currentTitle)
        ? currentTitle
        : combined.statements[0]?.title
      if (!append || nextTitle !== currentTitle) await select(nextTitle)
    } catch (cause) {
      if (generation === browseGeneration) setError(errorMessage(cause))
    } finally {
      if (generation === browseGeneration) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }

  async function clear(): Promise<boolean> {
    try {
      setClearing(true)
      setError(undefined)
      const cleared = await window.oyster.knowledge.clear()
      setClearResult({ deletedStatementCount: cleared.deletedStatementCount })
      setResult(EMPTY_RESULT)
      await select(undefined)
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setClearing(false)
    }
  }

  return {
    result,
    selectedTitle,
    statement,
    loading,
    loadingMore,
    clearing,
    clearResult,
    error,
    browse,
    select,
    clear
  }
}
