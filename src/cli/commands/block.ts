import fs from 'node:fs'
import YAML from 'yaml'
import { validateDraft } from '../../agent/validate'
import { buildCatalog } from '../../agent/catalog'
import { openRuntime } from '../workspace'

/** `aart block add <file>` — validate then register a definition (the gate). */
export async function addCommand(file: string): Promise<void> {
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`)
    process.exit(1)
  }
  const runtime = openRuntime()
  const result = validateDraft(YAML.parse(fs.readFileSync(file, 'utf8')), runtime.registry)
  if (!result.ok || !result.block) {
    console.error('✗ refused — definition is invalid:')
    for (const e of result.errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  // Registration always lands as draft — only `aart approve` grants approval.
  result.block.approval = 'draft'
  try {
    runtime.registry.registerBlock(result.block)
  } catch (err) {
    console.error(`✗ refused — ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  const kind = result.block.execution.type === 'workflow' ? 'workflow' : 'block'
  console.log(`registered ${kind} ${result.block.id}@${result.block.version} (${result.block.name}) [draft]`)
  console.log(`approve it with:  aart approve ${result.block.id}`)
}

interface ListOpts {
  json?: boolean
}

/** `aart block list` / `aart list` — human table, or `--json` machine catalog. */
export async function listCommand(opts: ListOpts = {}): Promise<void> {
  const catalog = buildCatalog(openRuntime().registry)
  if (opts.json) {
    console.log(JSON.stringify(catalog, null, 2))
    return
  }
  if (!catalog.length) {
    console.log('no blocks registered yet — try:  aart block add <file>')
    return
  }
  for (const b of catalog) {
    const tag = b.status === 'native' ? '[native]' : `[${b.type} · ${b.status}]`
    console.log(`${b.id}@${b.version}\t${tag}\t${b.name}`)
  }
}
