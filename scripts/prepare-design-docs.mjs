import { cp, copyFile, mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DESIGN_DOCS_RESOURCE_DIRECTORY = 'oyster-design-docs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function prepareDesignDocs({
  sourceRoot = projectRoot,
  outputDirectory = join(sourceRoot, 'out', DESIGN_DOCS_RESOURCE_DIRECTORY)
} = {}) {
  const resolvedSourceRoot = resolve(sourceRoot)
  const resolvedOutputDirectory = resolve(outputDirectory)
  if (basename(resolvedOutputDirectory) !== DESIGN_DOCS_RESOURCE_DIRECTORY) {
    throw new Error(`Design docs output must end with ${DESIGN_DOCS_RESOURCE_DIRECTORY}`)
  }

  await rm(resolvedOutputDirectory, { recursive: true, force: true })
  await mkdir(resolvedOutputDirectory, { recursive: true })
  await Promise.all([
    copyFile(
      join(resolvedSourceRoot, 'AGENTS.md'),
      join(resolvedOutputDirectory, 'AGENTS.md')
    ),
    copyFile(
      join(resolvedSourceRoot, 'README.md'),
      join(resolvedOutputDirectory, 'README.md')
    ),
    cp(
      join(resolvedSourceRoot, 'docs'),
      join(resolvedOutputDirectory, 'docs'),
      { recursive: true }
    )
  ])

  return resolvedOutputDirectory
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareDesignDocs()
}
