import fs from 'node:fs'
import path from 'node:path'
import { workspace } from '../workspace'

/** `aart doctor` — check that everything needed is in place, with fix hints. */
export async function doctorCommand(): Promise<void> {
  const ok = (label: string, detail = '') => console.log(`✓ ${label}${detail ? '  ' + detail : ''}`)
  const bad = (label: string, hint: string) => console.log(`✗ ${label}\n    → ${hint}`)

  const major = Number(process.versions.node.split('.')[0])
  if (major >= 20) ok(`Node ${process.versions.node}`)
  else bad(`Node ${process.versions.node} (need ≥ 20)`, 'upgrade Node to 20 or newer')

  const ws = workspace()
  const hasReg = fs.existsSync(path.join(ws, '.aa', 'registry'))
  ok(`workspace ${ws}`, hasReg ? '' : '(no .aa yet — created on first use)')

  // isolated-vm — only needed for sandboxed `node` blocks (core pack doesn't use it)
  try {
    require('isolated-vm')
    ok('isolated-vm (node-block sandbox)')
  } catch {
    bad('isolated-vm not available — sandboxed `node` blocks disabled', 'npm i isolated-vm  (not needed for the core pack)')
  }

  // playwright + chromium — needed for the browser.* blocks
  try {
    const pw = require('playwright') as { chromium: { executablePath(): string } }
    const exe = pw.chromium.executablePath()
    if (exe && fs.existsSync(exe)) ok('Playwright Chromium')
    else bad('Chromium not downloaded — browser.* disabled', 'npx playwright install --with-deps chromium')
  } catch {
    bad('playwright not available — browser.* disabled', 'npx playwright install --with-deps chromium')
  }

  console.log('\nCore pack (browser.*, http.request, assert.*) is built in — no registration needed. Legacy qa.* ids still resolve.')
}
