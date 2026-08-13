import type { EvidenceLocation } from './model'

export function observationLineAddress(line: number): string {
  return `L${String(line).padStart(6, '0')}`
}

export function formatEvidenceLocation(location: EvidenceLocation): string {
  return `${observationLineAddress(location.line)}:C${location.offset}`
}
