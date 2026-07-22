import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function inspectElectronInstallation(packageRoot) {
  let executableEntry
  try {
    executableEntry = (await readFile(join(packageRoot, 'path.txt'), 'utf8')).trim()
  } catch {
    return { ok: false, reason: 'missing path.txt' }
  }

  if (!executableEntry) return { ok: false, reason: 'empty path.txt' }
  const distributionRoot = resolve(packageRoot, 'dist')
  const executablePath = resolve(distributionRoot, executableEntry)
  if (executablePath !== distributionRoot && !executablePath.startsWith(`${distributionRoot}${sep}`)) {
    return { ok: false, reason: 'invalid executable path' }
  }
  if (!(await exists(executablePath))) return { ok: false, reason: 'missing Electron executable' }

  return { ok: true, executablePath }
}

function runInstaller(installScript) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [installScript], {
      env: process.env,
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`Electron installer exited with ${signal || `code ${code}`}`))
    })
  })
}

export async function ensureElectron() {
  let packageRoot
  try {
    packageRoot = dirname(require.resolve('electron/package.json'))
  } catch {
    throw new Error('Electron npm package is missing. Run `npm ci` before starting development.')
  }

  const initialStatus = await inspectElectronInstallation(packageRoot)
  if (initialStatus.ok) {
    console.log(`Electron binary ready: ${initialStatus.executablePath}`)
    return
  }

  console.log(`Electron binary is incomplete (${initialStatus.reason}); downloading it now…`)
  try {
    await runInstaller(join(packageRoot, 'install.js'))
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `Unable to install the Electron binary: ${detail}\n` +
      'Check access to GitHub Releases or configure ELECTRON_GET_USE_PROXY / ELECTRON_MIRROR, then run `npm run electron:ensure`.'
    )
  }

  const repairedStatus = await inspectElectronInstallation(packageRoot)
  if (!repairedStatus.ok) {
    throw new Error(`Electron installer finished but the installation is still incomplete: ${repairedStatus.reason}`)
  }
  console.log(`Electron binary installed: ${repairedStatus.executablePath}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureElectron().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
