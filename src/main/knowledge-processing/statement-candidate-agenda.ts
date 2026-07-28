export type StatementCandidateStatus = 'open' | 'resolved'

export const MAX_STATEMENT_CANDIDATE_EXPRESSION_CHARACTERS = 512
export const MAX_STATEMENT_CANDIDATE_QUESTION_CHARACTERS = 16 * 1_024

export interface StatementCandidateInput {
  /** Exact local name or expression surfaced by discovery, before canonical-title decisions. */
  expression: string
  /** A question to investigate, not a proposed canonical title or Knowledge Statement. */
  question: string
  /** Flexible, source-specific hints that let an Agent return to relevant evidence. */
  evidenceLocations?: readonly string[]
}

export interface StatementCandidate {
  /** Run-local tool identity assigned by the Host. It has no meaning in the knowledge layer. */
  ref: string
  expression: string
  question: string
  evidenceLocations: string[]
  status: StatementCandidateStatus
  /** Free-text disposition. It deliberately does not classify the resulting knowledge change. */
  resolution?: string
}

export interface StatementCandidateResolution {
  ref: string
  resolution: string
}

export interface StatementCandidateCounts {
  total: number
  open: number
  resolved: number
}

export interface StatementCandidateListOptions {
  status?: StatementCandidateStatus
  offset?: number
  limit?: number
}

export interface StatementCandidatePage {
  items: StatementCandidate[]
  counts: StatementCandidateCounts
  offset: number
  limit: number
  total: number
  nextOffset: number | null
}

export interface StatementCandidateAgendaSnapshot {
  counts: StatementCandidateCounts
  openPreview: StatementCandidate[]
  remainingOpen: number
}

const DEFAULT_LIST_LIMIT = 20
const DEFAULT_OPEN_PREVIEW_LIMIT = 5

function nonEmptyText(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} 不能为空`)
  return normalized
}

function candidateExpression(value: string): string {
  const normalized = nonEmptyText(value, '候选原始称呼')
  if (normalized.length > MAX_STATEMENT_CANDIDATE_EXPRESSION_CHARACTERS) {
    throw new Error(
      `候选原始称呼不能超过 ${MAX_STATEMENT_CANDIDATE_EXPRESSION_CHARACTERS} 个字符`
    )
  }
  return normalized
}

function candidateQuestion(value: string): string {
  const normalized = nonEmptyText(value, '候选问题')
  if (normalized.length > MAX_STATEMENT_CANDIDATE_QUESTION_CHARACTERS) {
    throw new Error(
      `候选问题不能超过 ${MAX_STATEMENT_CANDIDATE_QUESTION_CHARACTERS} 个字符`
    )
  }
  return normalized
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${name} 必须是非负整数`)
  }
  return resolved
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} 必须是正整数`)
  }
  return resolved
}

function normalizeInput(input: StatementCandidateInput): StatementCandidateInput {
  return {
    expression: candidateExpression(input.expression),
    question: candidateQuestion(input.question),
    evidenceLocations: (input.evidenceLocations ?? []).map((location) => (
      nonEmptyText(location, '证据位置')
    ))
  }
}

function cloneCandidate(candidate: StatementCandidate): StatementCandidate {
  return {
    ...candidate,
    evidenceLocations: [...candidate.evidenceLocations]
  }
}

/**
 * Host-owned, in-memory working agenda for one knowledge-maintenance run.
 *
 * The agenda tracks coverage, not knowledge. It remains open to candidates found by the
 * maintenance Agent and deliberately makes no candidate-to-Statement cardinality claim.
 */
export class InMemoryStatementCandidateAgenda {
  private readonly candidates: StatementCandidate[] = []
  private readonly candidatesByRef = new Map<string, StatementCandidate>()
  private nextRef = 1

  constructor(seed: readonly StatementCandidateInput[] = []) {
    this.add(seed)
  }

  add(inputs: readonly StatementCandidateInput[]): StatementCandidate[] {
    const normalized = inputs.map(normalizeInput)
    const added = normalized.map((input) => {
      const ref = `C${String(this.nextRef++).padStart(6, '0')}`
      const candidate: StatementCandidate = {
        ref,
        expression: input.expression,
        question: input.question,
        evidenceLocations: [...(input.evidenceLocations ?? [])],
        status: 'open'
      }
      this.candidates.push(candidate)
      this.candidatesByRef.set(ref, candidate)
      return candidate
    })
    return added.map(cloneCandidate)
  }

  resolve(resolutions: readonly StatementCandidateResolution[]): StatementCandidate[] {
    const seen = new Set<string>()
    const normalized = resolutions.map((resolution) => {
      const ref = nonEmptyText(resolution.ref, '候选 ref')
      if (seen.has(ref)) throw new Error(`同一批次不能重复处置候选：${ref}`)
      seen.add(ref)
      const candidate = this.candidatesByRef.get(ref)
      if (!candidate) throw new Error(`未找到 Statement 候选：${ref}`)
      return {
        candidate,
        resolution: nonEmptyText(resolution.resolution, '处置说明')
      }
    })

    for (const item of normalized) {
      item.candidate.status = 'resolved'
      item.candidate.resolution = item.resolution
    }
    return normalized.map(({ candidate }) => cloneCandidate(candidate))
  }

  list(options: StatementCandidateListOptions = {}): StatementCandidatePage {
    const offset = nonNegativeInteger(options.offset, 0, 'offset')
    const limit = positiveInteger(options.limit, DEFAULT_LIST_LIMIT, 'limit')
    const matches = (candidate: StatementCandidate): boolean => (
      options.status === undefined || candidate.status === options.status
    )
    const total = this.candidates.reduce(
      (count, candidate) => count + (matches(candidate) ? 1 : 0),
      0
    )
    const items: StatementCandidate[] = []
    let nextCandidateIndex = Math.min(offset, this.candidates.length)
    while (nextCandidateIndex < this.candidates.length && items.length < limit) {
      const candidate = this.candidates[nextCandidateIndex++]
      if (matches(candidate)) items.push(candidate)
    }
    const nextOffset = this.candidates
      .slice(nextCandidateIndex)
      .some(matches)
      ? nextCandidateIndex
      : null
    return {
      items: items.map(cloneCandidate),
      counts: this.counts(),
      offset,
      limit,
      total,
      nextOffset
    }
  }

  snapshot(openPreviewLimit = DEFAULT_OPEN_PREVIEW_LIMIT): StatementCandidateAgendaSnapshot {
    const limit = nonNegativeInteger(openPreviewLimit, DEFAULT_OPEN_PREVIEW_LIMIT, 'openPreviewLimit')
    const open = this.candidates.filter((candidate) => candidate.status === 'open')
    return {
      counts: this.counts(),
      openPreview: open.slice(0, limit).map(cloneCandidate),
      remainingOpen: Math.max(0, open.length - limit)
    }
  }

  all(): StatementCandidate[] {
    return this.candidates.map(cloneCandidate)
  }

  private counts(): StatementCandidateCounts {
    const resolved = this.candidates.reduce(
      (count, candidate) => count + (candidate.status === 'resolved' ? 1 : 0),
      0
    )
    return {
      total: this.candidates.length,
      open: this.candidates.length - resolved,
      resolved
    }
  }
}
