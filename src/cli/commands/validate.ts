import fs from 'node:fs'
import YAML from 'yaml'
import { validateDraft } from '../../agent/validate'
import { openRuntime } from '../workspace'

/** `aart validate <file>` — validate an agent-authored draft before registering. */
export async function validateCommand(file: string): Promise<void> {
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`)
    process.exit(1)
  }
  let parsed: unknown
  try {
    parsed = YAML.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    console.error(`Not valid YAML/JSON: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const result = validateDraft(parsed, openRuntime().registry)
  if (result.ok && result.block) {
    const kind = result.block.execution.type === 'workflow' ? 'workflow' : 'block'
    console.log(`✓ valid ${kind}: ${result.block.id}@${result.block.version}`)
    return
  }
  console.error(`✗ invalid:`)
  for (const e of result.errors) console.error(`  - ${e}`)
  process.exit(1)
}
