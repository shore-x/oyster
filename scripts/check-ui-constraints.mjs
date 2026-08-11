import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const rendererRoot = join(root, 'src', 'renderer', 'src')
const tokenPath = join(rendererRoot, 'ui', 'tokens.css')
const failures = []

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(path) : [path]
  })
}

function report(path, source, pattern, message) {
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index).split('\n').length
    failures.push(`${relative(root, path)}:${line} ${message}`)
  }
}

for (const path of filesBelow(rendererRoot)) {
  if (extname(path) !== '.css') continue
  const source = readFileSync(path, 'utf8')
  report(
    path,
    source,
    /calc\([^;\n]*(?:vh|dvh)[^;\n]*\)/gu,
    '业务布局不能通过 viewport 减去固定值计算高度；请填充 App Shell 提供的父容器。'
  )
  if (path !== tokenPath) {
    report(path, source, /font-size\s*:\s*\d+(?:\.\d+)?px/gu, '像素字号只能在 ui/tokens.css 中定义。')
    report(path, source, /font-weight\s*:\s*[1-9]00\b/gu, '数字字重只能在 ui/tokens.css 中定义。')
  }
}

const appPath = join(rendererRoot, 'App.tsx')
const appSource = readFileSync(appPath, 'utf8')
const pageId = appSource.match(/type PageId\s*=([^\n]+)/u)?.[1] ?? ''
for (const nestedPage of ['folder-browser', 'ai-backends', 'agent-configuration']) {
  if (pageId.includes(`'${nestedPage}'`)) {
    failures.push(`${relative(root, appPath)} 一级 PageId 不能包含详情工作面：${nestedPage}`)
  }
}

if (failures.length) {
  console.error(`UI 约束检查失败（${failures.length}）：\n${failures.map((failure) => `- ${failure}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log('UI 约束检查通过。')
}
