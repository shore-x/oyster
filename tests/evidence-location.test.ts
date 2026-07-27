import { describe, expect, it } from 'vitest'
import {
  formatEvidenceReadPage,
  MAX_EVIDENCE_READ_LINES,
  readEvidencePage
} from '../src/main/observation/evidence-location'

describe('Evidence Location reader', () => {
  it('preserves blank physical lines across continuation pages', () => {
    const lines = ['ab', '', 'c']
    const first = readEvidencePage(lines, { line: 1, offset: 0 }, 2)
    const second = readEvidencePage(lines, first.next!, 2)

    expect(first).toMatchObject({
      start: { line: 1, offset: 0 },
      end: { line: 2, offset: 0 },
      next: { line: 2, offset: 0 },
      eof: false,
      returnedLines: 1
    })
    expect(second).toMatchObject({
      start: { line: 2, offset: 0 },
      end: { line: 3, offset: 1 },
      eof: true,
      returnedLines: 2
    })
    expect(second.chunks.map(({ line, content }) => ({ line, content }))).toEqual([
      { line: 2, content: '' },
      { line: 3, content: 'c' }
    ])
    expect(formatEvidenceReadPage(second)).toContain('BEGIN_RAW_EVIDENCE\n\nc\nEND_RAW_EVIDENCE')
  })

  it('bounds progress through arbitrarily many blank lines', () => {
    const lines = [...Array.from({ length: MAX_EVIDENCE_READ_LINES + 6 }, () => ''), 'tail']
    const page = readEvidencePage(lines, { line: 1, offset: 0 }, 2)

    expect(page.returnedLines).toBe(MAX_EVIDENCE_READ_LINES)
    expect(page.returnedCharacters).toBe(0)
    expect(page.next).toEqual({ line: MAX_EVIDENCE_READ_LINES + 1, offset: 0 })
    expect(page.eof).toBe(false)
  })

  it('keeps raw JSONL content free of injected line prefixes', () => {
    const page = readEvidencePage(['{"type":"user"}', '{"type":"assistant"}'], { line: 1, offset: 0 }, 100)
    const text = formatEvidenceReadPage(page)

    expect(text).toContain(
      'BEGIN_RAW_EVIDENCE\n{"type":"user"}\n{"type":"assistant"}\nEND_RAW_EVIDENCE'
    )
    expect(text).not.toContain('L000001 {"type":"user"}')
  })
})
