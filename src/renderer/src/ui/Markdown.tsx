import DOMPurify from 'dompurify'
import { Marked, type RendererThis, type Tokens } from 'marked'
import { createMemo, type JSX } from 'solid-js'
import { appLanguage, uiText } from '../i18n'

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
  /** Reports the Knowledge link currently hovered or focused and its rendered anchor. */
  onPreviewKnowledge?(title: string | undefined, anchor?: HTMLElement): void
  /** Opens an unresolved path from the current Markdown document. */
  onOpenFile?(target: string): void
  /** Reports the unresolved path currently hovered or focused, or clears it. */
  onPreviewFile?(target: string | undefined): void
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function isExternalLink(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href)
}

function isRelativeFileLink(href: string): boolean {
  return href.length > 0
    && !href.startsWith('/')
    && !href.startsWith('\\')
    && !href.startsWith('#')
    && !/^[a-z][a-z\d+.-]*:/i.test(href)
}

function fileLink(target: string, label: string, title?: string | null): string {
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : ''
  return [
    '<button type="button" class="markdown-knowledge-link markdown-file-link"',
    ` data-file-target="${escapeHtml(target)}"${titleAttribute}>`,
    label,
    '</button>'
  ].join('')
}

function createMarkdownParser(
  interactiveKnowledgeLinks: boolean,
  allowImages: boolean,
  interactiveFileLinks: boolean
): Marked {
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
        if (interactiveFileLinks && isRelativeFileLink(href)) {
          return fileLink(href, label, title)
        }
        if (!isExternalLink(href) && !href.startsWith('#')) {
          return `<span class="markdown-link--disabled">${label}</span>`
        }
        const titleAttribute = title ? ` title="${escapeHtml(title)}"` : ''
        const externalAttributes = href.startsWith('#')
          ? ''
          : ' target="_blank" rel="noreferrer noopener"'
        return `<a href="${escapeHtml(href)}"${titleAttribute}${externalAttributes}>${label}</a>`
      },
      ...(allowImages ? {} : {
        image({ text }: Tokens.Image): string {
          const label = text.trim() || uiText('未命名图片', 'Untitled image')
          return `<span class="markdown-image--disabled">[${uiText('图片：', 'Image: ')}${escapeHtml(label)}]</span>`
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
        if (!interactiveKnowledgeLinks && interactiveFileLinks) {
          const label = escapeHtml(link.label)
          if (isRelativeFileLink(link.target)) return fileLink(link.target, label)
          if (isExternalLink(link.target) || link.target.startsWith('#')) {
            const externalAttributes = link.target.startsWith('#')
              ? ''
              : ' target="_blank" rel="noreferrer noopener"'
            return `<a href="${escapeHtml(link.target)}"${externalAttributes}>${label}</a>`
          }
          return `<span class="markdown-link--disabled">${label}</span>`
        }
        if (!interactiveKnowledgeLinks) {
          return `<span class="markdown-knowledge-link markdown-knowledge-link--static">${escapeHtml(link.label)}</span>`
        }
        return [
          '<button type="button" class="markdown-knowledge-link"',
          ` data-knowledge-title="${escapeHtml(link.target)}"`,
          ` title="${uiText('在知识库中打开', 'Open in Knowledge')} ${escapeHtml(link.target)}">`,
          escapeHtml(link.label),
          '</button>'
        ].join('')
      }
    }]
  })

  return parser
}

const markdownParsers = new Map<string, Marked>()

function markdownParser(
  interactiveKnowledgeLinks: boolean,
  allowImages: boolean,
  interactiveFileLinks: boolean
): Marked {
  const key = `${appLanguage()}:${Number(interactiveKnowledgeLinks)}:${Number(allowImages)}:${Number(interactiveFileLinks)}`
  const existing = markdownParsers.get(key)
  if (existing) return existing
  const parser = createMarkdownParser(interactiveKnowledgeLinks, allowImages, interactiveFileLinks)
  markdownParsers.set(key, parser)
  return parser
}

export function markdownToSafeHtml(
  text: string,
  interactiveKnowledgeLinks = false,
  allowImages = true,
  interactiveFileLinks = false
): string {
  const parser = markdownParser(interactiveKnowledgeLinks, allowImages, interactiveFileLinks)
  const rendered = parser.parse(text) as string
  if (typeof window === 'undefined' || typeof DOMPurify.sanitize !== 'function') return rendered
  return DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['form', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style']
  })
}

function fileLinkWithin(container: HTMLElement, target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined
  const link = target.closest<HTMLElement>('[data-file-target]')
  return link && container.contains(link) ? link : undefined
}

function knowledgeLinkWithin(container: HTMLElement, target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined
  const link = target.closest<HTMLElement>('[data-knowledge-title]')
  return link && container.contains(link) ? link : undefined
}

export function Markdown(props: MarkdownProps) {
  const html = createMemo(() => markdownToSafeHtml(
    props.text,
    Boolean(props.onOpenKnowledge),
    props.allowImages !== false,
    Boolean(props.onOpenFile)
  ))

  const onClick: JSX.EventHandlerUnion<HTMLDivElement, MouseEvent> = (event) => {
    if (!(event.target instanceof Element)) return
    const fileLink = event.target.closest<HTMLElement>('[data-file-target]')
    if (props.onOpenFile && fileLink && event.currentTarget.contains(fileLink)) {
      const target = fileLink.dataset.fileTarget
      if (target) props.onOpenFile(target)
      return
    }
    const knowledgeLink = event.target.closest<HTMLElement>('[data-knowledge-title]')
    if (!props.onOpenKnowledge || !knowledgeLink || !event.currentTarget.contains(knowledgeLink)) return
    const title = knowledgeLink.dataset.knowledgeTitle
    if (title) props.onOpenKnowledge(title)
  }

  const startFilePreview = (
    container: HTMLDivElement,
    target: EventTarget | null,
    relatedTarget: EventTarget | null
  ): void => {
    if (!props.onPreviewFile) return
    const link = fileLinkWithin(container, target)
    if (!link || link === fileLinkWithin(container, relatedTarget)) return
    props.onPreviewFile(link.dataset.fileTarget)
  }

  const endFilePreview = (
    container: HTMLDivElement,
    target: EventTarget | null,
    relatedTarget: EventTarget | null
  ): void => {
    if (!props.onPreviewFile || !fileLinkWithin(container, target)) return
    if (!fileLinkWithin(container, relatedTarget)) props.onPreviewFile(undefined)
  }

  const startKnowledgePreview = (
    container: HTMLDivElement,
    target: EventTarget | null,
    relatedTarget: EventTarget | null
  ): void => {
    if (!props.onPreviewKnowledge) return
    const link = knowledgeLinkWithin(container, target)
    if (!link || link === knowledgeLinkWithin(container, relatedTarget)) return
    const title = link.dataset.knowledgeTitle
    if (title) props.onPreviewKnowledge(title, link)
  }

  const endKnowledgePreview = (
    container: HTMLDivElement,
    target: EventTarget | null,
    relatedTarget: EventTarget | null
  ): void => {
    if (!props.onPreviewKnowledge || !knowledgeLinkWithin(container, target)) return
    if (!knowledgeLinkWithin(container, relatedTarget)) props.onPreviewKnowledge(undefined)
  }

  return (
    <div
      class={`markdown-body${props.class ? ` ${props.class}` : ''}`}
      data-testid={props.testId}
      innerHTML={html()}
      onClick={onClick}
      onMouseOver={(event) => {
        startFilePreview(event.currentTarget, event.target, event.relatedTarget)
        startKnowledgePreview(event.currentTarget, event.target, event.relatedTarget)
      }}
      onMouseOut={(event) => {
        endFilePreview(event.currentTarget, event.target, event.relatedTarget)
        endKnowledgePreview(event.currentTarget, event.target, event.relatedTarget)
      }}
      onFocusIn={(event) => {
        startFilePreview(event.currentTarget, event.target, event.relatedTarget)
        startKnowledgePreview(event.currentTarget, event.target, event.relatedTarget)
      }}
      onFocusOut={(event) => {
        endFilePreview(event.currentTarget, event.target, event.relatedTarget)
        endKnowledgePreview(event.currentTarget, event.target, event.relatedTarget)
      }}
    />
  )
}
