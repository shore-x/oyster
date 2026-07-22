import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export async function nearestExistingDirectory(candidatePath: string, fallbackPath: string): Promise<string> {
  let currentPath = resolve(candidatePath)

  while (dirname(currentPath) !== currentPath) {
    try {
      if ((await stat(currentPath)).isDirectory()) return currentPath
    } catch {
      // Walk upward until the native directory picker has a valid default path.
    }

    currentPath = dirname(currentPath)
  }

  return resolve(fallbackPath)
}
