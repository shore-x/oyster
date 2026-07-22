import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..')
const capturePath = join(root, 'artifacts', 'ui', 'agent-sources.png')
const userDataPath = join(root, 'artifacts', 'ui', 'electron-user-data')
await mkdir(dirname(capturePath), { recursive: true })
await rm(userDataPath, { recursive: true, force: true })

const child = spawn(electron, ['.', `--user-data-dir=${userDataPath}`], {
  cwd: root,
  env: {
    ...process.env,
    OYSTER_FIXTURE_MODE: '1',
    OYSTER_UI_CAPTURE_PATH: capturePath
  },
  stdio: 'inherit'
})

const exitCode = await new Promise((resolveExit) => child.once('exit', resolveExit))
if (exitCode !== 0) throw new Error(`Electron UI smoke test exited with code ${exitCode}`)

const semantics = JSON.parse(await readFile(`${capturePath}.json`, 'utf8'))
if (semantics.title !== 'Agent 数据来源') throw new Error('Expected page title was not rendered')
if (semantics.sourceCards !== 3) throw new Error(`Expected 3 source cards, got ${semantics.sourceCards}`)
if (semantics.dragRegion !== 'drag') throw new Error('Right-side window drag region is missing')
if (!semantics.primaryButtonColor.includes('82, 121, 165')) throw new Error('Primary action does not use the muted blue token')
if (!semantics.secondaryButtonColor.includes('63, 63, 70')) throw new Error('Secondary action is not neutral gray')
if (semantics.buttonLabelCenterDelta > 1) throw new Error('Button label is not geometrically centered')
if (semantics.buttonCount !== semantics.sharedButtonCount) throw new Error('A button bypasses the shared UI component')
if (semantics.buttonIconCount < semantics.sharedButtonCount) throw new Error('A shared button icon was not rendered')
if (semantics.overflowX) throw new Error('Page has unexpected horizontal overflow')
if (!semantics.primaryActions.includes('探测本机 Agent')) throw new Error('Discovery action is missing')
if (!semantics.bodyText.includes('正在导入原始记录')) throw new Error('Import progress state is missing')
for (const removedCopy of ['KNOWLEDGE SOURCES', '数据仅保存在本机', 'LOCAL KNOWLEDGE HUB']) {
  if (semantics.bodyText.includes(removedCopy)) throw new Error(`Redundant copy is still rendered: ${removedCopy}`)
}

console.log(`UI smoke test passed: ${capturePath}`)
