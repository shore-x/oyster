export interface KnowledgeExplorerSessionSnapshot {
  history: string[]
  historyIndex: number
  currentTitle?: string
  hoveredTitle?: string
}

/** Transient browsing state. It deliberately has no Knowledge persistence role. */
export class KnowledgeExplorerSession {
  private history: string[] = []
  private historyIndex = -1
  private hoveredTitle: string | undefined

  constructor(initialTitle?: string) {
    this.reset(initialTitle)
  }

  snapshot(): KnowledgeExplorerSessionSnapshot {
    return {
      history: [...this.history],
      historyIndex: this.historyIndex,
      currentTitle: this.history[this.historyIndex],
      hoveredTitle: this.hoveredTitle
    }
  }

  reset(title?: string): KnowledgeExplorerSessionSnapshot {
    this.history = title ? [title] : []
    this.historyIndex = title ? 0 : -1
    this.hoveredTitle = undefined
    return this.snapshot()
  }

  navigate(title: string): KnowledgeExplorerSessionSnapshot {
    if (this.history[this.historyIndex] !== title) {
      this.history = [...this.history.slice(0, this.historyIndex + 1), title]
      this.historyIndex = this.history.length - 1
    }
    this.hoveredTitle = undefined
    return this.snapshot()
  }

  move(offset: -1 | 1): KnowledgeExplorerSessionSnapshot {
    const nextIndex = this.historyIndex + offset
    if (nextIndex >= 0 && nextIndex < this.history.length) this.historyIndex = nextIndex
    this.hoveredTitle = undefined
    return this.snapshot()
  }

  hover(title?: string): KnowledgeExplorerSessionSnapshot {
    this.hoveredTitle = title
    return this.snapshot()
  }
}
