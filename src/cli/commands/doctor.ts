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

  // isolated-vm — only needed for `node` blocks (the QA pack does not use it)
  try {
    require('isolated-vm')
    ok('isolated-vm (node-block sandbox)')
  } catch {
    bad('isolated-vm not available — `node` blocks disabled', 'npm i isolated-vm  (not needed for the QA pack)')
  }

  // playwright + chromium — needed for the qa.browser.* blocks
  try {
    const pw = require('playwright') as { chromium: { executablePath(): string } }
    const exe = pw.chromium.executablePath()
    if (exe && fs.existsSync(exe)) ok('Playwright Chromium')
    else bad('Chromium not downloaded — qa.browser.* disabled', 'npx playwright install --with-deps chromium')
  } catch {
    bad('playwright not available — qa.browser.* disabled', 'npx playwright install --with-deps chromium')
  }

  console.log('\nQA pack (qa.api.*, qa.assert.*, qa.browser.*) is built in — no registration needed.')
}
