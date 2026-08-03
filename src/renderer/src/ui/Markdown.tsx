import DOMPurify from 'dompurify'
import { Marked, type RendererThis, type Tokens } from 'marked'
import { createMemo, type JSX } from 'solid-js'

interface KnowledgeLinkToken extends Tokens.Generic {
  type: 'knowledgeLink'
  target: string
  label: string
}

export interface MarkdownProps {
  text: string
  class?: string
  testId?: string
  /** External documents can disable images to avoid local or remote resource loads. */
  allowImages?: boolean
  onOpenKnowledge?(title: string): void
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function safeLink(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href) || href.startsWith('#')
}

function createMarkdownParser(interactiveKnowledgeLinks: boolean, allowImages: boolean): Marked {
  const parser = new Marked({
    async: false,
    breaks: true,
    gfm: true,
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(text)
      },
      link(this: RendererThis, { href, title, tokens }: Tokens.Link): string {
        const label = this.parser.parseInline(tokens)
        if (!safeLink(href)) return `<span class="markdown-link--disabled">${label}</span>`
        const titleAttribute = title ? ` title="${escapeHtml(title)}"` : ''
        const externalAttributes = href.startsWith('#')
          ? ''
          : ' target="_blank" rel="noreferrer noopener"'
        return `<a href="${escapeHtml(href)}"${titleAttribute}${externalAttributes}>${label}</a>`
      },
      ...(allowImages ? {} : {
        image({ text }: Tokens.Image): string {
          const label = text.trim() || '未命名图片'
          return `<span class="markdown-image--disabled">[图片：${escapeHtml(label)}]</span>`
        }
      })
    }
  })

  parser.use({
    extensions: [{
      name: 'knowledgeLink',
      level: 'inline',
      start(source) {
        const index = source.indexOf('[[')
        return index < 0 ? undefined : index
      },
      tokenizer(source): KnowledgeLinkToken | undefined {
        const match = /^\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/.exec(source)
        if (!match) return undefined
        const target = match[1].trim()
        if (!target) return undefined
        return {
          type: 'knowledgeLink',
          raw: match[0],
          target,
          label: match[2]?.trim() || target
        }
      },
      renderer(token): string {
        const link = token as KnowledgeLinkToken
        if (!interactiveKnowledgeLinks) {
          return `<span class="markdown-knowledge-link markdown-knowledge-link--static">${escapeHtml(link.label)}</span>`
        }
        return [
          '<button type="button" class="markdown-knowledge-link"',
          ` data-knowledge-title="${escapeHtml(link.target)}"`,
          ` title="在知识库中打开 ${escapeHtml(link.target)}">`,
          escapeHtml(link.label),
          '</button>'
        ].join('')
      }
    }]
  })

  return parser
}

const markdownParser = createMarkdownParser(false, true)
const interactiveMarkdownParser = createMarkdownParser(true, true)
const markdownParserWithoutImages = createMarkdownParser(false, false)
const interactiveMarkdownParserWithoutImages = createMarkdownParser(true, false)

export function markdownToSafeHtml(
  text: string,
  interactiveKnowledgeLinks = false,
  allowImages = true
): string {
  const parser = interactiveKnowledgeLinks
    ? allowImages ? interactiveMarkdownParser : interactiveMarkdownParserWithoutImages
    : allowImages ? markdownParser : markdownParserWithoutImages
  const rendered = parser.parse(text) as string
  if (typeof window === 'undefined' || typeof DOMPurify.sanitize !== 'function') return rendered
  return DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['form', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style']
  })
}

export function Markdown(props: MarkdownProps) {
  const html = createMemo(() => markdownToSafeHtml(
    props.text,
    Boolean(props.onOpenKnowledge),
    props.allowImages !== false
  ))

  const onClick: JSX.EventHandlerUnion<HTMLDivElement, MouseEvent> = (event) => {
    if (!props.onOpenKnowledge || !(event.target instanceof Element)) return
    const link = event.target.closest<HTMLElement>('[data-knowledge-title]')
    if (!link || !event.currentTarget.contains(link)) return
    const title = link.dataset.knowledgeTitle
    if (title) props.onOpenKnowledge(title)
  }

  return (
    <div
      class={`markdown-body${props.class ? ` ${props.class}` : ''}`}
      data-testid={props.testId}
      innerHTML={html()}
      onClick={onClick}
    />
  )
}
