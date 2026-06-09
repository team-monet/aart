import fs from 'node:fs'
import YAML from 'yaml'
import { validateDraft } from '../../agent/validate'
import { buildCatalog } from '../../agent/catalog'
import { openRegistry } from '../workspace'

/** `aart block add <file>` — validate then register a definition (the gate). */
export async function addCommand(file: string): Promise<void> {
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`)
    process.exit(1)
  }
  const registry = openRegistry()
  const result = validateDraft(YAML.parse(fs.readFileSync(file, 'utf8')), registry)
  if (!result.ok || !result.block) {
    console.error('✗ refused — definition is invalid:')
    for (const e of result.errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  registry.registerBlock(result.block)
  const kind = result.block.execution.type === 'workflow' ? 'workflow' : 'block'
  console.log(`registered ${kind} ${result.block.id}@${result.block.version} (${result.block.name})`)
}

interface ListOpts {
  json?: boolean
}

/** `aart block list` / `aart list` — human table, or `--json` machine catalog. */
export async function listCommand(opts: ListOpts = {}): Promise<void> {
  const catalog = buildCatalog(openRegistry())
  if (opts.json) {
    console.log(JSON.stringify(catalog, null, 2))
    return
  }
  if (!catalog.length) {
    console.log('no blocks registered yet — try:  aart block add <file>')
    return
  }
  for (const b of catalog) {
    console.log(`${b.id}@${b.version}\t[${b.type}]\t${b.name}`)
  }
}
