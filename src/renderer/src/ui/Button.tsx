import { splitProps, type JSX } from 'solid-js'
import { Icon, type IconName } from './Icon'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'default' | 'wide'

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon: IconName
}

export function Button(props: ButtonProps): JSX.Element {
  const [local, buttonProps] = splitProps(props, ['variant', 'size', 'icon', 'class', 'children', 'type'])
  const variant = () => local.variant || 'secondary'
  const size = () => local.size || 'default'

  return (
    <button
      {...buttonProps}
      type={local.type || 'button'}
      class={`ui-button ui-button--${variant()} ui-button--${size()}${local.class ? ` ${local.class}` : ''}`}
    >
      <span class="ui-button__icon"><Icon name={local.icon} /></span>
      <span class="ui-button__label">{local.children}</span>
      <span class="ui-button__balance" aria-hidden="true" />
    </button>
  )
}
