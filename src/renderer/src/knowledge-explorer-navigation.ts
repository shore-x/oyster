export interface KnowledgeExplorerNavigationSnapshot {
  history: string[]
  historyIndex: number
  currentTitle?: string
  hoveredTitle?: string
}

/** Transient browser navigation state with no Knowledge persistence role. */
export class KnowledgeExplorerNavigation {
  private history: string[] = []
  private historyIndex = -1
  private hoveredTitle: string | undefined

  constructor(initialTitle?: string) {
    this.reset(initialTitle)
  }

  snapshot(): KnowledgeExplorerNavigationSnapshot {
    return {
      history: [...this.history],
      historyIndex: this.historyIndex,
      currentTitle: this.history[this.historyIndex],
      hoveredTitle: this.hoveredTitle
    }
  }

  reset(title?: string): KnowledgeExplorerNavigationSnapshot {
    this.history = title ? [title] : []
    this.historyIndex = title ? 0 : -1
    this.hoveredTitle = undefined
    return this.snapshot()
  }

  navigate(title: string): KnowledgeExplorerNavigationSnapshot {
    if (this.history[this.historyIndex] !== title) {
      this.history = [...this.history.slice(0, this.historyIndex + 1), title]
      this.historyIndex = this.history.length - 1
    }
    this.hoveredTitle = undefined
    return this.snapshot()
  }

  move(offset: -1 | 1): KnowledgeExplorerNavigationSnapshot {
    const nextIndex = this.historyIndex + offset
    if (nextIndex >= 0 && nextIndex < this.history.length) this.historyIndex = nextIndex
    this.hoveredTitle = undefined
    return this.snapshot()
  }

  hover(title?: string): KnowledgeExplorerNavigationSnapshot {
    this.hoveredTitle = title
    return this.snapshot()
  }
}
