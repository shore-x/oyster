import type { JSX } from 'solid-js'

type IconName = 'archive' | 'refresh' | 'folder' | 'download' | 'stop' | 'check' | 'warning'

const paths: Record<IconName, JSX.Element> = {
  archive: <><path d="M3.5 5.5h13"/><path d="M5 5.5v10h10v-10"/><path d="M7.5 9h5"/><path d="M4 2.5h12v3H4z"/></>,
  refresh: <><path d="M15.5 7a6 6 0 1 0 .2 4"/><path d="M15.5 3.5V7H12"/></>,
  folder: <><path d="M2.5 5.5h5l1.5 2h8.5v8H2.5z"/><path d="M2.5 5.5v-2h5l1.5 2"/></>,
  download: <><path d="M9.5 2.5v10"/><path d="m5.5 8.5 4 4 4-4"/><path d="M3 16.5h13"/></>,
  stop: <rect x="4.5" y="4.5" width="10" height="10" rx="1"/>,
  check: <path d="m3.5 10 4 4 9-10"/>,
  warning: <><path d="M9.5 2.5 17 16H2z"/><path d="M9.5 7v4"/><path d="M9.5 13.5h.01"/></>
}

export function Icon(props: { name: IconName }): JSX.Element {
  return <svg class="icon" viewBox="0 0 19 19" aria-hidden="true">{paths[props.name]}</svg>
}
