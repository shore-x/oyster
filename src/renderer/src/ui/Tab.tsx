import { splitProps, type JSX } from 'solid-js'

export type TabListVariant = 'line' | 'segmented'
export type TabListSize = 'default' | 'compact'

export interface TabListProps extends JSX.HTMLAttributes<HTMLDivElement> {
  ariaLabel: string
  variant?: TabListVariant
  size?: TabListSize
}

export function TabList(props: TabListProps): JSX.Element {
  const [local, listProps] = splitProps(props, [
    'ariaLabel', 'variant', 'size', 'class', 'children'
  ])
  return (
    <div
      {...listProps}
      class={`ui-tabs ui-tabs--${local.variant ?? 'line'} ui-tabs--${local.size ?? 'default'}${local.class ? ` ${local.class}` : ''}`}
      role="tablist"
      aria-label={local.ariaLabel}
    >{local.children}</div>
  )
}

export interface TabProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  selected: boolean
}

export function Tab(props: TabProps): JSX.Element {
  const [local, buttonProps] = splitProps(props, ['selected', 'class', 'children', 'type'])
  return (
    <button
      {...buttonProps}
      type={local.type ?? 'button'}
      class={`ui-tab${local.class ? ` ${local.class}` : ''}`}
      role="tab"
      aria-selected={local.selected}
    >{local.children}</button>
  )
}
