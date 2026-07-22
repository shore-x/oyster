import type { DiscoveryApi } from '../../shared/discovery'

declare global {
  interface Window {
    oyster: {
      discovery: DiscoveryApi
    }
  }
}

export {}
