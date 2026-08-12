import { createEffect, onCleanup, splitProps, type JSX } from 'solid-js'
import { Icon } from './Icon'

export type InspectorSize = 'narrow' | 'medium' | 'wide'

export interface InspectorProps extends JSX.HTMLAttributes<HTMLElement> {
  ariaLabel: string
  title: string
  eyebrow?: string
  size?: InspectorSize
  closeLabel: string
  closeTestId?: string
  backLabel?: string
  backTestId?: string
  onBack?(): void
  onClose(): void
  contentClass?: string
}

/** Shared non-modal context layer. Business components own its content and navigation state. */
export function Inspector(props: InspectorProps): JSX.Element {
  const [local, asideProps] = splitProps(props, [
    'ariaLabel',
    'title',
    'eyebrow',
    'size',
    'closeLabel',
    'closeTestId',
    'backLabel',
    'backTestId',
    'onBack',
    'onClose',
    'contentClass',
    'class',
    'children'
  ])

  createEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') local.onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    onCleanup(() => document.removeEventListener('keydown', closeOnEscape))
  })

  return (
    <aside
      {...asideProps}
      class={`ui-inspector ui-inspector--${local.size ?? 'medium'}${local.class ? ` ${local.class}` : ''}`}
      role="complementary"
      aria-label={local.ariaLabel}
    >
      <header class="ui-inspector__toolbar">
        <div class="ui-inspector__navigation">
          {local.onBack ? (
            <button
              type="button"
              class="ui-inspector__back"
              data-testid={local.backTestId}
              aria-label={local.backLabel}
              onClick={local.onBack}
            ><Icon name="back" /><span>{local.backLabel}</span></button>
          ) : undefined}
          <div class="ui-inspector__identity">
            {local.eyebrow ? <span>{local.eyebrow}</span> : undefined}
            <strong>{local.title}</strong>
          </div>
        </div>
        <button
          type="button"
          class="ui-inspector__close"
          data-testid={local.closeTestId}
          aria-label={local.closeLabel}
          onClick={local.onClose}
        ><Icon name="close" /><span>{local.closeLabel}</span></button>
      </header>
      <div class={`ui-inspector__content${local.contentClass ? ` ${local.contentClass}` : ''}`}>
        {local.children}
      </div>
    </aside>
  )
}
