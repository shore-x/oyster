import { execFile } from 'node:child_process'
import { delimiter, dirname, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import {
  resolveEmbeddedGitDir,
  resolveGitBinary,
  setupEnvironment
} from 'dugite'

const execFileAsync = promisify(execFile)
const EMBEDDED_GIT_DIRECTORY = resolveEmbeddedGitDir()

const PRIVATE_GIT_ENVIRONMENT_VARIABLES = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_INDEX_FILE',
  'LOCAL_GIT_DIRECTORY',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'GIT_CONFIG_SYSTEM'
])

/** Absolute path to the Git binary bundled with the application through Dugite. */
export const ARTIFACT_GIT_BINARY_PATH = resolveGitBinary(EMBEDDED_GIT_DIRECTORY)

/**
 * Builds the private Git environment used by Oyster and, later, by an Artifact Agent shell.
 * Layout variables inherited from the caller cannot redirect Git outside this runtime.
 */
export function createArtifactGitEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const sanitizedEnvironment = { ...baseEnvironment }
  for (const key of Object.keys(sanitizedEnvironment)) {
    if (PRIVATE_GIT_ENVIRONMENT_VARIABLES.has(key.toUpperCase())) {
      delete sanitizedEnvironment[key]
    }
  }

  const { env, gitLocation } = setupEnvironment(
    { LOCAL_GIT_DIRECTORY: EMBEDDED_GIT_DIRECTORY },
    sanitizedEnvironment
  )
  if (!isAbsolute(gitLocation) || gitLocation !== ARTIFACT_GIT_BINARY_PATH) {
    throw new Error('Artifact Git Runtime 没有解析到 APP 内置 Git binary')
  }

  const binaryDirectory = dirname(ARTIFACT_GIT_BINARY_PATH)
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = env[pathKey]
    ? `${binaryDirectory}${delimiter}${env[pathKey]}`
    : binaryDirectory
  return env
}

/** Executes the bundled Git binary directly; command lookup never uses PATH. */
export async function runArtifactGit(args: string[], workingDirectory: string): Promise<void> {
  await execFileAsync(ARTIFACT_GIT_BINARY_PATH, args, {
    cwd: workingDirectory,
    env: createArtifactGitEnvironment()
  })
}
