import type { JSX } from 'solid-js'

export type IconName = 'archive' | 'layers' | 'skill' | 'agent' | 'chat' | 'spark' | 'refresh' | 'folder' | 'download' | 'stop' | 'check' | 'warning' | 'link' | 'play' | 'plus' | 'trash' | 'search' | 'back' | 'forward' | 'close'

const paths: Record<IconName, () => JSX.Element> = {
  archive: () => <><path d="M3.5 5.5h13"/><path d="M5 5.5v10h10v-10"/><path d="M7.5 9h5"/><path d="M4 2.5h12v3H4z"/></>,
  layers: () => <><path d="m9.5 2.5 7 3.5-7 3.5L2.5 6z"/><path d="m3.5 9 6 3 6-3"/><path d="m3.5 12 6 3 6-3"/></>,
  skill: () => <><path d="M4 2.5h8l3 3v11H4z"/><path d="M12 2.5v3h3"/><path d="M6.5 9h6M6.5 12h5"/></>,
  agent: () => <><rect x="3.5" y="5.5" width="12" height="9" rx="2"/><path d="M9.5 2.5v3"/><path d="M7 9h.01M12 9h.01"/><path d="M7 12h5"/></>,
  chat: () => <><path d="M3 4.5h13v9H8l-4 3v-3H3z"/><path d="M6.5 8h6M6.5 10.5h4"/></>,
  spark: () => <><path d="m9.5 2 1.2 4.3L15 7.5l-4.3 1.2L9.5 13 8.3 8.7 4 7.5l4.3-1.2z"/><path d="m15.5 12 .5 1.8 1.8.5-1.8.5-.5 1.7-.5-1.7-1.8-.5 1.8-.5z"/></>,
  refresh: () => <><path d="M15.5 7a6 6 0 1 0 .2 4"/><path d="M15.5 3.5V7H12"/></>,
  folder: () => <><path d="M2.5 5.5h5l1.5 2h8.5v8H2.5z"/><path d="M2.5 5.5v-2h5l1.5 2"/></>,
  download: () => <><path d="M9.5 2.5v10"/><path d="m5.5 8.5 4 4 4-4"/><path d="M3 16.5h13"/></>,
  stop: () => <rect x="4.5" y="4.5" width="10" height="10" rx="1"/>,
  check: () => <path d="m3.5 10 4 4 9-10"/>,
  warning: () => <><path d="M9.5 2.5 17 16H2z"/><path d="M9.5 7v4"/><path d="M9.5 13.5h.01"/></>,
  link: () => <><path d="m7.5 12 4-4"/><path d="M6.5 14.5H5a3 3 0 0 1 0-6h2"/><path d="M12.5 5.5H14a3 3 0 0 1 0 6h-2"/></>,
  play: () => <path d="m6 3.5 9 6-9 6z"/>,
  plus: () => <><path d="M9.5 3v13"/><path d="M3 9.5h13"/></>,
  trash: () => <><path d="M4.5 5.5h10"/><path d="m6 5.5.5 10h6l.5-10"/><path d="M7.5 5.5v-2h4v2"/></>,
  search: () => <><circle cx="8.5" cy="8.5" r="4.5"/><path d="m12 12 4 4"/></>,
  back: () => <><path d="m8 4-5 5 5 5"/><path d="M3 9h13"/></>,
  forward: () => <><path d="m11 4 5 5-5 5"/><path d="M16 9H3"/></>,
  close: () => <><path d="m4.5 4.5 10 10"/><path d="m14.5 4.5-10 10"/></>
}

export function Icon(props: { name: IconName }): JSX.Element {
  return <svg class="ui-icon" viewBox="0 0 19 19" aria-hidden="true">{paths[props.name]()}</svg>
}
