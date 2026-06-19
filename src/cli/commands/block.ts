import fs from 'node:fs'
import YAML from 'yaml'
import { validateDraft } from '../../agent/validate'
import { buildCatalog, filterCatalog } from '../../agent/catalog'
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
  for (const w of result.warnings) console.warn(`  ⚠ ${w}`)
  const kind = result.block.execution.type === 'workflow' ? 'workflow' : 'block'
  console.log(`registered ${kind} ${result.block.id}@${result.block.version} (${result.block.name}) [draft]`)
  console.log(`approve it with:  aart approve ${result.block.id}`)
}

interface ListOpts {
  json?: boolean
  category?: string
  search?: string
}

/** `aart block list` / `aart list` — readable table, or `--json` machine catalog. */
export async function listCommand(opts: ListOpts = {}): Promise<void> {
  const allEntries = buildCatalog(openRuntime().registry)
  const catalog =
    opts.category || opts.search
      ? filterCatalog(allEntries, { category: opts.category, query: opts.search })
      : allEntries

  if (opts.json) {
    console.log(JSON.stringify(catalog, null, 2))
    return
  }
  if (!catalog.length) {
    console.log('no blocks registered yet — try:  aart block add <file>')
    return
  }

  // Group by category; blocks with no category go under "(uncategorized)".
  const groups = new Map<string, typeof catalog>()
  for (const b of catalog) {
    const key = b.category ?? '(uncategorized)'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(b)
  }

  for (const [cat, entries] of groups) {
    console.log(`\n${cat}`)
    for (const b of entries) {
      const tag = b.status === 'native' ? '[native]' : `[${b.type} · ${b.status}]`
      console.log(`  ${b.id}@${b.version}\t${tag}\t${b.name}`)
    }
  }
}
